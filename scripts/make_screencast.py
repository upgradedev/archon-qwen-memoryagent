#!/usr/bin/env python3
"""Render a CAPTURED live run as a 1920x1080 terminal screencast (silent).

The Archon MemoryAgent demo is the agent's memory working ACROSS SESSIONS against
the LIVE Alibaba Cloud deployment. CI first runs scripts/capture_live.sh, which
drives the real box (https://memory.43.106.13.19.sslip.io): GET /health, then Session A
POST /ingest, then a FRESH Session B POST /recall — and writes the REAL captured
output (real qwen-plus answers, real pgvector cosine scores) to
docs/screencast_transcript.txt with a per-line appearance time. This script draws
a terminal "typewriter" where lines stream in on that timeline, the view scrolls
like a real shell, and the final frame is held to TARGET_SECONDS so the downstream
compose math (title + screencast + outro) is exact.

Technique: render ONE PNG per content change, then assemble with the ffmpeg concat
demuxer using per-image durations, re-encoded to CONSTANT framerate (-fps_mode cfr
-r 30) so the burned-caption enable=between(t,...) timestamps in the compose step
land frame-accurate.

Env / args (all optional):
  TARGET_SECONDS   total screencast length; final frame is held to this (default 150)
  OUTPUT           repo-contained output mp4 path (default screencast.mp4)
  TRANSCRIPT       repo-contained transcript path (default docs/screencast_transcript.txt)
  FPS              output framerate (default 30)
  FONT_MONO        terminal monospace .ttf
  FONT_MONO_BOLD   terminal monospace bold .ttf
  FFMPEG / FFPROBE ffmpeg / ffprobe binaries

Usage:
  python scripts/make_screencast.py
  TARGET_SECONDS=20 python scripts/make_screencast.py   # quick local proof
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import atexit
import shutil

from PIL import Image, ImageDraw, ImageFont
from repo_paths import REPO_ROOT, inside_repo

# --------------------------------------------------------------------------- #
# Canvas / layout
# --------------------------------------------------------------------------- #
W, H = 1920, 1080
BG = (13, 17, 23)            # terminal background (GitHub-dark)
TITLEBAR_BG = (22, 27, 34)
TITLEBAR_H = 64
PAD_X = 56
PAD_TOP = TITLEBAR_H + 28
# Reserve a bottom safe-area: the compose step burns captions at y=h-140 with a
# box, so keep terminal text well clear of the lowest ~210px or captions cover it.
BOTTOM_SAFE = 210
FONT_SIZE = 26
LINE_H = 38

# Colours by line kind.
COL_DEFAULT = (201, 209, 217)
COL_PROMPT = (126, 231, 135)
COL_RULE = (88, 96, 105)
COL_HEADER = (52, 211, 153)     # emerald
COL_OK = (126, 231, 135)        # green ticks
COL_FAIL = (248, 113, 113)      # red crosses
COL_ARROW = (121, 192, 255)     # blue "->" annotation lines
COL_DIM = (139, 148, 158)

# "<secs> text"  OR a lone "<secs>" (a timed blank spacer line).
TIME_RE = re.compile(r"^(\d+(?:\.\d+)?)(?: (.*))?$")


def _find_font(env_key: str, candidates: list[str]) -> str:
    p = os.environ.get(env_key)
    if p and os.path.exists(p):
        return p
    for c in candidates:
        if os.path.exists(c):
            return c
    raise SystemExit(f"No font found for {env_key}; tried {candidates}")


def load_fonts():
    mono = _find_font("FONT_MONO", [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",   # CI (fonts-dejavu-core)
        "C:/Windows/Fonts/consola.ttf",                          # local Windows
        "/System/Library/Fonts/Menlo.ttc",
    ])
    mono_bold = _find_font("FONT_MONO_BOLD", [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "C:/Windows/Fonts/consolab.ttf",
        mono,  # fall back to regular if no bold face exists
    ])
    return (ImageFont.truetype(mono, FONT_SIZE),
            ImageFont.truetype(mono_bold, FONT_SIZE))


def parse_transcript(path: str):
    """Return list of (time, text). Untimed lines inherit prev_time + 0.4s."""
    events = []
    last_t = 0.0
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n").rstrip("\r")
            m = TIME_RE.match(line)
            if m:
                t = float(m.group(1))
                text = m.group(2) if m.group(2) is not None else ""
            else:
                t = last_t + 0.4
                text = line
            last_t = t
            events.append((t, text))
    events.sort(key=lambda e: e[0])
    return events


def line_colour(text: str):
    t = text.strip()
    if t.startswith("$"):
        return COL_PROMPT, True
    if t and set(t) <= {"=", "-"}:          # a rule line (==== or ----)
        return COL_RULE, False
    if t.startswith("ANSWER") or t.startswith("Recalled"):
        return COL_HEADER, True
    if t.startswith(">>") or t.startswith("✓"):   # success / proof line
        return COL_OK, True
    if t.startswith("✗"):                         # failure
        return COL_FAIL, True
    if t.startswith("→") or t.startswith("->"):   # annotation
        return COL_ARROW, False
    return COL_DEFAULT, False


def wrap(text: str, font, max_px: int) -> list[str]:
    """Greedy word-wrap preserving leading indent."""
    if text == "":
        return [""]
    indent = len(text) - len(text.lstrip(" "))
    prefix = " " * indent
    words = text.strip().split(" ")
    lines, cur = [], prefix
    for w in words:
        trial = (cur + (" " if cur.strip() else "") + w) if cur.strip() else (prefix + w)
        if font.getlength(trial) <= max_px or not cur.strip():
            cur = trial
        else:
            lines.append(cur)
            cur = prefix + w
    lines.append(cur)
    return lines


def main() -> int:
    output = inside_repo(os.environ.get("OUTPUT", "screencast.mp4"), "OUTPUT")
    transcript = inside_repo(
        os.environ.get("TRANSCRIPT", "docs/screencast_transcript.txt"),
        "TRANSCRIPT",
        must_exist=True,
    )
    os.makedirs(os.path.dirname(output), exist_ok=True)
    target = float(os.environ.get("TARGET_SECONDS", "150"))
    fps = int(os.environ.get("FPS", "30"))
    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")

    font, font_bold = load_fonts()
    events = parse_transcript(transcript)
    if not events:
        raise SystemExit(f"Empty transcript: {transcript}")

    max_px = W - 2 * PAD_X
    body_h = H - PAD_TOP - BOTTOM_SAFE
    max_rows = body_h // LINE_H

    # Pre-wrap every logical line into visual rows, keeping its appearance time.
    rows = []
    for t, text in events:
        col, bold = line_colour(text)
        fnt = font_bold if bold else font
        for vis in wrap(text, fnt, max_px):
            rows.append((t, vis, fnt, col))

    def render(n_visible: int) -> Image.Image:
        """Frame showing the last `max_rows` of the first n_visible rows."""
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, TITLEBAR_H], fill=TITLEBAR_BG)
        for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            cx = 36 + i * 34
            d.ellipse([cx, 24, cx + 16, 40], fill=c)
        d.text((150, 18), "Archon MemoryAgent  -  Qwen x Alibaba Cloud  (live)", font=font, fill=COL_DIM)
        shown = rows[:n_visible][-max_rows:]
        y = PAD_TOP
        for _t, text, fnt, col in shown:
            if text:
                d.text((PAD_X, y), text, font=fnt, fill=col)
            y += LINE_H
        if shown:
            last_text = shown[-1][1]
            cx = PAD_X + int(font.getlength(last_text)) + 6
            cy = PAD_TOP + (len(shown) - 1) * LINE_H
            d.rectangle([cx, cy + 4, cx + 14, cy + FONT_SIZE + 4], fill=COL_PROMPT)
        return img

    times = [r[0] for r in rows]
    # Keep every intermediate inside the project so parallel agents can find the
    # same workspace and no persistent artifact is lost in OS temp. The directory
    # is ignored and removed on both normal and exceptional interpreter exit.
    work_root = os.path.join(str(REPO_ROOT), ".artifacts", "work", "screencast")
    os.makedirs(work_root, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="run_", dir=work_root)
    cleanup_tmp = lambda: shutil.rmtree(tmpdir, ignore_errors=True)
    atexit.register(cleanup_tmp)
    concat_path = os.path.join(tmpdir, "concat.txt")

    keyframes = [(0.0, 0)]
    for i, t in enumerate(times, start=1):
        if t <= 0:
            keyframes[-1] = (0.0, i)
        else:
            keyframes.append((t, i))
    merged = {}
    for st, nv in keyframes:
        merged[round(st, 3)] = nv
    keyframes = sorted(merged.items())

    print(f"[screencast] rows={len(rows)} keyframes={len(keyframes)} "
          f"target={target}s fps={fps} body_rows={max_rows}")

    pngs = []
    with open(concat_path, "w", encoding="utf-8") as cf:
        for idx, (st, nv) in enumerate(keyframes):
            img = render(nv)
            png = os.path.join(tmpdir, f"f{idx:04d}.png")
            img.save(png)
            pngs.append(png)
            nxt = keyframes[idx + 1][0] if idx + 1 < len(keyframes) else target
            dur = max(0.05, nxt - st)
            cf.write(f"file '{png}'\n")
            cf.write(f"duration {dur:.3f}\n")
        cf.write(f"file '{pngs[-1]}'\n")

    cmd = [
        ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", concat_path,
        "-vf", "scale=1920:1080,setsar=1,format=yuv420p",
        "-fps_mode", "cfr", "-r", str(fps),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        output,
    ]
    print("[screencast] " + " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        cleanup_tmp()
        return r.returncode

    try:
        dur = subprocess.check_output([
            os.environ.get("FFPROBE", "ffprobe"), "-v", "error",
            "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", output,
        ]).decode().strip()
        print(f"[screencast] wrote {output} duration={dur}s (target {target}s)")
    except Exception as e:
        print(f"[screencast] wrote {output} (ffprobe check skipped: {e})")
    cleanup_tmp()
    return 0


if __name__ == "__main__":
    sys.exit(main())
