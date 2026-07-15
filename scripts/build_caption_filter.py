#!/usr/bin/env python3
"""Build the burned-caption drawtext chain, scaled to the MEASURED narration length.

Why this exists (defect 2 — A/V/caption drift):
  scripts/captions.txt carries FIXED screencast-local timestamps that were hand-tuned
  to one narration render. ElevenLabs (and edge-tts) pace the same script differently
  run-to-run (PR #35 saw 157.7s vs 162.9s — a ~5s swing). Fixed windows therefore drift
  against the spoken audio: on a slow run the closing caption clips; on a fast run the
  captions run past the voice, leaving a silent tail. Linearly scaling every window to
  the measured main-audio duration (A_MAIN) locks the caption track to the voice the
  demo actually ships with, so it cannot drift with pacing.

What it does:
  * reads scripts/captions.txt  (lines: START|END|TEXT, times in screencast-local secs)
  * scales all times by K = target_span / cap_end, where
        target_span = min(A_MAIN, S_EFF - LEAD)   # end at the voice, never past the clip
  * writes one caps/cap_<i>.txt per caption (no shell escaping of the text)
  * prints the drawtext filter chain (comma-prefixed) on stdout for the compose step
  * writes caption_windows.json = [[abs_start, abs_end, text], ...] in ABSOLUTE video
    time (screencast-local + TITLE_DUR) for the sync gate.

Env:
  CAPTIONS_FILE (default scripts/captions.txt)
  A_MAIN        main-narration audio seconds (required)
  S_EFF         effective/trimmed screencast seconds (required)
  TITLE_DUR     leading title-card seconds (default 3.0)
  LEAD          gap kept between last caption end and screencast end (default 0.3)
  FONT          drawtext fontfile
  CAPS_DIR      repo-contained output dir for cap_<i>.txt (default caps)
  CAPTION_WINDOWS_JSON  repo-contained output path (default caption_windows.json)
  CAPTION_FILTER_FILE   repo-contained optional filter-chain output path
"""
import json
import os
import sys

from repo_paths import inside_repo


def _f(name: str) -> float:
    v = os.environ.get(name)
    if v is None or v == "":
        sys.exit(f"build_caption_filter: required env {name} is not set")
    return float(v)


def main() -> int:
    captions_file = inside_repo(
        os.environ.get("CAPTIONS_FILE", "scripts/captions.txt"),
        "CAPTIONS_FILE",
        must_exist=True,
    )
    a_main = _f("A_MAIN")
    s_eff = _f("S_EFF")
    title_dur = float(os.environ.get("TITLE_DUR", "3.0"))
    lead = float(os.environ.get("LEAD", "0.3"))
    font = os.environ.get("FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
    caps_dir = inside_repo(os.environ.get("CAPS_DIR", "caps"), "CAPS_DIR")
    windows_json = inside_repo(
        os.environ.get("CAPTION_WINDOWS_JSON", "caption_windows.json"),
        "CAPTION_WINDOWS_JSON",
    )
    filter_file_raw = os.environ.get("CAPTION_FILTER_FILE")
    filter_file = inside_repo(filter_file_raw, "CAPTION_FILTER_FILE") if filter_file_raw else None

    rows = []
    with open(captions_file, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n").rstrip("\r")
            if not line.strip():
                continue
            parts = line.split("|", 2)
            if len(parts) < 3:
                continue
            s = float(parts[0])
            e = float(parts[1])
            text = parts[2]
            rows.append((s, e, text))

    if not rows:
        sys.exit(f"build_caption_filter: no captions parsed from {captions_file}")

    cap_end = max(e for _, e, _ in rows)
    if cap_end <= 0:
        sys.exit("build_caption_filter: caption track has non-positive length")

    # End the caption track at the voice (A_MAIN) but never past the trimmed screencast.
    target_span = min(a_main, s_eff - lead)
    if target_span <= 0:
        sys.exit(
            f"build_caption_filter: target_span {target_span:.3f}s <= 0 "
            f"(A_MAIN={a_main}, S_EFF={s_eff}, LEAD={lead})"
        )
    k = target_span / cap_end

    os.makedirs(caps_dir, exist_ok=True)
    os.makedirs(os.path.dirname(windows_json), exist_ok=True)
    pieces = []
    windows = []
    prev_e = 0.0
    for i, (s, e, text) in enumerate(rows):
        s2 = round(s * k, 3)
        e2 = round(e * k, 3)
        # keep monotonic + non-overlapping under float rounding
        if s2 < prev_e:
            s2 = prev_e
        if e2 <= s2:
            e2 = round(s2 + 0.001, 3)
        prev_e = e2
        cap_path = os.path.join(caps_dir, f"cap_{i}.txt")
        with open(cap_path, "w", encoding="utf-8") as cf:
            cf.write(text)
        pieces.append(
            f",drawtext=fontfile={font}:textfile={cap_path}:expansion=none:"
            f"fontsize=40:fontcolor=white:line_spacing=8:box=1:boxcolor=black@0.55:"
            f"boxborderw=18:x=(w-text_w)/2:y=h-140:enable='between(t,{s2},{e2})'"
        )
        windows.append([round(s2 + title_dur, 3), round(e2 + title_dur, 3), text])

    chain = "".join(pieces)
    with open(windows_json, "w", encoding="utf-8") as wf:
        json.dump(windows, wf, ensure_ascii=False, indent=2)

    if filter_file:
        os.makedirs(os.path.dirname(filter_file), exist_ok=True)
        with open(filter_file, "w", encoding="utf-8") as ff:
            ff.write(chain)

    sys.stderr.write(
        f"build_caption_filter: {len(rows)} captions · cap_end={cap_end}s · "
        f"A_MAIN={a_main}s · S_EFF={s_eff}s · target_span={target_span:.3f}s · "
        f"K={k:.4f} · last caption ends abs {windows[-1][1]}s\n"
    )
    sys.stdout.write(chain)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
