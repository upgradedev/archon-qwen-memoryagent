#!/usr/bin/env python3
"""Capture the final, sanitized MemoryAgent submission media from one verified release.

This is deliberately a release gate, not a best-effort screenshot helper.  It
requires exact-deployment evidence, validates the public and authenticated live
paths, drives the real Explorer, keeps raw material under the ignored
``demo/private-originals`` directory, and only then writes reviewed composites to
``demo/gallery``.

The reviewer credential is accepted only through ``DEMO_JUDGE_API_KEY``.  It is
never accepted on the command line, printed, serialized, included in a screenshot,
or placed in a tracked file.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Sequence
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from repo_paths import REPO_ROOT, inside_repo


REPO = Path(REPO_ROOT)
PRIVATE = REPO / "demo" / "private-originals"
GALLERY = REPO / "demo" / "gallery"
FINAL_MEDIA = REPO / "demo" / "final-media"
PROOF_FRAMES = FINAL_MEDIA / "proof-frames"
ARCHITECTURE = FINAL_MEDIA / "judge-architecture.jpg"

DEFAULT_BASE_URL = "https://memory.43.106.13.19.sslip.io"
DEFAULT_REPO_URL = "https://github.com/upgradedev/archon-qwen-memoryagent"
EXPECTED_EMBEDDER = "text-embedding-v4"
EXPECTED_NARRATOR = "qwen-plus"
EXPECTED_DIMENSION = 1024
CANVAS = (1920, 1080)
GALLERY_CANVAS = (1500, 1000)

PRIMARY_OUTPUTS = (
    "01-grounded-cross-session-recall.png",
    "02-read-only-field-self-audit.png",
    "03-qwen-semantic-self-audit.png",
    "04-human-resolution-control.png",
    "05-safe-memory-lifecycle.png",
    "06-qwen-memoryagent-architecture.png",
)
SECONDARY_OUTPUTS = (
    "07-live-health-readiness.png",
    "08-alibaba-runtime-proof.png",
    "09-public-repository-license.png",
)

SAFE_POST_DEPLOY_PATHS = (
    re.compile(r"^(?:README\.md|SECURITY\.md|deploy/DEPLOY_STATE\.md)$"),
    re.compile(r"^(?:demo|docs)/"),
    re.compile(r"^\.github/workflows/demo-video\.yml$"),
    re.compile(r"^scripts/(?:capture_live\.sh|captions\.txt|capture_submission_gallery\.py)$"),
)

SENSITIVE_KEY = re.compile(
    r"(?:authorization|api[-_]?key|access[-_]?key|secret|password|token|cookie)",
    re.IGNORECASE,
)
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+\-/=]{8,}", re.IGNORECASE)
PRIVATE_IPV4 = re.compile(
    r"\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b"
)


class GateError(RuntimeError):
    """A fail-closed release/media validation error."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def project_path(value: str | Path, label: str, *, must_exist: bool = False) -> Path:
    return Path(inside_repo(value, label, must_exist=must_exist))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO), *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
    )
    if check and result.returncode != 0:
        # Never echo arbitrary git stderr: credential helpers and remote URLs do
        # not belong in a public media-build log.
        raise GateError(f"git {' '.join(args[:2])} failed (exit {result.returncode})")
    return result.stdout.strip()


def allowed_post_deploy_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return any(pattern.fullmatch(normalized) or pattern.match(normalized) for pattern in SAFE_POST_DEPLOY_PATHS)


def verify_exact_release(
    expected_sha: str,
    deployment_output: Path,
    deployment_status: Path,
) -> str:
    require(re.fullmatch(r"[0-9a-f]{40}", expected_sha) is not None, "expected SHA must be 40 lowercase hex characters")
    commit_check = subprocess.run(
        ["git", "-C", str(REPO), "cat-file", "-e", f"{expected_sha}^{{commit}}"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    require(commit_check.returncode == 0, "expected SHA is not present in this repository")

    status = load_json(deployment_status, "deployment status")
    require(isinstance(status, dict), "deployment status must be a JSON object")
    require(status.get("memorySha") == expected_sha, "deployment status records a different MemoryAgent SHA")
    require(status.get("status") == "Success", "deployment status is not Success")
    require(status.get("terminal") is True and status.get("exitCode") == 0, "deployment invocation is not a successful terminal run")
    require(status.get("outputCaptured") is True and status.get("projectContained") is True, "deployment evidence is incomplete or not project-contained")

    output = deployment_output.read_text(encoding="utf-8", errors="replace")
    escaped = re.escape(expected_sha)
    require(
        re.search(rf"^EXACT_CHECKOUT_OK app=memoryagent sha={escaped}$", output, re.MULTILINE) is not None,
        "deployment output has no exact MemoryAgent checkout marker",
    )
    require(
        re.search(rf"^EXACT_APP_(?:DEPLOY|REUSE)_OK app=memoryagent sha={escaped}(?:\s|$)", output, re.MULTILINE) is not None,
        "deployment output has no successful exact MemoryAgent deployment marker",
    )
    require(
        re.search(rf"^EXACT_DEPLOY_SUCCESS memory={escaped}\s", output, re.MULTILINE) is not None,
        "deployment output has no final exact-deploy success marker",
    )

    compose = git("show", f"{expected_sha}:docker-compose.yml")
    require("127.0.0.1:${BACKEND_PORT:-9000}:9000" in compose, "exact source no longer binds the backend to loopback")
    require("pgvector/pgvector:" in compose, "exact source no longer declares the self-hosted pgvector service")

    # Refresh only the remote-tracking commit metadata.  No checkout, reset, merge,
    # or source mutation is performed.
    git("fetch", "--quiet", "origin", "main")
    remote_main = git("rev-parse", "origin/main")
    require(re.fullmatch(r"[0-9a-f]{40}", remote_main) is not None, "origin/main did not resolve to a commit")
    ancestor = subprocess.run(
        ["git", "-C", str(REPO), "merge-base", "--is-ancestor", expected_sha, remote_main],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    require(ancestor.returncode == 0, "exact-deployed SHA is not an ancestor of origin/main")

    changed = [line for line in git("diff", "--name-only", f"{expected_sha}..{remote_main}").splitlines() if line]
    unsafe = [path for path in changed if not allowed_post_deploy_path(path)]
    require(not unsafe, "origin/main contains a post-deploy runtime-affecting path; redeploy before capture")
    return remote_main


def load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{label} is not valid UTF-8 JSON") from exc


def reviewer_token_from_args(args: argparse.Namespace) -> str:
    env_token = os.environ.get("DEMO_JUDGE_API_KEY", "")
    credential_arg = getattr(args, "reviewer_credential_json", None)
    require(not (env_token and credential_arg), "choose either DEMO_JUDGE_API_KEY or --reviewer-credential-json, never both")
    if credential_arg:
        credential_path = project_path(credential_arg, "reviewer credential JSON", must_exist=True)
        relative = str(credential_path.relative_to(REPO)).replace("\\", "/")
        tracked = subprocess.run(
            ["git", "-C", str(REPO), "ls-files", "--error-unmatch", "--", relative],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        require(tracked.returncode != 0, "reviewer credential JSON must never be tracked")
        ignored = subprocess.run(
            ["git", "-C", str(REPO), "check-ignore", "--quiet", "--", relative],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        require(ignored.returncode == 0, "reviewer credential JSON must be under an ignored project path")
        payload = load_json(credential_path, "reviewer credential JSON")
        require(isinstance(payload, dict), "reviewer credential JSON must be an object")
        token = payload.get("token")
        require(isinstance(token, str), "reviewer credential JSON has no string token field")
    else:
        token = env_token
    require(len(token) >= 32 and not token.isspace(), "a private 32+ character reviewer credential is required")
    return token


def scrub_json(value: Any) -> Any:
    """Remove secret-shaped keys before retaining ignored raw responses."""
    if isinstance(value, dict):
        return {
            str(key): ("[REMOVED]" if SENSITIVE_KEY.search(str(key)) else scrub_json(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [scrub_json(item) for item in value]
    if isinstance(value, str):
        return BEARER.sub("Bearer [REMOVED]", value)
    return value


def write_private_json(name: str, value: Any) -> None:
    path = PRIVATE / name
    path.write_text(json.dumps(scrub_json(value), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def request_json(
    method: str,
    base_url: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    reviewer_token: str | None = None,
    timeout: float = 90.0,
) -> tuple[Any, dict[str, str]]:
    url = base_url.rstrip("/") + path
    data = json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json", "User-Agent": "Archon-MemoryAgent-Media-Gate/1.0"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if reviewer_token:
        headers["Authorization"] = f"Bearer {reviewer_token}"
    req = urlrequest.Request(url, data=data, headers=headers, method=method)
    try:
        with urlrequest.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            status = response.status
            response_headers = {key.lower(): value for key, value in response.headers.items()}
    except urlerror.HTTPError as exc:
        # The body can contain operational details.  Report only path + status.
        raise GateError(f"{method} {path} returned HTTP {exc.code}") from exc
    except (urlerror.URLError, TimeoutError, OSError) as exc:
        raise GateError(f"{method} {path} was unreachable") from exc
    require(status == 200, f"{method} {path} returned HTTP {status}")
    try:
        return json.loads(raw.decode("utf-8")), response_headers
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{method} {path} did not return JSON") from exc


def model_is_real(value: Any) -> bool:
    return isinstance(value, str) and value != "" and not value.lower().startswith("fake-")


def validate_ready(ready: Any) -> None:
    require(isinstance(ready, dict) and ready.get("status") == "ready", "/ready is not ready")
    checks = ready.get("checks")
    require(isinstance(checks, dict), "/ready omitted checks")

    def positive(name_pattern: str) -> bool:
        for key, value in checks.items():
            if re.search(name_pattern, str(key), re.IGNORECASE):
                if isinstance(value, dict):
                    return value.get("ok") is True or value.get("configured") is True
                return str(value).lower() in {"ok", "ready", "configured", "configured-not-probed", "operational"}
        return False

    require(positive(r"database"), "/ready database check is not positive")
    require(positive(r"qwen|embedder"), "/ready Qwen check is not positive")
    require(positive(r"auth"), "/ready reviewer-auth check is not positive")


def public_release_probes(base_url: str, reviewer_token: str) -> dict[str, Any]:
    health, _ = request_json("GET", base_url, "/health")
    require(isinstance(health, dict) and health.get("status") == "ok", "/health is not ok")
    require(health.get("embedder") == EXPECTED_EMBEDDER, "/health reports the wrong embedding model")
    require(health.get("narrator") == EXPECTED_NARRATOR, "/health reports the wrong narrator model")
    require(model_is_real(health.get("judge")), "/health reports a Fake or missing semantic judge")
    require(health.get("embedDim") == EXPECTED_DIMENSION, "/health reports the wrong embedding dimension")

    ready, _ = request_json("GET", base_url, "/ready")
    validate_ready(ready)

    deep, _ = request_json("GET", base_url, "/ready/deep", reviewer_token=reviewer_token, timeout=120)
    require(isinstance(deep, dict), "/ready/deep returned the wrong shape")
    deep_checks = deep.get("checks")
    require(isinstance(deep_checks, dict), "/ready/deep omitted checks")
    require(
        isinstance(deep_checks.get("embedder"), dict) and deep_checks["embedder"].get("status") == "operational",
        "/ready/deep did not prove the real embedder operational",
    )
    require(
        isinstance(deep_checks.get("narrator"), dict) and deep_checks["narrator"].get("grounding") == "passed",
        "/ready/deep did not prove grounded narration",
    )

    openapi, _ = request_json("GET", base_url, "/openapi.json")
    paths = openapi.get("paths") if isinstance(openapi, dict) else None
    required_paths = {
        "/ready", "/ready/deep", "/ingest/invoice", "/feedback", "/consistency/semantic",
        "/resolve-conflict", "/consolidate", "/forget",
    }
    require(isinstance(paths, dict) and required_paths.issubset(paths), "/openapi.json is missing final hardened routes")

    request_json("POST", base_url, "/demo/seed", body={})
    seeded, _ = request_json("POST", base_url, "/demo/seed", body={})
    require(isinstance(seeded, dict) and seeded.get("alreadySeeded") is True, "public seed is not idempotent")
    require(seeded.get("reconciled") is False and seeded.get("events") == 0, "public seed required unexpected reconciliation")

    pnl_path = "/pnl?" + urlparse.urlencode({"company": "Northwind Trading"})
    pnl, _ = request_json("GET", base_url, pnl_path)
    require(isinstance(pnl, dict), "selected-company P&L returned the wrong shape")
    require(pnl.get("currency") == "EUR", "selected-company P&L is not one EUR bucket")
    require(pnl.get("unknown_currency_records") == 0, "selected-company P&L contains unknown currencies")
    require(pnl.get("employer_cost_total") == 14600, "selected-company P&L employer cost is not 14,600")
    require(pnl.get("revenue_total") == 42700 and pnl.get("net_profit") == 28100, "selected-company P&L totals are stale")

    for name, value in {
        "health.json": health,
        "ready.json": ready,
        "ready-deep.json": deep,
        "seed-idempotent.json": seeded,
        "northwind-pnl.json": pnl,
    }.items():
        write_private_json(name, value)
    return {"health": health, "ready": ready, "deep": deep, "pnl": pnl}


def font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"), Path("C:/Windows/Fonts/segoeuib.ttf"), Path("C:/Windows/Fonts/arialbd.ttf"))
        if bold
        else (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), Path("C:/Windows/Fonts/segoeui.ttf"), Path("C:/Windows/Fonts/arial.ttf"))
    )
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def strip_and_save(
    image: Image.Image,
    output: Path,
    *,
    size: tuple[int, int] | None = None,
    min_bytes: int = 20_000,
) -> None:
    clean = image.convert("RGB")
    if size is not None:
        clean = ImageOps.fit(clean, size, method=Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    clean.save(output, format="PNG", optimize=True)
    with Image.open(output) as check:
        require(check.size == (size or clean.size), f"{output.name} has the wrong dimensions")
        require(not check.info, f"{output.name} retained PNG metadata")
        require(output.stat().st_size >= min_bytes, f"{output.name} is unexpectedly small")


def save_dual_submission_frame(
    canvas: Image.Image,
    gallery_output: Path,
    *,
    proof_output: Path | None = None,
) -> None:
    """Write one 16:9 video frame and one no-crop 3:2 Devpost final.

    The 1920×1080 composition is the source of truth.  Devpost receives a
    1500×1000 canvas with that full frame centered and letterboxed, never a crop;
    therefore host, model, caveat and footer text stay inside both safe areas.
    """
    require(canvas.size == CANVAS, "submission source frame must be 1920×1080")
    PROOF_FRAMES.mkdir(parents=True, exist_ok=True)
    if proof_output is not None:
        video_output = proof_output
    elif gallery_output.resolve().is_relative_to(GALLERY.resolve()):
        video_output = PROOF_FRAMES / f"{gallery_output.stem}-16x9.png"
    else:
        video_output = gallery_output.with_name(f"{gallery_output.stem}-16x9.png")
    strip_and_save(canvas, video_output, size=CANVAS)

    devpost = Image.new("RGB", GALLERY_CANVAS, "#06110e")
    fitted = ImageOps.contain(canvas.convert("RGB"), GALLERY_CANVAS, method=Image.Resampling.LANCZOS)
    x = (GALLERY_CANVAS[0] - fitted.width) // 2
    y = (GALLERY_CANVAS[1] - fitted.height) // 2
    devpost.paste(fitted, (x, y))
    draw = ImageDraw.Draw(devpost)
    draw.rectangle((0, 0, GALLERY_CANVAS[0], 6), fill="#35d399")
    draw.rectangle((0, GALLERY_CANVAS[1] - 6, GALLERY_CANVAS[0], GALLERY_CANVAS[1]), fill="#183b30")
    strip_and_save(devpost, gallery_output, size=GALLERY_CANVAS)


def rounded(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], fill: str, *, radius: int = 24, outline: str | None = None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def wrap(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.ImageFont, max_width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and draw.textlength(candidate, font=face) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def fit_source(source: Image.Image, box: tuple[int, int, int, int], background: str = "#0a1412") -> Image.Image:
    width = box[2] - box[0]
    height = box[3] - box[1]
    panel = Image.new("RGB", (width, height), background)
    contained = ImageOps.contain(source.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
    panel.paste(contained, ((width - contained.width) // 2, (height - contained.height) // 2))
    return panel


def composite_live_capture(
    raw_path: Path,
    output: Path,
    *,
    eyebrow: str,
    title: str,
    subtitle: str,
    badges: Sequence[str],
    base_url: str,
    expected_sha: str,
    observed_at: str,
    accent: str = "#35d399",
    source_label: str = "Exact runtime",
    dual_submission: bool = True,
) -> None:
    source = Image.open(raw_path)
    canvas = Image.new("RGB", CANVAS, "#06110e")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, CANVAS[0], 10), fill=accent)
    draw.text((80, 54), eyebrow.upper(), font=font(24, bold=True), fill=accent)
    draw.text((80, 94), title, font=font(54, bold=True), fill="#f3fff9")
    for index, line in enumerate(wrap(draw, subtitle, font(27), 1740)[:2]):
        draw.text((82, 166 + index * 34), line, font=font(27), fill="#a8beb5")

    badge_x = 80
    for value in badges:
        face = font(22, bold=True)
        width = int(draw.textlength(value, font=face)) + 42
        rounded(draw, (badge_x, 244, badge_x + width, 292), "#10231d", radius=22, outline="#2c5747", width=2)
        draw.text((badge_x + 21, 254), value, font=face, fill="#d8f9ec")
        badge_x += width + 16

    rounded(draw, (70, 320, 1850, 975), "#0a1713", radius=28, outline="#23483b", width=2)
    panel = fit_source(source, (88, 338, 1832, 957), "#0b1513")
    canvas.paste(panel, (88, 338))
    draw.rectangle((0, 1000, 1920, 1080), fill="#091612")
    draw.text((80, 1018), f"LIVE HTTPS · {base_url}", font=font(22, bold=True), fill="#d3f6e8")
    draw.text((760, 1018), f"{source_label} {expected_sha[:12]} · observed {observed_at}", font=font(20), fill="#89a79b")
    if dual_submission:
        save_dual_submission_frame(canvas, output)
    else:
        strip_and_save(canvas, output, size=CANVAS)


def render_health_card(
    output: Path,
    probes: dict[str, Any],
    *,
    base_url: str,
    expected_sha: str,
    observed_at: str,
) -> None:
    health = probes["health"]
    deep = probes["deep"]
    canvas = Image.new("RGB", CANVAS, "#06110e")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 10), fill="#35d399")
    draw.text((80, 62), "INDEPENDENT LIVE PROBES", font=font(24, bold=True), fill="#35d399")
    draw.text((80, 108), "Qwen + pgvector are ready", font=font(58, bold=True), fill="#f2fff9")
    draw.text((82, 186), "Cheap readiness and an authenticated cached end-to-end model probe are shown separately.", font=font(27), fill="#9cb3aa")

    cards = [
        ("/health", "200 · status ok", [
            ("Embedding", str(health["embedder"])),
            ("Narration", str(health["narrator"])),
            ("Semantic judge", str(health["judge"])),
            ("Vector dimensions", str(health["embedDim"])),
        ]),
        ("/ready", "200 · status ready", [
            ("Database", "ready"),
            ("Qwen configuration", "ready"),
            ("Reviewer auth", "configured"),
            ("Spend", "zero model calls"),
        ]),
        ("/ready/deep", "200 · authenticated", [
            ("Embedder", str(deep["checks"]["embedder"]["status"])),
            ("Narrator grounding", str(deep["checks"]["narrator"]["grounding"])),
            ("Cache", "hit" if deep.get("cached") else "fresh bounded probe"),
            ("Credential", "never rendered or retained"),
        ]),
    ]
    for index, (heading, status, rows) in enumerate(cards):
        x0 = 70 + index * 610
        x1 = x0 + 575
        rounded(draw, (x0, 290, x1, 890), "#0b1b16", radius=30, outline="#235444", width=2)
        draw.text((x0 + 34, 326), heading, font=font(38, bold=True), fill="#f3fff9")
        draw.text((x0 + 34, 382), status, font=font(22, bold=True), fill="#35d399")
        y = 465
        for label, value in rows:
            draw.text((x0 + 34, y), label.upper(), font=font(18, bold=True), fill="#789489")
            for line in wrap(draw, value, font(27, bold=True), 500)[:2]:
                y += 32
                draw.text((x0 + 34, y), line, font=font(27, bold=True), fill="#dff9ef")
            y += 44
    draw.text((80, 948), f"{base_url} · exact-deploy evidence {expected_sha[:12]} · {observed_at}", font=font(23), fill="#9db3aa")
    save_dual_submission_frame(canvas, output)


def render_lifecycle_card(
    output: Path,
    preview: dict[str, Any],
    confirmed: dict[str, Any],
    *,
    base_url: str,
    expected_sha: str,
    observed_at: str,
) -> None:
    canvas = Image.new("RGB", CANVAS, "#07110f")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 10), fill="#6ee7b7")
    draw.text((80, 62), "AUTHENTICATED MEMORY LIFECYCLE", font=font(24, bold=True), fill="#6ee7b7")
    draw.text((80, 110), "Preview first. Confirm explicitly.", font=font(58, bold=True), fill="#f3fff9")
    draw.text((82, 190), "A tenant-scoped safe-default retention policy proves the control path without deleting active memory.", font=font(27), fill="#9db4ab")

    cards = [
        ("1", "PREVIEW", preview, "No state mutation"),
        ("2", "CONFIRMED", confirmed, "Audited safe no-op"),
    ]
    for index, (number, heading, payload, outcome) in enumerate(cards):
        x0 = 80 + index * 900
        x1 = x0 + 840
        rounded(draw, (x0, 300, x1, 850), "#0c1c17", radius=32, outline="#285c49", width=2)
        rounded(draw, (x0 + 38, 338, x0 + 98, 398), "#35d399", radius=30)
        draw.text((x0 + 59, 348), number, anchor="ma", font=font(28, bold=True), fill="#052016")
        draw.text((x0 + 128, 340), heading, font=font(34, bold=True), fill="#effff8")
        rows = [
            ("dryRun", str(payload.get("dryRun")).lower()),
            ("scanned in reviewer tenant", str(payload.get("scanned"))),
            ("candidates", str(payload.get("candidates"))),
            ("active memories deleted", str(payload.get("forgotten"))),
            ("audit persisted", str((payload.get("audit") or {}).get("persisted")).lower()),
        ]
        y = 445
        for label, value in rows:
            draw.text((x0 + 45, y), label, font=font(24), fill="#9ab2a8")
            draw.text((x1 - 45, y), value, anchor="ra", font=font(26, bold=True), fill="#dff8ee")
            y += 58
        draw.text((x0 + 45, 765), outcome, font=font(26, bold=True), fill="#6ee7b7")

    audit = confirmed.get("audit") or {}
    reason = str(audit.get("reason") or "")
    draw.text((80, 910), "Reason", font=font(19, bold=True), fill="#779388")
    draw.text((170, 906), reason, font=font(23), fill="#d5eee4")
    draw.text((80, 970), f"{base_url} · exact runtime {expected_sha[:12]} · {observed_at}", font=font(21), fill="#87a096")
    save_dual_submission_frame(canvas, output)


def sanitize_alibaba_capture(raw_input: Path, profile_path: Path) -> Image.Image:
    profile = load_json(profile_path, "Alibaba redaction profile")
    require(isinstance(profile, dict), "Alibaba redaction profile must be an object")
    expected_hash = str(profile.get("sourceSha256", "")).lower()
    require(re.fullmatch(r"[0-9a-f]{64}", expected_hash) is not None, "Alibaba profile has no reviewed source SHA-256")
    require(sha256_file(raw_input) == expected_hash, "Alibaba capture differs from the human-reviewed redaction profile")

    image = Image.open(raw_input).convert("RGB")
    dimensions = profile.get("sourceDimensions")
    require(dimensions == [image.width, image.height], "Alibaba capture dimensions differ from the reviewed profile")
    crop = profile.get("safeCrop")
    require(isinstance(crop, list) and len(crop) == 4 and all(isinstance(v, int) for v in crop), "Alibaba safeCrop is invalid")
    x0, y0, x1, y1 = crop
    require(0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height, "Alibaba safeCrop escapes the source image")

    required_labels = {"instance-id", "instance-name", "public-ip"}
    covered: set[str] = set()
    draw = ImageDraw.Draw(image)
    redactions = profile.get("redactions")
    require(isinstance(redactions, list), "Alibaba redactions must be a list")
    for item in redactions:
        require(isinstance(item, dict), "Alibaba redaction entry must be an object")
        label = str(item.get("label", ""))
        box = item.get("box")
        require(isinstance(box, list) and len(box) == 4 and all(isinstance(v, int) for v in box), "Alibaba redaction box is invalid")
        bx0, by0, bx1, by1 = box
        require(0 <= bx0 < bx1 <= image.width and 0 <= by0 < by1 <= image.height, "Alibaba redaction box escapes the source image")
        covered.add(label)
        draw.rounded_rectangle((bx0, by0, bx1, by1), radius=7, fill="#101b22", outline="#f97316", width=2)
        label_text = str(item.get("replacement", "REDACTED"))
        draw.text(((bx0 + bx1) // 2, (by0 + by1) // 2), label_text, anchor="mm", font=font(13, bold=True), fill="#ffffff")
    require(required_labels.issubset(covered), "Alibaba profile does not cover every required identifier class")

    sanitized = image.crop((x0, y0, x1, y1))
    intermediate = PRIVATE / "alibaba-ecs-overview-sanitized.png"
    strip_and_save(sanitized, intermediate)
    return sanitized


def render_alibaba_card(
    output: Path,
    sanitized_console: Image.Image,
    probes: dict[str, Any],
    *,
    base_url: str,
    expected_sha: str,
    observed_at: str,
) -> None:
    health = probes["health"]
    canvas = Image.new("RGB", CANVAS, "#0d1117")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 10), fill="#ff6a00")
    draw.text((80, 58), "SANITIZED ALIBABA CLOUD RUNTIME PROOF", font=font(24, bold=True), fill="#ff8a3d")
    draw.text((80, 104), "One active ECS runtime. Exact source. Real Qwen.", font=font(52, bold=True), fill="#f8fbff")
    draw.text((82, 177), "Account, instance, host-name and raw IP identifiers are deliberately removed; qualifying facts remain visible.", font=font(26), fill="#9eabb8")

    rounded(draw, (65, 270, 1245, 875), "#151b23", radius=28, outline="#394350", width=2)
    console_panel = fit_source(sanitized_console, (85, 290, 1225, 855), "#ffffff")
    canvas.paste(console_panel, (85, 290))

    rounded(draw, (1280, 270, 1855, 875), "#151b23", radius=28, outline="#5c3a25", width=2)
    draw.text((1320, 310), "VERIFIED RELEASE", font=font(22, bold=True), fill="#ff8a3d")
    facts = [
        ("Runtime source", expected_sha[:12]),
        ("Region", "Singapore"),
        ("Public path", "HTTPS reverse proxy"),
        ("Backend", "loopback-only container"),
        ("Memory store", "self-hosted PostgreSQL + pgvector"),
        ("Embedding", str(health["embedder"])),
        ("Narration / judge", f"{health['narrator']} / {health['judge']}"),
        ("Readiness", "database · Qwen · auth ready"),
    ]
    y = 375
    for label, value in facts:
        draw.text((1320, y), label.upper(), font=font(16, bold=True), fill="#7f8b98")
        y += 27
        for line in wrap(draw, value, font(24, bold=True), 485)[:2]:
            draw.text((1320, y), line, font=font(24, bold=True), fill="#eef3f8")
            y += 29
        y += 22
    draw.text((80, 938), f"Exact-deploy marker + live /health + /ready · {base_url} · {observed_at}", font=font(22), fill="#9aa8b5")
    save_dual_submission_frame(canvas, output)


def render_architecture_assets(output: Path) -> None:
    with Image.open(ARCHITECTURE) as source:
        video = ImageOps.fit(source.convert("RGB"), CANVAS, method=Image.Resampling.LANCZOS)
    save_dual_submission_frame(video, output)


def render_repository_card(
    raw_path: Path,
    output: Path,
    *,
    repo_url: str,
    remote_main: str,
    observed_at: str,
) -> None:
    composite_live_capture(
        raw_path,
        output,
        eyebrow="Reproducibility",
        title="Public source · MIT license · current main",
        subtitle="The repository landing page is paired with an unauthenticated GitHub API check for public visibility, default branch and license detection.",
        badges=("PUBLIC", "MIT", f"main {remote_main[:12]}"),
        base_url=repo_url,
        expected_sha=remote_main,
        observed_at=observed_at,
        accent="#58a6ff",
        source_label="Repository main",
    )


def browser_capture(
    base_url: str,
    repo_url: str,
    reviewer_token: str,
    expected_sha: str,
    observed_at: str,
    probes: dict[str, Any],
) -> dict[str, Any]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise GateError("Playwright is required; install the hash-locked requirements/video-demo.lock environment") from exc

    console_errors: list[str] = []
    results: dict[str, Any] = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
            locale="en-US",
            color_scheme="dark",
            ignore_https_errors=False,
        )
        context.add_init_script("try{localStorage.setItem('archon_tour_done','1')}catch(e){}")
        page = context.new_page()
        page.set_default_timeout(90_000)
        page.on("console", lambda message: console_errors.append(message.type) if message.type == "error" else None)
        page.goto(base_url, wait_until="networkidle")
        page.locator("#model").filter(has_text=EXPECTED_EMBEDDER).wait_for()
        require(page.locator("#judgeToken").get_attribute("type") == "password", "reviewer field is not password-masked")

        # 01 · fresh-session grounded recall.
        page.locator("#company").fill("Northwind Trading")
        page.locator("#question").fill("What did it really cost to employ the team?")
        with page.expect_response(lambda response: response.url.endswith("/recall") and response.request.method == "POST") as pending:
            page.locator("#askBtn").click()
        recall_response = pending.value
        require(recall_response.status == 200, "Explorer recall returned a non-200 response")
        recall = recall_response.json()
        require(recall.get("modelId") == EXPECTED_NARRATOR, "Explorer recall did not use qwen-plus")
        require(isinstance(recall.get("answer"), str) and recall["answer"].strip(), "Explorer recall returned no answer")
        require(isinstance(recall.get("citations"), list) and len(recall["citations"]) >= 1, "Explorer recall returned no citations")
        page.locator("#result .cite").first.wait_for()
        raw_recall = PRIVATE / "01-grounded-recall-raw.png"
        page.locator("#result").screenshot(path=str(raw_recall), animations="disabled")
        composite_live_capture(
            raw_recall,
            GALLERY / PRIMARY_OUTPUTS[0],
            eyebrow="Fresh session · bounded recall",
            title="Qwen answers from durable memory — with citations",
            subtitle="On original synthetic demo data, a new browser session asks by meaning; pgvector supplies bounded evidence and qwen-plus grounds the answer in numbered sources.",
            badges=("qwen-plus", f"{len(recall['citations'])} citations", "pgvector"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )
        write_private_json("01-grounded-recall-response.json", recall)
        results["recall"] = recall

        # 02 · public read-only field audit.
        with page.expect_response(lambda response: response.url.endswith("/consistency") and response.request.method == "POST") as pending:
            page.locator("#auditBtn").click()
        field_audit = pending.value.json()
        contradictions = field_audit.get("contradictions") if isinstance(field_audit, dict) else None
        require(isinstance(contradictions, list), "field audit returned no contradiction list")
        target = next((item for item in contradictions if item.get("subject") == "INV-5521"), None)
        require(isinstance(target, dict), "field audit did not surface INV-5521")
        values = {item.get("value") for item in target.get("values", [])}
        require({8400, 8900}.issubset(values), "INV-5521 audit does not contain both canonical values")
        resolution = target.get("resolution")
        require(isinstance(resolution, dict) and resolution.get("recommendedValue") == 8900, "field audit recency recommendation is stale")
        target_locator = page.locator(".audit-flag").filter(has_text="INV-5521").first
        target_locator.wait_for()
        raw_field = PRIVATE / "02-field-audit-raw.png"
        target_locator.screenshot(path=str(raw_field), animations="disabled")
        composite_live_capture(
            raw_field,
            GALLERY / PRIMARY_OUTPUTS[1],
            eyebrow="Read-only self-audit",
            title="Both values stay visible. Policy recommends — never rewrites.",
            subtitle="Original synthetic INV-5521 preserves both sessions' provenance, then recommends the later 8,900 value under the declared recency rule.",
            badges=("INV-5521", "8,400 ↔ 8,900", "read-only"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )
        write_private_json("02-field-audit-response.json", field_audit)
        results["fieldAudit"] = field_audit

        # 03 · protected meaning-level Qwen audit.  The token exists in the input
        # only while the request is in flight, then both field and sessionStorage
        # are cleared before any screenshot is taken.
        page.locator("#judgeToken").fill(reviewer_token)
        with page.expect_response(lambda response: response.url.endswith("/consistency/semantic") and response.request.method == "POST") as pending:
            page.locator("#semanticBtn").click()
        semantic_response = pending.value
        require(semantic_response.status == 200, "semantic audit returned a non-200 response")
        semantic = semantic_response.json()
        require(semantic.get("status") == "complete", "semantic audit is not complete")
        findings = semantic.get("semanticContradictions")
        require(isinstance(findings, list) and findings, "semantic audit found no contradiction")
        semantic_target = next(
            (
                finding for finding in findings
                if "always pays" in " ".join(memory.get("content", "") for memory in finding.get("memories", [])).lower()
                and "chronically late" in " ".join(memory.get("content", "") for memory in finding.get("memories", [])).lower()
            ),
            None,
        )
        require(isinstance(semantic_target, dict), "semantic audit omitted the canonical meaning conflict")
        judge = semantic_target.get("judge")
        require(isinstance(judge, dict) and judge.get("model") == probes["health"]["judge"], "semantic finding has the wrong judge provenance")
        page.locator("#judgeToken").fill("")
        page.evaluate("sessionStorage.removeItem('archon_memory_reviewer_token')")
        require(page.locator("#judgeToken").input_value() == "", "reviewer token remained in the page before capture")
        semantic_locator = page.locator(".audit-flag").filter(has_text="chronically late").first
        semantic_locator.wait_for()
        raw_semantic = PRIVATE / "03-semantic-audit-raw.png"
        semantic_locator.screenshot(path=str(raw_semantic), animations="disabled")
        composite_live_capture(
            raw_semantic,
            GALLERY / PRIMARY_OUTPUTS[2],
            eyebrow="Meaning-level self-audit",
            title="Qwen catches the contradiction metadata rules cannot see",
            subtitle="Original synthetic vendor claims share no numeric field. A bounded qwen-plus judge detects their opposed meaning and returns a read-only recommendation.",
            badges=(str(judge["model"]), f"{semantic.get('compared')} pair compared", "credential absent"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )
        write_private_json("03-semantic-audit-response.json", semantic)
        results["semanticAudit"] = semantic

        # 04 · render the real reviewer-tenant decision controls, then exercise
        # the local Defer path (zero API call, zero mutation) after clearing the
        # credential.  Accept/Override remain visibly separated protected actions.
        page.locator("#judgeToken").fill(reviewer_token)
        with page.expect_response(lambda response: response.url.endswith("/consistency") and response.request.method == "POST"):
            page.locator("#auditBtn").click()
        page.locator("#judgeToken").fill("")
        page.evaluate("sessionStorage.removeItem('archon_memory_reviewer_token')")
        control = page.locator(".audit-flag").filter(has_text="INV-5521").first
        control.locator("button", has_text="Defer — no write").click()
        control.locator(".decision-result").filter(has_text="Zero API call").wait_for()
        require(page.locator("#judgeToken").input_value() == "", "reviewer token remained before control capture")
        raw_control = PRIVATE / "04-human-control-raw.png"
        control.screenshot(path=str(raw_control), animations="disabled")
        composite_live_capture(
            raw_control,
            GALLERY / PRIMARY_OUTPUTS[3],
            eyebrow="Structural human gate",
            title="Accept. Override. Or defer with zero write.",
            subtitle="The model recommends; a distinct reviewer action supplies a reason and chooses the outcome. This capture exercises Defer, proving the no-mutation path.",
            badges=("human decision", "idempotent protected actions", "deferred · no write"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )

        # 08 · public repository landing page.  API facts are validated below;
        # the browser capture is the judge-readable visual context.
        repo_page = context.new_page()
        repo_page.set_default_timeout(90_000)
        repo_page.goto(repo_url, wait_until="domcontentloaded")
        repo_page.locator("body").wait_for()
        require("archon-qwen-memoryagent" in repo_page.title().lower(), "public repository landing page did not load")
        raw_repo = PRIVATE / "09-public-repository-raw.png"
        repo_page.screenshot(path=str(raw_repo), animations="disabled")
        results["repoRaw"] = raw_repo
        repo_page.close()

        require(not console_errors, "Explorer emitted browser-console errors during canonical capture")
        context.close()
        browser.close()
    return results


def contained_browser_capture(*args: Any, **kwargs: Any) -> dict[str, Any]:
    """Keep browser profile/temp/cache scratch inside the ignored project tree."""
    scratch = PRIVATE / "browser-runtime"
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)
    keys = ("TMP", "TEMP", "TMPDIR")
    previous = {key: os.environ.get(key) for key in keys}
    for key in keys:
        os.environ[key] = str(scratch)
    try:
        return browser_capture(*args, **kwargs)
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        for attempt in range(3):
            try:
                if scratch.exists():
                    shutil.rmtree(scratch)
                break
            except PermissionError:
                if attempt == 2:
                    raise GateError("project-local browser scratch could not be removed")
                time.sleep(0.2)


def enforce_private_scratch_budget(limit_bytes: int = 256 * 1024 * 1024) -> None:
    total = sum(path.stat().st_size for path in PRIVATE.rglob("*") if path.is_file())
    require(total <= limit_bytes, "ignored private capture scratch exceeds the 256 MiB budget")


def github_public_probe(repo_url: str) -> dict[str, Any]:
    parsed = urlparse.urlparse(repo_url)
    parts = [part for part in parsed.path.split("/") if part]
    require(parsed.hostname == "github.com" and len(parts) == 2, "repository URL must be a canonical github.com owner/repo URL")
    api_url = f"https://api.github.com/repos/{parts[0]}/{parts[1]}"
    req = urlrequest.Request(api_url, headers={"Accept": "application/vnd.github+json", "User-Agent": "Archon-MemoryAgent-Media-Gate/1.0"})
    try:
        with urlrequest.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urlerror.URLError, urlerror.HTTPError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError("unauthenticated GitHub repository probe failed") from exc
    require(data.get("private") is False, "GitHub repository is not public")
    require(data.get("default_branch") == "main", "GitHub default branch is not main")
    license_info = data.get("license")
    require(isinstance(license_info, dict) and license_info.get("spdx_id") == "MIT", "GitHub does not detect the MIT license")
    safe = {
        "html_url": data.get("html_url"),
        "private": data.get("private"),
        "default_branch": data.get("default_branch"),
        "license": {"spdx_id": license_info.get("spdx_id")},
        "pushed_at": data.get("pushed_at"),
    }
    write_private_json("09-github-public-probe.json", safe)
    return safe


def lifecycle_proof(base_url: str, reviewer_token: str, expected_sha: str) -> tuple[dict[str, Any], dict[str, Any]]:
    run_stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    operation_id = f"media-safe-forget-{expected_sha[:12]}-{run_stamp}"
    reason = "Submission gallery: confirm safe-default reviewer-tenant retention proof"
    payload = {"operationId": operation_id, "reason": reason}
    preview, _ = request_json("POST", base_url, "/forget", body=payload, reviewer_token=reviewer_token)
    require(isinstance(preview, dict) and preview.get("dryRun") is True, "lifecycle preview did not remain a dry run")
    require(preview.get("candidates") == 0 and preview.get("forgotten") == 0, "safe-default lifecycle preview selected memory")
    require(isinstance(preview.get("audit"), dict) and preview["audit"].get("persisted") is False, "preview unexpectedly persisted an operation")

    confirmed, _ = request_json(
        "POST", base_url, "/forget", body={**payload, "confirm": True}, reviewer_token=reviewer_token
    )
    require(isinstance(confirmed, dict) and confirmed.get("dryRun") is False, "confirmed lifecycle operation remained a preview")
    require(confirmed.get("candidates") == 0 and confirmed.get("forgotten") == 0, "safe-default confirmation deleted memory")
    audit = confirmed.get("audit")
    require(isinstance(audit, dict) and audit.get("persisted") is True, "confirmed lifecycle operation was not audited")
    require(audit.get("operationId") == operation_id and audit.get("reason") == reason, "lifecycle provenance is incomplete")
    write_private_json("05-lifecycle-preview.json", preview)
    write_private_json("05-lifecycle-confirmed.json", confirmed)
    return preview, confirmed


def format_srt_time(seconds: float) -> str:
    require(seconds >= 0, "SRT time cannot be negative")
    millis = int(round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def parse_measured_windows(path: Path) -> list[tuple[float, float, str]]:
    raw = load_json(path, "caption windows")
    require(isinstance(raw, list) and raw, "caption windows must be a non-empty array")
    rows: list[tuple[float, float, str]] = []
    previous_end = 0.0
    for row in raw:
        require(isinstance(row, list) and len(row) == 3, "caption window has the wrong shape")
        start, end, text = row
        require(isinstance(start, (int, float)) and isinstance(end, (int, float)), "caption time is not numeric")
        require(isinstance(text, str) and text.strip(), "caption text is empty")
        start_f, end_f = float(start), float(end)
        require(start_f >= previous_end - 0.001 and end_f > start_f, "caption windows are not monotonic")
        rows.append((start_f, end_f, text.strip()))
        previous_end = end_f
    return rows


def parse_canonical_captions(path: Path, *, title_offset: float = 3.0) -> list[tuple[float, float, str]]:
    rows: list[tuple[float, float, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        parts = line.split("|", 2)
        require(len(parts) == 3, "canonical caption line has the wrong shape")
        rows.append((float(parts[0]) + title_offset, float(parts[1]) + title_offset, parts[2].strip()))
    require(rows, "canonical caption file is empty")
    return rows


def emit_srt(
    output: Path,
    *,
    measured_windows: Path | None,
    allow_canonical_fallback: bool,
    video_manifest: Path | None,
    web_narration: Path | None,
) -> str:
    if measured_windows is not None:
        rows = parse_measured_windows(measured_windows)
        source = "measured-caption-windows"
    else:
        require(allow_canonical_fallback, "final SRT requires --caption-windows; use --allow-canonical-caption-fallback only for an explicit draft")
        rows = parse_canonical_captions(REPO / "scripts" / "captions.txt")
        source = "canonical-unmeasured-draft"

    if video_manifest is not None or web_narration is not None:
        require(video_manifest is not None and web_narration is not None, "web narration timing requires both --video-manifest and --web-narration")
        manifest = load_json(video_manifest, "video manifest")
        require(isinstance(manifest, dict), "video manifest must be an object")
        title = float(manifest.get("title_dur"))
        screencast = float(manifest.get("screencast_dur"))
        web_duration = float(manifest.get("web_dur"))
        web_audio = float(manifest.get("a_web"))
        narration = web_narration.read_text(encoding="utf-8").strip()
        require(narration and web_duration >= web_audio > 0, "measured web narration timing is invalid")
        web_start = title + screencast + 0.5
        web_end = min(title + screencast + web_duration, web_start + web_audio)
        require(web_start >= rows[-1][1] - 0.05 and web_end > web_start, "web narration overlaps measured caption windows")
        rows.append((web_start, web_end, narration))
        source += "+measured-web-beat"

    require(rows[-1][1] < 175.0, "subtitle timeline reaches the 175-second publication ceiling")

    blocks: list[str] = []
    for index, (start, end, text) in enumerate(rows, start=1):
        clean_text = BEARER.sub("[REMOVED]", EMAIL.sub("[REMOVED]", text))
        require(clean_text == text, "subtitle text contains secret-shaped content")
        blocks.append(f"{index}\n{format_srt_time(start)} --> {format_srt_time(end)}\n{text}\n")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(blocks), encoding="utf-8", newline="\n")
    require(output.stat().st_size > 50, "generated SRT is unexpectedly small")
    return source


def render_youtube_thumbnail(field_audit_image: Path, output: Path) -> None:
    source = Image.open(field_audit_image).convert("RGB")
    background = ImageOps.fit(source, (1280, 720), method=Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(5))
    overlay = Image.new("RGBA", (1280, 720), (3, 13, 10, 175))
    canvas = Image.alpha_composite(background.convert("RGBA"), overlay)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1280, 9), fill="#35d399")
    rounded(draw, (58, 48, 255, 96), "#103628", radius=22, outline="#35d399", width=2)
    draw.text((156, 72), "QWEN CLOUD", anchor="mm", font=font(20, bold=True), fill="#cffff0")
    draw.text((58, 135), "MEMORY", font=font(74, bold=True), fill="#ffffff")
    draw.text((58, 215), "THAT AUDITS", font=font(74, bold=True), fill="#ffffff")
    draw.text((58, 295), "ITSELF", font=font(74, bold=True), fill="#35d399")
    draw.text((61, 397), "Cross-session contradiction", font=font(29, bold=True), fill="#c0d5cc")
    rounded(draw, (58, 456, 305, 551), "#16251f", radius=22, outline="#637c71", width=2)
    rounded(draw, (332, 456, 579, 551), "#17372a", radius=22, outline="#35d399", width=2)
    draw.text((181, 504), "€8,400", anchor="mm", font=font(46, bold=True), fill="#f6fff9")
    draw.text((455, 504), "€8,900", anchor="mm", font=font(46, bold=True), fill="#86efc1")
    draw.text((318, 583), "RECOMMEND · DON'T REWRITE", anchor="mm", font=font(23, bold=True), fill="#a8c0b6")

    # A crisp crop of the real final field-audit composite anchors the right side.
    panel = ImageOps.fit(source, (570, 520), method=Image.Resampling.LANCZOS, centering=(0.58, 0.58))
    rounded(draw, (650, 105, 1242, 647), "#0a1713", radius=28, outline="#3e6d5a", width=3)
    canvas.alpha_composite(panel.convert("RGBA"), (661, 116))
    rounded(draw, (1010, 48, 1225, 96), "#9f1c1c", radius=22)
    draw.text((1118, 72), "LIVE PROOF", anchor="mm", font=font(20, bold=True), fill="#ffffff")
    strip_and_save(canvas.convert("RGB"), output, size=(1280, 720))


def scan_text_for_secrets(text: str, expected_sha: str, base_url: str) -> None:
    normalized = text.replace(expected_sha, "[EXPECTED_SHA]").replace(base_url, "[BASE_URL]")
    require(BEARER.search(normalized) is None, "generated text contains a Bearer credential")
    require(EMAIL.search(normalized) is None, "generated text contains an email address")
    require(PRIVATE_IPV4.search(normalized) is None, "generated text contains a private IPv4 address")


def verify_outputs(expected_sha: str, base_url: str) -> dict[str, str]:
    required = [GALLERY / name for name in (*PRIMARY_OUTPUTS, *SECONDARY_OUTPUTS)]
    required.extend([ARCHITECTURE, FINAL_MEDIA / "youtube-thumbnail.png", FINAL_MEDIA / "memoryagent-demo.en.srt"])
    required.extend(PROOF_FRAMES / f"{Path(name).stem}-16x9.png" for name in (*PRIMARY_OUTPUTS, *SECONDARY_OUTPUTS))
    hashes: dict[str, str] = {}
    for path in required:
        require(path.is_file(), f"required output {path.relative_to(REPO)} is missing")
        if path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            with Image.open(path) as image:
                if path.name == "youtube-thumbnail.png":
                    require(image.size == (1280, 720), "YouTube thumbnail is not 1280×720")
                elif path == ARCHITECTURE:
                    require(image.size[0] >= 1600 and image.size[1] >= 900, "architecture image is below 1600×900")
                elif path.parent == PROOF_FRAMES:
                    require(image.size == CANVAS, f"{path.name} is not a 1920×1080 video proof frame")
                else:
                    require(image.size == GALLERY_CANVAS, f"{path.name} is not a 1500×1000 Devpost gallery final")
        if path.suffix.lower() == ".srt":
            scan_text_for_secrets(path.read_text(encoding="utf-8"), expected_sha, base_url)
        hashes[str(path.relative_to(REPO)).replace("\\", "/")] = sha256_file(path)

    tracked_private = git("ls-files", "demo/private-originals")
    require(not tracked_private, "demo/private-originals contains tracked files")
    return hashes


def write_review_manifest(
    *,
    expected_sha: str,
    remote_main: str,
    base_url: str,
    observed_at: str,
    probes: dict[str, Any],
    hashes: dict[str, str],
    srt_source: str,
) -> None:
    manifest = {
        "schemaVersion": 1,
        "status": "passed",
        "capturedAt": observed_at,
        "liveBaseUrl": base_url,
        "exactRuntimeSource": expected_sha,
        "submissionPackHeadAtCapture": remote_main,
        "models": {
            "embedder": probes["health"]["embedder"],
            "narrator": probes["health"]["narrator"],
            "judge": probes["health"]["judge"],
            "embedDim": probes["health"]["embedDim"],
        },
        "gates": {
            "exactDeploymentEvidence": True,
            "publicHealthReady": True,
            "authenticatedDeepReadiness": True,
            "publicSeedIdempotent": True,
            "selectedCompanyPnl": True,
            "reviewerCredentialRendered": False,
            "rawCapturesTracked": False,
            "alibabaProfileShaBound": True,
        },
        "subtitleTimingSource": srt_source,
        "artifacts": hashes,
    }
    path = GALLERY / "CAPTURE_REVIEW.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def self_test() -> int:
    root = project_path(".artifacts/media-pipeline-selftest", "self-test output")
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    raw = Image.new("RGB", (900, 500), "#10251f")
    draw = ImageDraw.Draw(raw)
    draw.text((55, 60), "SYNTHETIC SELF-TEST — NOT LIVE EVIDENCE", font=font(34, bold=True), fill="#ffffff")
    draw.text((55, 140), "Qwen · pgvector · citations [1] [2]", font=font(28), fill="#8ee8bd")
    raw_path = root / "raw.png"
    strip_and_save(raw, raw_path, min_bytes=1_000)
    output = root / "composite.png"
    composite_live_capture(
        raw_path,
        output,
        eyebrow="Pipeline self-test",
        title="Layout and metadata gate",
        subtitle="Synthetic fixture. This file is ignored and cannot be used as live evidence.",
        badges=("SELF-TEST", "NOT LIVE"),
        base_url=DEFAULT_BASE_URL,
        expected_sha="0" * 40,
        observed_at="2000-01-01T00:00:00Z",
        dual_submission=False,
    )
    windows = root / "windows.json"
    windows.write_text(json.dumps([[3.0, 5.0, "Synthetic caption"], [5.0, 7.5, "Second caption"]]), encoding="utf-8")
    srt = root / "test.srt"
    source = emit_srt(srt, measured_windows=windows, allow_canonical_fallback=False, video_manifest=None, web_narration=None)
    require(source == "measured-caption-windows" and "00:00:03,000" in srt.read_text(encoding="utf-8"), "SRT self-test failed")
    require(output.is_file() and Image.open(output).size == CANVAS, "composite self-test failed")
    gallery_fixture = root / "gallery-3x2.png"
    video_fixture = root / "proof-16x9.png"
    save_dual_submission_frame(Image.open(output), gallery_fixture, proof_output=video_fixture)
    require(Image.open(gallery_fixture).size == GALLERY_CANVAS, "3:2 mapping self-test failed")
    require(Image.open(video_fixture).size == CANVAS, "16:9 mapping self-test failed")
    probes = {
        "health": {
            "status": "ok", "embedder": EXPECTED_EMBEDDER, "narrator": EXPECTED_NARRATOR,
            "judge": EXPECTED_NARRATOR, "embedDim": EXPECTED_DIMENSION,
        },
        "deep": {
            "cached": True,
            "checks": {"embedder": {"status": "operational"}, "narrator": {"grounding": "passed"}},
        },
    }
    health_fixture = root / "health-3x2.png"
    render_health_card(
        health_fixture, probes,
        base_url=DEFAULT_BASE_URL, expected_sha="0" * 40, observed_at="2000-01-01T00:00:00Z",
    )
    lifecycle_fixture = root / "lifecycle-3x2.png"
    audit_preview = {
        "dryRun": True, "scanned": 4, "candidates": 0, "forgotten": 0,
        "audit": {"persisted": False, "reason": "synthetic self-test"},
    }
    audit_confirmed = {
        "dryRun": False, "scanned": 4, "candidates": 0, "forgotten": 0,
        "audit": {"persisted": True, "reason": "synthetic self-test"},
    }
    render_lifecycle_card(
        lifecycle_fixture, audit_preview, audit_confirmed,
        base_url=DEFAULT_BASE_URL, expected_sha="0" * 40, observed_at="2000-01-01T00:00:00Z",
    )
    render_youtube_thumbnail(gallery_fixture, root / "youtube-thumbnail.png")
    require(Image.open(health_fixture).size == GALLERY_CANVAS, "health-card self-test failed")
    require(Image.open(lifecycle_fixture).size == GALLERY_CANVAS, "lifecycle-card self-test failed")
    require(Image.open(root / "youtube-thumbnail.png").size == (1280, 720), "YouTube thumbnail self-test failed")
    print("media pipeline self-test: PASS (ignored project-contained fixtures only)")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run offline compositor/path/SRT checks only")
    parser.add_argument("--expected-sha", help="40-character exact deployed MemoryAgent source SHA")
    parser.add_argument("--deployment-output", help="repo-contained exact deploy decoded output")
    parser.add_argument("--deployment-status", help="repo-contained sanitized exact deploy status JSON")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--repo-url", default=DEFAULT_REPO_URL)
    parser.add_argument(
        "--reviewer-credential-json",
        help="explicit ignored repo-local JSON containing only the private in-memory token source",
    )
    parser.add_argument("--alibaba-raw", help="human-reviewed repo-contained raw Alibaba console PNG")
    parser.add_argument(
        "--alibaba-redaction-profile",
        default="demo/alibaba-redaction-profile.json",
        help="SHA-bound crop/redaction profile",
    )
    parser.add_argument("--caption-windows", help="final measured caption_windows.json")
    parser.add_argument("--video-manifest", help="final measured video_manifest.json")
    parser.add_argument("--web-narration", help="final narration_web.txt used by the video")
    parser.add_argument(
        "--allow-canonical-caption-fallback",
        action="store_true",
        help="emit an explicitly unmeasured draft SRT when final caption windows are unavailable",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()

    try:
        require(args.expected_sha is not None, "--expected-sha is required")
        require(args.deployment_output is not None and args.deployment_status is not None, "both deployment evidence paths are required")
        require(args.alibaba_raw is not None, "--alibaba-raw is required")
        expected_sha = str(args.expected_sha).lower()
        deployment_output = project_path(args.deployment_output, "deployment output", must_exist=True)
        deployment_status = project_path(args.deployment_status, "deployment status", must_exist=True)
        raw_alibaba_source = project_path(args.alibaba_raw, "Alibaba raw capture", must_exist=True)
        redaction_profile = project_path(args.alibaba_redaction_profile, "Alibaba redaction profile", must_exist=True)
        caption_windows = project_path(args.caption_windows, "caption windows", must_exist=True) if args.caption_windows else None
        video_manifest = project_path(args.video_manifest, "video manifest", must_exist=True) if args.video_manifest else None
        web_narration = project_path(args.web_narration, "web narration", must_exist=True) if args.web_narration else None

        parsed_base = urlparse.urlparse(args.base_url)
        require(parsed_base.scheme == "https" and parsed_base.hostname is not None, "--base-url must be an HTTPS origin")
        reviewer_token = reviewer_token_from_args(args)

        PRIVATE.mkdir(parents=True, exist_ok=True)
        GALLERY.mkdir(parents=True, exist_ok=True)
        FINAL_MEDIA.mkdir(parents=True, exist_ok=True)
        require(ARCHITECTURE.is_file(), "canonical architecture image is missing")

        # Copy the reviewed raw cloud capture into this checkout's ignored private
        # originals.  The source is required to be project-contained; no OS temp or
        # external artifact directory is ever used.
        private_alibaba = PRIVATE / "alibaba-ecs-overview-raw.png"
        if raw_alibaba_source.resolve() != private_alibaba.resolve():
            shutil.copyfile(raw_alibaba_source, private_alibaba)
        else:
            private_alibaba = raw_alibaba_source
        enforce_private_scratch_budget()

        print("[1/8] exact release + post-deploy source allowlist")
        remote_main = verify_exact_release(expected_sha, deployment_output, deployment_status)
        observed_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

        print("[2/8] public health/readiness, authenticated deep readiness, seed and selected-company P&L")
        probes = public_release_probes(args.base_url, reviewer_token)

        print("[3/8] canonical Explorer recall, field audit, semantic audit and human-control captures")
        captured = contained_browser_capture(
            args.base_url, args.repo_url, reviewer_token, expected_sha, observed_at, probes
        )
        enforce_private_scratch_budget()

        print("[4/8] authenticated lifecycle preview + confirmed safe-default audit")
        preview, confirmed = lifecycle_proof(args.base_url, reviewer_token, expected_sha)
        render_lifecycle_card(
            GALLERY / PRIMARY_OUTPUTS[4], preview, confirmed,
            base_url=args.base_url, expected_sha=expected_sha, observed_at=observed_at,
        )

        print("[5/8] health/readiness and SHA-bound Alibaba proof cards")
        render_architecture_assets(GALLERY / PRIMARY_OUTPUTS[5])
        render_health_card(
            GALLERY / SECONDARY_OUTPUTS[0], probes,
            base_url=args.base_url, expected_sha=expected_sha, observed_at=observed_at,
        )
        sanitized_alibaba = sanitize_alibaba_capture(private_alibaba, redaction_profile)
        render_alibaba_card(
            GALLERY / SECONDARY_OUTPUTS[1], sanitized_alibaba, probes,
            base_url=args.base_url, expected_sha=expected_sha, observed_at=observed_at,
        )

        print("[6/8] public GitHub + MIT API gate and repository capture")
        github_public_probe(args.repo_url)
        render_repository_card(
            captured["repoRaw"], GALLERY / SECONDARY_OUTPUTS[2],
            repo_url=args.repo_url, remote_main=remote_main, observed_at=observed_at,
        )

        print("[7/8] 1280×720 YouTube thumbnail and English subtitle artifact")
        render_youtube_thumbnail(GALLERY / PRIMARY_OUTPUTS[1], FINAL_MEDIA / "youtube-thumbnail.png")
        srt_source = emit_srt(
            FINAL_MEDIA / "memoryagent-demo.en.srt",
            measured_windows=caption_windows,
            allow_canonical_fallback=args.allow_canonical_caption_fallback,
            video_manifest=video_manifest,
            web_narration=web_narration,
        )

        print("[8/8] dimensions, metadata, private-original tracking and artifact hashes")
        hashes = verify_outputs(expected_sha, args.base_url)
        enforce_private_scratch_budget()
        write_review_manifest(
            expected_sha=expected_sha,
            remote_main=remote_main,
            base_url=args.base_url,
            observed_at=observed_at,
            probes=probes,
            hashes=hashes,
            srt_source=srt_source,
        )
        print(f"submission media gate: PASS · exact runtime {expected_sha[:12]} · {len(hashes)} reviewed artifacts")
        return 0
    except GateError as exc:
        print(f"submission media gate: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
