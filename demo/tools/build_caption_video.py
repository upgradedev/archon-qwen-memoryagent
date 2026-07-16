#!/usr/bin/env python3
"""Build the final rights-safe, caption-led MemoryAgent submission video.

The production path is deliberately fail closed. It consumes only the canonical,
hash-bound media inventory produced by ``scripts/capture_submission_gallery.py``
and exact-deployment evidence kept inside this repository. It never captures the
live service, synthesizes speech, downloads media, or invents judge-facing proof.

The resulting MP4 is 1920x1080 H.264 at 30 fps with a generated silent AAC track.
Every English caption is burned into the picture and mirrored byte-for-byte in the
measured SRT. The ten beat windows are frame-exact and total 172 seconds.
"""

from __future__ import annotations

import argparse
from array import array
from dataclasses import dataclass, replace
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any, Iterable, Sequence
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


REPO_HINT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_HINT / "scripts"))
from repo_paths import REPO_ROOT, inside_repo  # noqa: E402


REPO = Path(REPO_ROOT)
FPS = 30
CANVAS = (1920, 1080)
GALLERY_CANVAS = (1500, 1000)
STRICT_LIMIT_SECONDS = 175
EXPECTED_TOTAL_SECONDS = 172
EXPECTED_EMBEDDER = "text-embedding-v4"
EXPECTED_NARRATOR = "qwen-plus"
EXPECTED_VISION = "qwen-vl-max"
EXPECTED_EMBED_DIM = 1024

CAPTURE_REVIEW_REL = "demo/gallery/CAPTURE_REVIEW.json"
DEPLOY_STATE_REL = "deploy/DEPLOY_STATE.md"
CLAIM_MATRIX_REL = "docs/CLAIM_EVIDENCE_MATRIX.md"
SRT_REL = "demo/final-media/memoryagent-demo.en.srt"
ARCHITECTURE_REL = "demo/final-media/judge-architecture.jpg"
ARCHITECTURE_SOURCE_REL = "docs/judge-architecture.svg"
DEFAULT_OUTPUT_REL = "demo/final-media/memoryagent-demo.mp4"
DEFAULT_MANIFEST_REL = "demo/final-media/memoryagent-demo.manifest.json"
DEFAULT_SCRATCH_REL = ".artifacts/final-caption-video"

GALLERY_STEMS = (
    "01-grounded-cross-session-recall",
    "02-session-feedback-persistence",
    "03-read-only-field-self-audit",
    "04-qwen-semantic-self-audit",
    "05-human-resolution-control",
    "06-safe-memory-lifecycle",
    "07-qwen-memoryagent-architecture",
    "08-qwen-vl-document-canary",
    "09-live-health-readiness",
    "10-alibaba-runtime-proof",
    "11-public-repository-license",
)
GALLERY_RELS = tuple(f"demo/gallery/{stem}.png" for stem in GALLERY_STEMS)
PROOF_RELS = tuple(f"demo/final-media/proof-frames/{stem}-16x9.png" for stem in GALLERY_STEMS)
EVIDENCE_PROOF_RELS = tuple(rel for index, rel in enumerate(PROOF_RELS) if index != 6)


@dataclass(frozen=True)
class Beat:
    number: int
    title: str
    seconds: int
    caption: str
    visuals: tuple[str, ...]
    labels: tuple[str, ...] = ()
    treatment: str = "proof"


BEATS: tuple[Beat, ...] = (
    Beat(
        1,
        "Stakes + Track 1",
        13,
        "Persistent memory can preserve yesterday's mistake. Archon MemoryAgent recalls, cites, audits, corrects, consolidates, and forgets across sessions.",
        (PROOF_RELS[0],),
        treatment="title",
    ),
    Beat(
        2,
        "Exact live proof + Qwen vision",
        19,
        "Exact release evidence proves source; readiness proves real models. Original synthetic two-PNG qwen-vl-max dry-run: one fused event, zero writes or residue - not raw-PDF parsing.",
        (PROOF_RELS[8], PROOF_RELS[7]),
        ("Live /health + /ready", "Original synthetic qwen-vl-max dry-run"),
    ),
    Beat(
        3,
        "Architecture + bounded scale path",
        19,
        "Tenant-scoped REST, MCP, and pg-wire seams surround Qwen plus pgvector. Active topology is Alibaba Cloud ECS; Function Compute and RDS are alternative-only.",
        (ARCHITECTURE_REL,),
        ("Evidence -> Qwen -> pgvector -> cited answer -> human decision",),
    ),
    Beat(
        4,
        "Cross-session memory",
        22,
        "Original synthetic Northwind data: Session B recalls 15,800 workforce cost versus 10,000 bank outflow with citations. This proof shows pure cosine; the product default remains hybrid.",
        (PROOF_RELS[0],),
        ("Fresh session · grounded cited recall",),
    ),
    Beat(
        5,
        "Read-only self-audit + human control",
        22,
        "INV-5521 is original synthetic data: 8,400 versus 8,900. Audit detects and recommends without rewriting. Live control proves Defer only: zero API call or write; Accept and Override remain unexercised.",
        (PROOF_RELS[2], PROOF_RELS[4]),
        ("Read-only field audit", "Live Defer only · zero mutation"),
    ),
    Beat(
        6,
        "Feedback persists across sessions",
        18,
        "Session A stores explicit reviewer feedback; a fresh authenticated Session B recalls, cites, and applies it. Durable persisted state - not training, autonomous learning, or a model-weight update.",
        (PROOF_RELS[1],),
        ("Session A correction · fresh Session B cited application",),
    ),
    Beat(
        7,
        "Meaning-level audit + MCP",
        17,
        "Original synthetic vendor claims: Qwen checks opposed meaning. The live mechanism is separate from the offline 90% fixture. Four typed MCP tools share one core; HTTP is authenticated, stdio trusted-local.",
        (PROOF_RELS[3], PROOF_RELS[6]),
        ("Authenticated Qwen meaning audit", "Shared core · four typed MCP tools"),
    ),
    Beat(
        8,
        "Timely forgetting",
        12,
        "Preview selects exactly one feedback-superseded synthetic candidate; confirm deletes exactly one with audit. Protected memories stay unchanged and marker residue is zero. This is not an age-expired row.",
        (PROOF_RELS[5],),
        ("Preview 1 · delete 1 · protect state · residue 0",),
    ),
    Beat(
        9,
        "Evidence, not hype",
        20,
        "Developer-labelled synthetic and offline fixtures - not production accuracy or independent evaluation. No universal superiority claim.",
        (),
        treatment="evidence",
    ),
    Beat(
        10,
        "Alibaba + public-source close",
        10,
        "Verified active topology: Alibaba Cloud ECS plus self-hosted pgvector. Function Compute and RDS remain alternatives. Public MIT source.",
        (PROOF_RELS[9], PROOF_RELS[10]),
        ("MemoryAgent-only Alibaba proof", "Public repository · MIT"),
    ),
)

REQUIRED_ARTIFACTS = frozenset((*GALLERY_RELS, *PROOF_RELS, ARCHITECTURE_REL, SRT_REL))
REQUIRED_BOOLEAN_GATES = {
    "exactDeploymentEvidence": True,
    "publicHealthReady": True,
    "authenticatedDeepReadiness": True,
    "publicSeedIdempotent": True,
    "selectedCompanyPnl": True,
    "reviewerCredentialRendered": False,
    "rawCapturesTracked": False,
    "alibabaProfileShaBound": True,
}
REQUIRED_CLAIM_SNIPPETS = (
    "explicit persisted feedback",
    "not autonomous self-learning, training, or model-weight change",
    "feedback-superseded retention candidate",
    "Do not call that row age-expired",
    "original synthetic payroll-register + bank-confirmation PNG pair",
    "zero writes, unchanged tenant count, and zero exact-marker residue",
    "The API does not parse raw PDF bytes",
    "Human-control capture is explicitly Defer-only",
    "5/5 injected problems, 0 false positives",
    "4/4 declared-policy conformance",
    "90% recall, 100% precision, 0 false positives",
    "MRR 0.883 → 0.911",
    "Recall@3 90.0% → 96.7%",
    "Do not claim universal inferiority",
)
SAFE_POST_CAPTURE_PATTERNS = (
    re.compile(r"^(?:README\.md|SECURITY\.md|deploy/DEPLOY_STATE\.md)$"),
    re.compile(r"^(?:demo|docs)/"),
    re.compile(r"^\.github/workflows/demo-video\.yml$"),
)
SHA40 = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+\-/=]{8,}", re.IGNORECASE)
PRIVATE_IPV4 = re.compile(
    r"\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b"
)


class GateError(RuntimeError):
    """A fail-closed input, build, or verification error."""


@dataclass(frozen=True)
class ValidatedInputs:
    exact_runtime_sha: str
    capture_head: str
    current_head: str
    captured_at: str
    live_base_url: str
    capture_review_path: Path
    deploy_state_path: Path
    claim_matrix_path: Path
    deployment_output_path: Path
    deployment_status_path: Path
    artifact_paths: dict[str, Path]
    artifact_hashes: dict[str, str]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def project_path(value: str | Path, label: str, *, must_exist: bool = False) -> Path:
    try:
        return Path(inside_repo(value, label, must_exist=must_exist))
    except ValueError as exc:
        raise GateError(str(exc)) from exc


def relative_repo_path(path: Path) -> str:
    return path.resolve().relative_to(REPO).as_posix()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{label} is not valid UTF-8 JSON") from exc


def git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and result.returncode != 0:
        raise GateError(f"git {' '.join(args[:2])} failed (exit {result.returncode})")
    return result.stdout.strip()


def git_success(*args: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(REPO), *args],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def allowed_submission_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return any(pattern.fullmatch(normalized) or pattern.match(normalized) for pattern in SAFE_POST_CAPTURE_PATTERNS)


def working_tree_paths() -> set[str]:
    paths: set[str] = set()
    for args in (
        ("diff", "--name-only"),
        ("diff", "--cached", "--name-only"),
        ("ls-files", "--others", "--exclude-standard"),
    ):
        paths.update(line for line in git(*args).splitlines() if line)
    return {path.replace("\\", "/") for path in paths}


def ensure_ignored_untracked(path: Path, label: str) -> None:
    rel = relative_repo_path(path)
    require(not git_success("ls-files", "--error-unmatch", "--", rel), f"{label} must not be tracked")
    require(git_success("check-ignore", "--quiet", "--", rel), f"{label} must live under an ignored project path")


def ensure_clean_tracked(path: Path, label: str) -> None:
    rel = relative_repo_path(path)
    require(git_success("ls-files", "--error-unmatch", "--", rel), f"{label} must be committed before a production build")
    require(git_success("diff", "--quiet", "HEAD", "--", rel), f"{label} differs from current HEAD; commit it before a production build")


def caption_windows(beats: Sequence[Beat] = BEATS) -> list[list[int | str]]:
    rows: list[list[int | str]] = []
    cursor = 0
    for beat in beats:
        end = cursor + beat.seconds
        rows.append([cursor, end, beat.caption])
        cursor = end
    return rows


def format_srt_time(seconds: int) -> str:
    require(seconds >= 0, "SRT time cannot be negative")
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},000"


def expected_srt(beats: Sequence[Beat] = BEATS) -> str:
    blocks = []
    for index, (start, end, text) in enumerate(caption_windows(beats), start=1):
        blocks.append(f"{index}\n{format_srt_time(int(start))} --> {format_srt_time(int(end))}\n{text}\n")
    return "\n".join(blocks)


def write_caption_windows(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(caption_windows(), ensure_ascii=False, indent=2) + "\n"
    path.write_text(payload, encoding="utf-8", newline="\n")


def artifact_path(artifact_root: Path, rel: str) -> Path:
    root = artifact_root.resolve(strict=True)
    candidate = (root / Path(rel)).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise GateError(f"capture artifact {rel} escapes its project-contained root") from exc
    return candidate


def validate_image_dimensions(rel: str, path: Path) -> None:
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            size = image.size
    except (OSError, SyntaxError) as exc:
        raise GateError(f"capture artifact {rel} is not a valid image") from exc
    if rel in GALLERY_RELS:
        require(size == GALLERY_CANVAS, f"capture artifact {rel} is not 1500x1000")
    elif rel in PROOF_RELS:
        require(size == CANVAS, f"capture artifact {rel} is not 1920x1080")
    elif rel == ARCHITECTURE_REL:
        require(size[0] >= 1600 and size[1] >= 900, "canonical architecture is below 1600x900")


def validate_capture_review(
    review_path: Path,
    artifact_root: Path,
    expected_sha: str,
    beats: Sequence[Beat],
) -> tuple[dict[str, Any], dict[str, Path], dict[str, str]]:
    review = load_json(review_path, "capture review")
    require(isinstance(review, dict), "capture review must be a JSON object")
    require(review.get("schemaVersion") == 2 and review.get("status") == "passed", "capture review is not schema-v2 passed")
    require(review.get("exactRuntimeSource") == expected_sha, "capture review exact runtime differs from --expected-sha")

    captured_at = review.get("capturedAt")
    require(isinstance(captured_at, str) and captured_at.endswith("Z"), "capture review has no UTC capturedAt")
    try:
        captured_time = dt.datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GateError("capture review capturedAt is invalid") from exc
    now = dt.datetime.now(dt.timezone.utc)
    require(captured_time <= now + dt.timedelta(minutes=5), "capture review is dated in the future")

    base_url = review.get("liveBaseUrl")
    parsed = urlparse(base_url) if isinstance(base_url, str) else None
    require(parsed is not None and parsed.scheme == "https" and parsed.hostname, "capture review liveBaseUrl is not an HTTPS origin")
    try:
        parsed_port = parsed.port
    except ValueError as exc:
        raise GateError("capture review liveBaseUrl has an invalid port") from exc
    require(
        parsed.username is None
        and parsed.password is None
        and parsed_port in {None, 443}
        and parsed.path in {"", "/"}
        and not parsed.params
        and not parsed.query
        and not parsed.fragment,
        "capture review liveBaseUrl must be a credential-free HTTPS origin with no path/query/fragment",
    )

    models = review.get("models")
    require(isinstance(models, dict), "capture review has no model inventory")
    require(models.get("embedder") == EXPECTED_EMBEDDER, "capture review embedder is not text-embedding-v4")
    require(models.get("narrator") == EXPECTED_NARRATOR, "capture review narrator is not qwen-plus")
    require(models.get("vision") == EXPECTED_VISION, "capture review vision model is not qwen-vl-max")
    require(models.get("embedDim") == EXPECTED_EMBED_DIM, "capture review embed dimension is not 1024")
    judge = models.get("judge")
    require(isinstance(judge, str) and judge.lower().startswith("qwen") and "fake" not in judge.lower(), "capture review judge is not a real Qwen model")

    gates = review.get("gates")
    require(isinstance(gates, dict), "capture review has no gate results")
    for name, expected in REQUIRED_BOOLEAN_GATES.items():
        require(gates.get(name) is expected, f"capture review gate {name} is not {expected}")

    vision_gate = gates.get("qwenVlOriginalSyntheticDryRun")
    require(isinstance(vision_gate, dict), "capture review has no Qwen-VL dry-run gate")
    require(vision_gate.get("modelIdReported") == EXPECTED_VISION, "Qwen-VL gate did not report qwen-vl-max")
    require(type(vision_gate.get("written")) is int and vision_gate.get("written") == 0, "Qwen-VL dry-run wrote memory")
    require(vision_gate.get("reviewerCountUnchanged") is True, "Qwen-VL dry-run changed reviewer memory count")
    require(type(vision_gate.get("uniquePrefixResidue")) is int and vision_gate.get("uniquePrefixResidue") == 0, "Qwen-VL dry-run left marker residue")

    feedback_gate = gates.get("feedbackPersistence")
    require(isinstance(feedback_gate, dict), "capture review has no feedback-persistence gate")
    for name in ("sessionAStoredCorrection", "freshSessionBRecalledCorrection", "freshSessionBAppliedPreference"):
        require(feedback_gate.get(name) is True, f"feedback-persistence gate {name} is not true")
    require(feedback_gate.get("boundary") == "explicit persisted feedback; no model-weight update", "feedback gate lost the no-learning boundary")

    lifecycle_gate = gates.get("lifecycleOneRow")
    require(isinstance(lifecycle_gate, dict), "capture review has no one-row lifecycle gate")
    require(lifecycle_gate.get("retentionBasis") == "feedback-superseded original synthetic fact", "lifecycle retention basis is not feedback-superseded synthetic data")
    require(type(lifecycle_gate.get("previewCandidates")) is int and lifecycle_gate.get("previewCandidates") == 1, "lifecycle preview did not select exactly one row")
    require(type(lifecycle_gate.get("confirmedForgotten")) is int and lifecycle_gate.get("confirmedForgotten") == 1, "lifecycle confirmation did not delete exactly one row")
    for name in ("protectedSeedUnchanged", "protectedCorrectionUnchanged", "postProofCleanupApplied"):
        require(lifecycle_gate.get(name) is True, f"lifecycle gate {name} is not true")
    require(type(lifecycle_gate.get("uniquePrefixResidue")) is int and lifecycle_gate.get("uniquePrefixResidue") == 0, "lifecycle cleanup left marker residue")
    require(gates.get("humanControlCapture") == "Defer-only live proof; Accept/Override are not claimed by this frame", "human-control capture is not the locked Defer-only proof")

    timing_source = review.get("subtitleTimingSource")
    require(
        isinstance(timing_source, str)
        and timing_source.startswith("measured-caption-windows")
        and "canonical-unmeasured" not in timing_source,
        "capture review subtitle timing is not measured",
    )

    raw_artifacts = review.get("artifacts")
    require(isinstance(raw_artifacts, dict), "capture review has no artifact hash inventory")
    normalized: dict[str, str] = {}
    for raw_rel, raw_hash in raw_artifacts.items():
        require(isinstance(raw_rel, str) and isinstance(raw_hash, str), "capture review artifact entry has the wrong shape")
        rel = raw_rel.replace("\\", "/")
        require(rel == raw_rel and not rel.startswith("/"), "capture review artifact path is not canonical project-relative POSIX")
        require(all(part not in {"", ".", ".."} for part in rel.split("/")), "capture review artifact path contains traversal or empty components")
        require(rel.startswith("demo/gallery/") or rel.startswith("demo/final-media/"), f"capture review contains disallowed artifact {rel}")
        require(SHA256.fullmatch(raw_hash.lower()) is not None, f"capture review hash for {rel} is invalid")
        require(rel not in normalized, f"capture review repeats artifact {rel}")
        normalized[rel] = raw_hash.lower()
    missing = sorted(REQUIRED_ARTIFACTS - normalized.keys())
    require(not missing, f"capture review is missing required artifact {missing[0] if missing else ''}")

    architecture = review.get("architecture")
    require(isinstance(architecture, dict), "capture review has no architecture source/raster binding")
    require(architecture.get("sourcePath") == ARCHITECTURE_SOURCE_REL, "capture review architecture source path is not canonical")
    require(architecture.get("rasterPath") == ARCHITECTURE_REL, "capture review architecture raster path is not canonical")
    architecture_source_hash = architecture.get("sourceSha256")
    architecture_raster_hash = architecture.get("rasterSha256")
    require(isinstance(architecture_source_hash, str) and SHA256.fullmatch(architecture_source_hash.lower()), "capture review architecture source hash is invalid")
    require(isinstance(architecture_raster_hash, str) and SHA256.fullmatch(architecture_raster_hash.lower()), "capture review architecture raster hash is invalid")
    require(sha256_file(project_path(ARCHITECTURE_SOURCE_REL, "architecture source", must_exist=True)) == architecture_source_hash.lower(), "architecture source changed after capture")
    require(normalized.get(ARCHITECTURE_REL) == architecture_raster_hash.lower(), "architecture raster hash disagrees with the artifact inventory")

    paths: dict[str, Path] = {}
    for rel, expected_hash in normalized.items():
        path = artifact_path(artifact_root, rel)
        require(path.is_file(), f"capture artifact {rel} is missing")
        require(sha256_file(path) == expected_hash, f"capture artifact {rel} is stale or differs from CAPTURE_REVIEW.json")
        if path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            validate_image_dimensions(rel, path)
        paths[rel] = path

    canonical_srt_bytes = paths[SRT_REL].read_bytes()
    expected_srt_bytes = expected_srt(beats).encode("utf-8")
    require(canonical_srt_bytes == expected_srt_bytes, "measured SRT bytes do not exactly match the canonical ten-beat frame timeline")
    canonical_srt = canonical_srt_bytes.decode("utf-8")
    require(BEARER.search(canonical_srt) is None and EMAIL.search(canonical_srt) is None, "measured SRT contains secret-shaped content")
    return review, paths, normalized


def validate_deploy_state(path: Path, expected_sha: str) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    require(expected_sha in text, "DEPLOY_STATE.md does not identify the expected runtime SHA")
    match = re.search(r"\*\*Status:\s*([^*]+)\*\*", text, re.IGNORECASE)
    require(match is not None, "DEPLOY_STATE.md has no machine-readable Status line")
    status = match.group(1).strip().upper()
    require(not any(word in status for word in ("REDEPLOY", "REQUIRED", "RED", "BLOCKED", "PENDING")), "DEPLOY_STATE.md release status is not green")
    require(any(word in status for word in ("READY", "VERIFIED", "SUCCESS")), "DEPLOY_STATE.md status does not explicitly say ready, verified, or success")


def validate_claim_matrix(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    for snippet in REQUIRED_CLAIM_SNIPPETS:
        require(snippet in text, f"claim/evidence matrix no longer supports the final evidence card: {snippet}")


def validate_exact_release(
    expected_sha: str,
    review: dict[str, Any],
    deployment_output: Path,
    deployment_status: Path,
    deploy_state: Path,
) -> tuple[str, str]:
    require(SHA40.fullmatch(expected_sha) is not None, "--expected-sha must be 40 lowercase hex characters")
    require(git_success("cat-file", "-e", f"{expected_sha}^{{commit}}"), "expected runtime SHA is absent from this repository")
    ensure_ignored_untracked(deployment_output, "deployment output")
    ensure_ignored_untracked(deployment_status, "deployment status")

    status = load_json(deployment_status, "deployment status")
    require(isinstance(status, dict), "deployment status must be a JSON object")
    require(status.get("memorySha") == expected_sha, "deployment status records a different MemoryAgent SHA")
    require(status.get("status") == "Success", "deployment status is not Success")
    require(status.get("terminal") is True and status.get("exitCode") == 0, "deployment invocation is not a successful terminal run")
    require(status.get("outputCaptured") is True and status.get("projectContained") is True, "deployment evidence is incomplete or not project-contained")

    output = deployment_output.read_text(encoding="utf-8", errors="replace")
    escaped = re.escape(expected_sha)
    require(re.search(rf"^EXACT_CHECKOUT_OK app=memoryagent sha={escaped}$", output, re.MULTILINE) is not None, "deployment output has no exact checkout marker")
    require(re.search(rf"^EXACT_APP_(?:DEPLOY|REUSE)_OK app=memoryagent sha={escaped}(?:\s|$)", output, re.MULTILINE) is not None, "deployment output has no exact app success marker")
    require(re.search(rf"^EXACT_DEPLOY_SUCCESS memory={escaped}\s", output, re.MULTILINE) is not None, "deployment output has no final exact-deploy success marker")
    validate_deploy_state(deploy_state, expected_sha)

    capture_head = review.get("submissionPackHeadAtCapture")
    require(isinstance(capture_head, str) and SHA40.fullmatch(capture_head), "capture review submission head is invalid")
    require(git_success("cat-file", "-e", f"{capture_head}^{{commit}}"), "capture review submission head is absent locally")
    current_head = git("rev-parse", "HEAD")
    require(SHA40.fullmatch(current_head) is not None, "current HEAD is invalid")
    require(git_success("merge-base", "--is-ancestor", expected_sha, capture_head), "exact runtime is not an ancestor of the captured submission head")
    require(git_success("merge-base", "--is-ancestor", expected_sha, current_head), "exact runtime is not an ancestor of current HEAD")
    require(git_success("merge-base", "--is-ancestor", capture_head, current_head), "local checkout is older than or unrelated to the captured submission head")

    later = [line for line in git("diff", "--name-only", f"{capture_head}..{current_head}").splitlines() if line]
    unsafe_later = [path for path in later if not allowed_submission_path(path)]
    require(not unsafe_later, f"runtime-affecting path changed after capture: {unsafe_later[0] if unsafe_later else ''}")
    unsafe_dirty = [path for path in sorted(working_tree_paths()) if not allowed_submission_path(path)]
    require(not unsafe_dirty, f"runtime-affecting working-tree path makes the capture stale: {unsafe_dirty[0] if unsafe_dirty else ''}")
    return capture_head, current_head


def validate_inputs(
    *,
    expected_sha: str,
    capture_review: Path,
    artifact_root: Path,
    deployment_output: Path,
    deployment_status: Path,
    deploy_state: Path,
    beats: Sequence[Beat] = BEATS,
    production_mode: bool = True,
) -> ValidatedInputs:
    review, artifact_paths, artifact_hashes = validate_capture_review(capture_review, artifact_root, expected_sha, beats)
    capture_head, current_head = validate_exact_release(expected_sha, review, deployment_output, deployment_status, deploy_state)
    claim_matrix = project_path(CLAIM_MATRIX_REL, "claim/evidence matrix", must_exist=True)
    validate_claim_matrix(claim_matrix)
    if production_mode:
        ensure_clean_tracked(project_path("demo/tools/build_caption_video.py", "caption video builder", must_exist=True), "caption video builder")
        ensure_clean_tracked(claim_matrix, "claim/evidence matrix")
        ensure_clean_tracked(deploy_state, "deployment state")
    return ValidatedInputs(
        exact_runtime_sha=expected_sha,
        capture_head=capture_head,
        current_head=current_head,
        captured_at=str(review["capturedAt"]),
        live_base_url=str(review["liveBaseUrl"]),
        capture_review_path=capture_review,
        deploy_state_path=deploy_state,
        deployment_output_path=deployment_output,
        deployment_status_path=deployment_status,
        claim_matrix_path=claim_matrix,
        artifact_paths=artifact_paths,
        artifact_hashes=artifact_hashes,
    )


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    # Pillow's bundled default is rasterized into project-owned frames. No font file
    # is copied or embedded into the MP4, and the build has no external font input.
    return ImageFont.load_default(size=size)


def fit_text(draw: ImageDraw.ImageDraw, text: str, max_width: int, max_lines: int) -> tuple[ImageFont.ImageFont, list[str]]:
    for size in range(46, 29, -2):
        candidate_font = font(size)
        words = text.split()
        lines: list[str] = []
        current = ""
        for word in words:
            proposed = f"{current} {word}".strip()
            width = draw.textbbox((0, 0), proposed, font=candidate_font)[2]
            if current and width > max_width:
                lines.append(current)
                current = word
            else:
                current = proposed
        if current:
            lines.append(current)
        if len(lines) <= max_lines and all(draw.textbbox((0, 0), line, font=candidate_font)[2] <= max_width for line in lines):
            return candidate_font, lines
    raise GateError("caption cannot fit the 1080p safe area")


def place_contained(canvas: Image.Image, source_path: Path, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    with Image.open(source_path) as source:
        fitted = ImageOps.contain(source.convert("RGB"), (x1 - x0, y1 - y0), Image.Resampling.LANCZOS)
    x = x0 + (x1 - x0 - fitted.width) // 2
    y = y0 + (y1 - y0 - fitted.height) // 2
    canvas.paste(fitted, (x, y))


def draw_panel(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], *, fill: str = "#0d211b", outline: str = "#315e4e") -> None:
    draw.rounded_rectangle(box, radius=22, fill=fill, outline=outline, width=3)


def render_title(canvas: Image.Image, draw: ImageDraw.ImageDraw, source_path: Path, live_base_url: str) -> None:
    with Image.open(source_path) as source:
        background = ImageOps.fit(source.convert("RGB"), CANVAS, Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(7))
    overlay = Image.new("RGBA", CANVAS, (2, 15, 11, 190))
    canvas.paste(Image.alpha_composite(background.convert("RGBA"), overlay).convert("RGB"), (0, 0))
    draw.rectangle((0, 0, CANVAS[0], 10), fill="#34d399")
    draw.rounded_rectangle((730, 155, 1190, 215), radius=25, fill="#103b2c", outline="#50e3a4", width=2)
    draw.text((960, 185), "QWEN CLOUD · TRACK 1", anchor="mm", font=font(25), fill="#d9fff0")
    draw.text((960, 338), "ARCHON", anchor="mm", font=font(74), fill="#ffffff")
    draw.text((960, 430), "MEMORYAGENT", anchor="mm", font=font(88), fill="#50e3a4")
    draw.text((960, 514), "Memory that challenges its own contradictions", anchor="mm", font=font(31), fill="#d9e9e2")
    draw.text((960, 590), f"Track 1 · {live_base_url} · public MIT source", anchor="mm", font=font(23), fill="#a8c7ba")


def render_evidence(draw: ImageDraw.ImageDraw) -> None:
    draw.text((960, 145), "DEVELOPER-LABELLED SYNTHETIC / OFFLINE FIXTURES", anchor="mm", font=font(30), fill="#ffc86a")
    cards = (
        ((90, 210, 925, 425), "FIELD SELF-AUDIT", "5/5 issues detected · 0 FP"),
        ((995, 210, 1830, 425), "DECLARED POLICY", "4/4 conformance cases"),
        ((90, 465, 925, 705), "DETERMINISTIC SEMANTIC SET", "90% recall · 100% precision · 0 FP"),
        ((995, 465, 1830, 705), "DISCLOSED RETRIEVAL FIXTURE", "MRR 0.883 -> 0.911\nRecall@3 90.0% -> 96.7%"),
    )
    for box, heading, value in cards:
        draw_panel(draw, box, fill="#102820", outline="#3f876a")
        draw.text(((box[0] + box[2]) // 2, box[1] + 52), heading, anchor="mm", font=font(23), fill="#91d9bb")
        values = value.splitlines()
        for index, line in enumerate(values):
            draw.text(((box[0] + box[2]) // 2, box[1] + 135 + index * 48), line, anchor="mm", font=font(35), fill="#ffffff")
    draw.text((960, 752), "NOT PRODUCTION ACCURACY · NOT INDEPENDENT EVALUATION", anchor="mm", font=font(25), fill="#ffb4a8")


def render_beat_frame(
    beat: Beat,
    inputs: ValidatedInputs,
    output: Path,
    *,
    self_test_label: bool = False,
) -> None:
    canvas = Image.new("RGB", CANVAS, "#071510")
    draw = ImageDraw.Draw(canvas)
    if beat.treatment == "title":
        render_title(canvas, draw, inputs.artifact_paths[beat.visuals[0]], inputs.live_base_url)
    else:
        draw.rectangle((0, 0, CANVAS[0], 10), fill="#34d399")
        draw.text((58, 51), f"BEAT {beat.number:02d} / {len(BEATS):02d}", anchor="lm", font=font(23), fill="#65e6ae")
        draw.text((285, 51), beat.title, anchor="lm", font=font(35), fill="#ffffff")
        draw.text((1860, 51), "CAPTION-LED · NO VOICE", anchor="rm", font=font(21), fill="#9eb8ad")
        if beat.treatment == "evidence":
            render_evidence(draw)
        elif len(beat.visuals) == 1:
            box = (70, 120, 1850, 770)
            draw_panel(draw, box, fill="#091b15")
            place_contained(canvas, inputs.artifact_paths[beat.visuals[0]], (85, 135, 1835, 755))
            if beat.labels:
                draw.rounded_rectangle((110, 680, 1810, 748), radius=18, fill="#071510", outline="#3b755e", width=2)
                draw.text((960, 714), beat.labels[0], anchor="mm", font=font(25), fill="#d8eee5")
        else:
            boxes = ((55, 125, 940, 765), (980, 125, 1865, 765))
            for index, (visual, box) in enumerate(zip(beat.visuals, boxes)):
                draw_panel(draw, box, fill="#091b15")
                place_contained(canvas, inputs.artifact_paths[visual], (box[0] + 14, box[1] + 14, box[2] - 14, box[3] - 74))
                label = beat.labels[index] if index < len(beat.labels) else Path(visual).stem
                draw.text(((box[0] + box[2]) // 2, box[3] - 38), label, anchor="mm", font=font(22), fill="#d8eee5")

    caption_box = (55, 805, 1865, 1038)
    draw.rounded_rectangle(caption_box, radius=28, fill="#06110e", outline="#3d7b62", width=3)
    caption_font, lines = fit_text(draw, beat.caption, 1690, 3)
    line_height = max(46, caption_font.getbbox("Ag")[3] - caption_font.getbbox("Ag")[1] + 12)
    total_height = len(lines) * line_height
    y = caption_box[1] + (caption_box[3] - caption_box[1] - total_height) // 2
    for line in lines:
        draw.text((960, y), line, anchor="ma", font=caption_font, fill="#ffffff")
        y += line_height
    draw.text((58, 1067), f"Exact runtime {inputs.exact_runtime_sha[:12]} · hash-bound sanitized inputs", anchor="lm", font=font(18), fill="#759487")
    draw.text((1862, 1067), "Procedural digital silence · burned English captions", anchor="rm", font=font(18), fill="#759487")
    if self_test_label:
        draw.rounded_rectangle((650, 12, 1270, 40), radius=12, fill="#a71919", outline="#ff8b8b", width=1)
        draw.text((960, 26), "SYNTHETIC SELF-TEST - NOT SUBMISSION EVIDENCE", anchor="mm", font=font(15), fill="#ffffff")

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True)
    with Image.open(output) as check:
        require(check.size == CANVAS, f"rendered beat {beat.number} is not 1920x1080")


def find_binary(name: str) -> str:
    resolved = shutil.which(name)
    require(resolved is not None, f"required executable {name} is unavailable")
    return str(resolved)


def binary_version(name: str) -> str:
    result = subprocess.run(
        [find_binary(name), "-version"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    first_line = result.stdout.splitlines()[0].strip() if result.stdout.splitlines() else ""
    require(result.returncode == 0 and first_line, f"could not identify {name} version")
    return first_line


def encode_video(frame_paths: Sequence[Path], beats: Sequence[Beat], output: Path, scratch: Path) -> None:
    ffmpeg = find_binary("ffmpeg")
    require(len(frame_paths) == len(beats) and frame_paths, "video frame/beat inventory is incomplete")
    concat_path = scratch / "caption-video.ffconcat"
    lines = ["ffconcat version 1.0"]
    for frame_path, beat in zip(frame_paths, beats):
        require(frame_path.parent == scratch, "rendered beat escaped the build scratch directory")
        lines.append(f"file '{frame_path.name}'")
        lines.append(f"duration {beat.seconds:.6f}")
    lines.append(f"file '{frame_paths[-1].name}'")
    concat_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

    total_seconds = sum(beat.seconds for beat in beats)
    total_frames = total_seconds * FPS
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_path),
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        f"fps={FPS},scale=1920:1080:flags=lanczos,format=yuv420p",
        "-frames:v",
        str(total_frames),
        "-t",
        str(total_seconds),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(FPS),
        "-g",
        str(FPS * 2),
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-shortest",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        str(output),
    ]
    result = subprocess.run(command, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    (scratch / "ffmpeg.stderr.log").write_bytes(result.stderr)
    require(result.returncode == 0 and output.is_file() and output.stat().st_size > 1024, f"ffmpeg encode failed (exit {result.returncode}); inspect the repo-local scratch log")


def decoded_audio_peak(path: Path) -> int:
    ffmpeg = find_binary("ffmpeg")
    process = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path), "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    require(process.stdout is not None, "failed to open decoded audio stream")
    peak = 0
    remainder = b""
    while True:
        chunk = process.stdout.read(1024 * 1024)
        if not chunk:
            break
        chunk = remainder + chunk
        remainder = chunk[-1:] if len(chunk) % 2 else b""
        usable = chunk[:-1] if remainder else chunk
        samples = array("h")
        samples.frombytes(usable)
        if sys.byteorder != "little":
            samples.byteswap()
        if samples:
            peak = max(peak, abs(min(samples)), abs(max(samples)))
    stderr = process.stderr.read() if process.stderr is not None else b""
    return_code = process.wait()
    require(return_code == 0 and not remainder, f"silent-audio verification failed (exit {return_code})")
    require(not stderr, "silent-audio verification emitted an ffmpeg error")
    return peak


def probe_video(path: Path, expected_seconds: int) -> dict[str, Any]:
    ffprobe = find_binary("ffprobe")
    result = subprocess.run(
        [ffprobe, "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    require(result.returncode == 0, f"ffprobe failed (exit {result.returncode})")
    try:
        probe = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GateError("ffprobe did not return JSON") from exc
    streams = probe.get("streams")
    require(isinstance(streams, list), "ffprobe returned no streams")
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    audios = [stream for stream in streams if stream.get("codec_type") == "audio"]
    others = [stream for stream in streams if stream.get("codec_type") not in {"video", "audio"}]
    require(len(videos) == 1 and len(audios) == 1 and not others, "final MP4 must contain exactly one video and one audio stream")
    video, audio = videos[0], audios[0]
    require(video.get("codec_name") == "h264", "final video codec is not H.264")
    require(video.get("width") == 1920 and video.get("height") == 1080, "final video is not 1920x1080")
    require(video.get("pix_fmt") == "yuv420p", "final video pixel format is not yuv420p")
    require(video.get("avg_frame_rate") == f"{FPS}/1", "final video frame rate is not exactly 30 fps")
    frame_count = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)
    require(frame_count == expected_seconds * FPS, "final video frame count differs from the deterministic timeline")
    require(audio.get("codec_name") == "aac", "final audio codec is not AAC")
    require(audio.get("sample_rate") == "48000" and audio.get("channels") == 2, "final silent audio is not 48 kHz stereo")
    duration = float(probe.get("format", {}).get("duration", 0.0))
    require(abs(duration - expected_seconds) <= max(0.05, 2 / FPS), "measured MP4 duration differs from the frame timeline")
    require(duration < STRICT_LIMIT_SECONDS, "measured MP4 duration reaches the 175-second safety ceiling")
    probe_text = json.dumps(probe, ensure_ascii=False)
    require(BEARER.search(probe_text) is None and EMAIL.search(probe_text) is None and PRIVATE_IPV4.search(probe_text) is None, "final MP4 metadata contains sensitive-shaped content")
    peak = decoded_audio_peak(path)
    require(peak <= 4, f"audio track is not digital silence (decoded peak {peak})")
    return {
        "durationSeconds": duration,
        "frameCount": frame_count,
        "fps": FPS,
        "width": int(video["width"]),
        "height": int(video["height"]),
        "videoCodec": str(video["codec_name"]),
        "pixelFormat": str(video["pix_fmt"]),
        "audioCodec": str(audio["codec_name"]),
        "audioSampleRate": int(audio["sample_rate"]),
        "audioChannels": int(audio["channels"]),
        "decodedAudioPeakS16": peak,
    }


def atomic_write_text(path: Path, content: str, scratch: Path) -> None:
    temp = scratch / f".{path.name}.writing"
    temp.write_text(content, encoding="utf-8", newline="\n")
    path.parent.mkdir(parents=True, exist_ok=True)
    os.replace(temp, path)


def timeline_manifest(beats: Sequence[Beat]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor = 0
    for beat in beats:
        end = cursor + beat.seconds
        rows.append(
            {
                "beat": beat.number,
                "title": beat.title,
                "startSeconds": cursor,
                "endSeconds": end,
                "frames": beat.seconds * FPS,
                "caption": beat.caption,
                "visualInputs": list(beat.visuals),
            }
        )
        cursor = end
    return rows


def build_video(
    inputs: ValidatedInputs,
    *,
    output: Path,
    srt_path: Path,
    manifest_path: Path,
    scratch: Path,
    beats: Sequence[Beat] = BEATS,
    self_test_label: bool = False,
) -> dict[str, Any]:
    total_seconds = sum(beat.seconds for beat in beats)
    require(total_seconds < STRICT_LIMIT_SECONDS, "caption timeline reaches the 175-second ceiling")
    if beats is BEATS:
        require(total_seconds == EXPECTED_TOTAL_SECONDS, "canonical timeline is not exactly 172 seconds")
    require(output.suffix.lower() == ".mp4" and manifest_path.suffix.lower() == ".json", "final output extensions must be .mp4 and .json")
    require(srt_path.suffix.lower() == ".srt", "subtitle output extension must be .srt")
    require(len({output, srt_path, manifest_path, scratch}) == 4, "output, SRT, manifest, and scratch paths must be distinct")

    scratch.mkdir(parents=True, exist_ok=True)
    frame_paths: list[Path] = []
    for beat in beats:
        frame_path = scratch / f"beat-{beat.number:02d}.png"
        render_beat_frame(beat, inputs, frame_path, self_test_label=self_test_label)
        frame_paths.append(frame_path)

    temporary_video = scratch / "memoryagent-caption-video.rendering.mp4"
    if temporary_video.exists():
        temporary_video.unlink()
    encode_video(frame_paths, beats, temporary_video, scratch)
    technical = probe_video(temporary_video, total_seconds)

    # The gallery gate has already hash-bound this exact SRT. Re-emit only the same
    # bytes after video verification; a mismatch was rejected before any build write.
    atomic_write_text(srt_path, expected_srt(beats), scratch)
    output.parent.mkdir(parents=True, exist_ok=True)
    os.replace(temporary_video, output)

    manifest = {
        "schemaVersion": 2,
        "status": "passed",
        "builder": "memoryagent-caption-led-ten-beat-v2",
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "exactRuntimeSource": inputs.exact_runtime_sha,
        "captureSubmissionHead": inputs.capture_head,
        "builderSourceHead": inputs.current_head,
        "builderSource": {
            "path": "demo/tools/build_caption_video.py",
            "sha256": sha256_file(REPO / "demo" / "tools" / "build_caption_video.py"),
        },
        "captureReview": {
            "path": relative_repo_path(inputs.capture_review_path),
            "sha256": sha256_file(inputs.capture_review_path),
            "capturedAt": inputs.captured_at,
            "liveBaseUrl": inputs.live_base_url,
        },
        "releaseEvidence": {
            "deployState": {"path": relative_repo_path(inputs.deploy_state_path), "sha256": sha256_file(inputs.deploy_state_path)},
            "deploymentStatus": {"path": relative_repo_path(inputs.deployment_status_path), "sha256": sha256_file(inputs.deployment_status_path)},
            "deploymentOutput": {"path": relative_repo_path(inputs.deployment_output_path), "sha256": sha256_file(inputs.deployment_output_path)},
            "claimEvidenceMatrix": {"path": relative_repo_path(inputs.claim_matrix_path), "sha256": sha256_file(inputs.claim_matrix_path)},
            "architectureBinding": {
                "source": {"path": ARCHITECTURE_SOURCE_REL, "sha256": sha256_file(REPO / ARCHITECTURE_SOURCE_REL)},
                "raster": {"path": ARCHITECTURE_REL, "sha256": inputs.artifact_hashes[ARCHITECTURE_REL]},
            },
        },
        "timeline": {
            "fps": FPS,
            "strictLimitSeconds": STRICT_LIMIT_SECONDS,
            "plannedDurationSeconds": total_seconds,
            "measuredDurationSeconds": technical["durationSeconds"],
            "totalFrames": total_seconds * FPS,
            "beats": timeline_manifest(beats),
        },
        "rightsSafeAudio": {
            "voiceUsed": False,
            "ttsUsed": False,
            "musicUsed": False,
            "mode": "ffmpeg-generated-digital-silence",
            "decodedPeakS16": technical["decodedAudioPeakS16"],
        },
        "toolVersions": {
            "python": sys.version.split()[0],
            "pillow": Image.__version__,
            "ffmpeg": binary_version("ffmpeg"),
            "ffprobe": binary_version("ffprobe"),
        },
        "visualInputContract": "human-reviewed, sanitized, CAPTURE_REVIEW SHA-256-bound project artifacts only",
        "claimLocks": {
            "businessData": "original synthetic demo data",
            "benchmarks": "developer-labelled synthetic/offline fixtures; not production accuracy or independent evaluation",
            "comparativeClaim": "no universal superiority claim",
            "auditBoundary": "detects disagreement and recommends; human decision is separate; no silent rewrite",
            "retrievalBoundary": "proof frame may show pure cosine; product default remains hybrid",
            "visionBoundary": "original synthetic two-PNG qwen-vl-max dry-run; one fused event; zero writes and zero marker residue; not raw-PDF parsing",
            "feedbackBoundary": "explicit persisted feedback applied in a fresh authenticated session; not training, autonomous learning, or model-weight update",
            "humanControlBoundary": "live proof exercises Defer only with zero API call or write; Accept and Override remain unexercised",
            "lifecycleBoundary": "one feedback-superseded synthetic candidate previewed and deleted; protected state unchanged; zero residue; not age-expired",
            "topologyBoundary": "Alibaba ECS plus self-hosted pgvector is active; Function Compute/RDS is alternative-only",
        },
        "inputs": inputs.artifact_hashes,
        "outputs": {
            "video": {"path": relative_repo_path(output), "sha256": sha256_file(output), **technical},
            "subtitles": {"path": relative_repo_path(srt_path), "sha256": sha256_file(srt_path), "entries": len(beats), "timing": "frame-exact"},
        },
    }
    atomic_write_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", scratch)
    return manifest


def safe_reset_selftest_root(root: Path) -> None:
    resolved = root.resolve()
    rel = resolved.relative_to(REPO)
    require(rel.parts[:2] == (".artifacts", "caption-video-selftest"), "self-test cleanup target is not the dedicated repo-local scratch root")
    if resolved.exists():
        require(not resolved.is_symlink(), "self-test root must not be a symlink")
        shutil.rmtree(resolved)


def make_fixture_image(path: Path, size: tuple[int, int], label: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", size, "#0b211a")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, size[0], max(12, size[1] // 50)), fill="#34d399")
    draw.text((size[0] // 2, size[1] // 2 - 30), "SYNTHETIC SELF-TEST", anchor="mm", font=font(max(24, size[0] // 30)), fill="#ffffff")
    draw.text((size[0] // 2, size[1] // 2 + 40), "NOT LIVE OR SUBMISSION EVIDENCE", anchor="mm", font=font(max(18, size[0] // 50)), fill="#ffb4a8")
    draw.text((size[0] // 2, size[1] - 50), label, anchor="mm", font=font(max(15, size[0] // 70)), fill="#9acbb7")
    image.save(path, format="JPEG" if path.suffix.lower() in {".jpg", ".jpeg"} else "PNG")


def self_test(*, full_duration: bool = False) -> int:
    root = project_path(".artifacts/caption-video-selftest", "self-test root")
    safe_reset_selftest_root(root)
    fixture_root = root / "fixture-root"
    fixture_root.mkdir(parents=True)
    test_beats = BEATS if full_duration else tuple(replace(beat, seconds=1) for beat in BEATS)

    artifact_hashes: dict[str, str] = {}
    for rel in GALLERY_RELS:
        path = fixture_root / rel
        make_fixture_image(path, GALLERY_CANVAS, rel)
        artifact_hashes[rel] = sha256_file(path)
    for rel in PROOF_RELS:
        path = fixture_root / rel
        make_fixture_image(path, CANVAS, rel)
        artifact_hashes[rel] = sha256_file(path)
    architecture = fixture_root / ARCHITECTURE_REL
    make_fixture_image(architecture, (1600, 900), ARCHITECTURE_REL)
    artifact_hashes[ARCHITECTURE_REL] = sha256_file(architecture)
    srt_path = fixture_root / SRT_REL
    srt_path.parent.mkdir(parents=True, exist_ok=True)
    srt_path.write_text(expected_srt(test_beats), encoding="utf-8", newline="\n")
    artifact_hashes[SRT_REL] = sha256_file(srt_path)
    thumbnail_rel = "demo/final-media/youtube-thumbnail.png"
    thumbnail = fixture_root / thumbnail_rel
    make_fixture_image(thumbnail, (1280, 720), thumbnail_rel)
    artifact_hashes[thumbnail_rel] = sha256_file(thumbnail)

    current_head = git("rev-parse", "HEAD")
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    capture_review = root / "CAPTURE_REVIEW.selftest.json"
    architecture_source = project_path(ARCHITECTURE_SOURCE_REL, "architecture source", must_exist=True)
    review_payload = {
        "schemaVersion": 2,
        "status": "passed",
        "capturedAt": now,
        "liveBaseUrl": "https://self-test.invalid",
        "exactRuntimeSource": current_head,
        "submissionPackHeadAtCapture": current_head,
        "models": {
            "embedder": EXPECTED_EMBEDDER,
            "narrator": EXPECTED_NARRATOR,
            "judge": "qwen-plus",
            "vision": EXPECTED_VISION,
            "embedDim": EXPECTED_EMBED_DIM,
        },
        "gates": {
            **REQUIRED_BOOLEAN_GATES,
            "qwenVlOriginalSyntheticDryRun": {
                "modelIdReported": EXPECTED_VISION,
                "written": 0,
                "reviewerCountUnchanged": True,
                "uniquePrefixResidue": 0,
            },
            "feedbackPersistence": {
                "sessionAStoredCorrection": True,
                "freshSessionBRecalledCorrection": True,
                "freshSessionBAppliedPreference": True,
                "boundary": "explicit persisted feedback; no model-weight update",
            },
            "lifecycleOneRow": {
                "retentionBasis": "feedback-superseded original synthetic fact",
                "previewCandidates": 1,
                "confirmedForgotten": 1,
                "protectedSeedUnchanged": True,
                "protectedCorrectionUnchanged": True,
                "postProofCleanupApplied": True,
                "uniquePrefixResidue": 0,
            },
            "humanControlCapture": "Defer-only live proof; Accept/Override are not claimed by this frame",
        },
        "architecture": {
            "sourcePath": ARCHITECTURE_SOURCE_REL,
            "sourceSha256": sha256_file(architecture_source),
            "rasterPath": ARCHITECTURE_REL,
            "rasterSha256": artifact_hashes[ARCHITECTURE_REL],
        },
        "subtitleTimingSource": "measured-caption-windows",
        "artifacts": artifact_hashes,
    }
    capture_review.write_text(json.dumps(review_payload, indent=2) + "\n", encoding="utf-8")
    deployment_status = root / "exact-deploy-status.selftest.json"
    deployment_status.write_text(
        json.dumps({"memorySha": current_head, "status": "Success", "terminal": True, "exitCode": 0, "outputCaptured": True, "projectContained": True}, indent=2) + "\n",
        encoding="utf-8",
    )
    deployment_output = root / "exact-deploy-output.selftest.txt"
    deployment_output.write_text(
        f"EXACT_CHECKOUT_OK app=memoryagent sha={current_head}\n"
        f"EXACT_APP_DEPLOY_OK app=memoryagent sha={current_head}\n"
        f"EXACT_DEPLOY_SUCCESS memory={current_head} synthetic_selftest=true\n",
        encoding="utf-8",
    )
    deploy_state = root / "DEPLOY_STATE.selftest.md"
    deploy_state.write_text(f"# Synthetic self-test only\n\n> **Status: LIVE VERIFIED — READY**\n\nExact runtime `{current_head}`.\n", encoding="utf-8")

    inputs = validate_inputs(
        expected_sha=current_head,
        capture_review=capture_review,
        artifact_root=fixture_root,
        deployment_output=deployment_output,
        deployment_status=deployment_status,
        deploy_state=deploy_state,
        beats=test_beats,
        production_mode=False,
    )
    output_dir = root / "output"
    output_stem = "FULL-172S-SELF-TEST-NOT-SUBMISSION-EVIDENCE" if full_duration else "SELF-TEST-NOT-SUBMISSION-EVIDENCE"
    manifest = build_video(
        inputs,
        output=output_dir / f"{output_stem}.mp4",
        srt_path=srt_path,
        manifest_path=output_dir / f"{output_stem}.manifest.json",
        scratch=root / "build-scratch",
        beats=test_beats,
        self_test_label=True,
    )
    require(manifest["outputs"]["video"]["frameCount"] == sum(beat.seconds for beat in test_beats) * FPS, "self-test frame-count assertion failed")
    require(manifest["rightsSafeAudio"]["decodedPeakS16"] <= 4, "self-test silence assertion failed")

    bad_boundary = root / "CAPTURE_REVIEW.bad-feedback-boundary.json"
    bad_boundary_payload = json.loads(capture_review.read_text(encoding="utf-8"))
    bad_boundary_payload["gates"]["feedbackPersistence"]["boundary"] = "autonomous learning"
    bad_boundary.write_text(json.dumps(bad_boundary_payload, indent=2) + "\n", encoding="utf-8")
    try:
        validate_capture_review(bad_boundary, fixture_root, current_head, test_beats)
    except GateError as exc:
        require("no-learning boundary" in str(exc), "self-test feedback-boundary rejection was not explicit")
    else:
        raise GateError("self-test accepted an autonomous-learning claim boundary")

    bad_review = root / "CAPTURE_REVIEW.bad-hash.json"
    bad_payload = json.loads(capture_review.read_text(encoding="utf-8"))
    bad_payload["artifacts"][PROOF_RELS[0]] = "0" * 64
    bad_review.write_text(json.dumps(bad_payload, indent=2) + "\n", encoding="utf-8")
    try:
        validate_capture_review(bad_review, fixture_root, current_head, test_beats)
    except GateError as exc:
        require("stale" in str(exc), "self-test bad-hash rejection was not explicit")
    else:
        raise GateError("self-test accepted a stale proof-frame hash")

    bad_url = root / "CAPTURE_REVIEW.bad-url.json"
    bad_url_payload = json.loads(capture_review.read_text(encoding="utf-8"))
    bad_url_payload["liveBaseUrl"] = "https://reviewer:secret@self-test.invalid/path?token=secret"
    bad_url.write_text(json.dumps(bad_url_payload, indent=2) + "\n", encoding="utf-8")
    try:
        validate_capture_review(bad_url, fixture_root, current_head, test_beats)
    except GateError as exc:
        require("credential-free HTTPS origin" in str(exc), "self-test unsafe-origin rejection was not explicit")
    else:
        raise GateError("self-test accepted credentials/path/query in the public origin")

    bad_traversal = root / "CAPTURE_REVIEW.bad-traversal.json"
    bad_traversal_payload = json.loads(capture_review.read_text(encoding="utf-8"))
    bad_traversal_payload["artifacts"]["demo/gallery/../../.gitignore"] = "0" * 64
    bad_traversal.write_text(json.dumps(bad_traversal_payload, indent=2) + "\n", encoding="utf-8")
    try:
        validate_capture_review(bad_traversal, fixture_root, current_head, test_beats)
    except GateError as exc:
        require("traversal" in str(exc), "self-test traversal rejection was not explicit")
    else:
        raise GateError("self-test accepted traversal in a capture artifact path")

    original_srt_bytes = srt_path.read_bytes()
    crlf_srt_bytes = expected_srt(test_beats).replace("\n", "\r\n").encode("utf-8")
    srt_path.write_bytes(crlf_srt_bytes)
    bad_srt = root / "CAPTURE_REVIEW.bad-srt-bytes.json"
    bad_srt_payload = json.loads(capture_review.read_text(encoding="utf-8"))
    bad_srt_payload["artifacts"][SRT_REL] = sha256_file(srt_path)
    bad_srt.write_text(json.dumps(bad_srt_payload, indent=2) + "\n", encoding="utf-8")
    try:
        validate_capture_review(bad_srt, fixture_root, current_head, test_beats)
    except GateError as exc:
        require("SRT bytes" in str(exc), "self-test SRT byte-mismatch rejection was not explicit")
    else:
        raise GateError("self-test accepted non-canonical SRT line-ending bytes")
    finally:
        srt_path.write_bytes(original_srt_bytes)

    outside = REPO.parent / f"memoryagent-caption-selftest-escape-{os.getpid()}"
    require(not outside.exists(), "self-test outside sentinel unexpectedly exists")
    try:
        project_path(outside, "self-test escape")
    except GateError:
        pass
    else:
        raise GateError("self-test accepted an output path outside the repository")
    require(not outside.exists(), "path rejection created an outside artifact")
    duration_label = "172 seconds / 5,160 frames" if full_duration else "10 seconds / 300 frames"
    print(f"caption video self-test: PASS · {duration_label} · digital silence · claim-boundary/hash/origin/SRT/path gates")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--self-test", action="store_true", help="run an offline 10-second synthetic compositor/gate test under ignored .artifacts")
    action.add_argument("--full-self-test", action="store_true", help="run the complete synthetic 172-second/5,160-frame acceptance encode under ignored .artifacts")
    action.add_argument("--emit-caption-windows", metavar="PATH", help="write the canonical 172-second caption_windows.json plan inside the repository")
    parser.add_argument("--expected-sha", help="40-character exact deployed MemoryAgent runtime SHA")
    parser.add_argument("--deployment-output", help="ignored repo-local exact deployment decoded output")
    parser.add_argument("--deployment-status", help="ignored repo-local sanitized exact deployment status JSON")
    parser.add_argument("--output", default=DEFAULT_OUTPUT_REL, help="repo-contained final MP4 path")
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST_REL, help="repo-contained final build manifest path")
    parser.add_argument("--scratch", default=DEFAULT_SCRATCH_REL, help="repo-contained ignored build scratch directory")
    parser.add_argument("--check-only", action="store_true", help="validate every final input without invoking ffmpeg")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            return self_test()
        if args.full_self_test:
            return self_test(full_duration=True)
        if args.emit_caption_windows:
            path = project_path(args.emit_caption_windows, "caption windows output")
            rel = relative_repo_path(path)
            require(rel.startswith(".artifacts/") and path.suffix.lower() == ".json", "caption windows output must be a .json file under ignored .artifacts/")
            write_caption_windows(path)
            print(f"caption timeline: PASS · 10 beats · 172 seconds · {relative_repo_path(path)}")
            return 0

        require(args.expected_sha is not None, "--expected-sha is required")
        require(args.deployment_output is not None and args.deployment_status is not None, "--deployment-output and --deployment-status are required")

        # Resolve every path before creating scratch or replacing any output.
        capture_review = project_path(CAPTURE_REVIEW_REL, "capture review", must_exist=True)
        deploy_state = project_path(DEPLOY_STATE_REL, "deployment state", must_exist=True)
        srt_path = project_path(SRT_REL, "measured SRT", must_exist=True)
        deployment_output = project_path(args.deployment_output, "deployment output", must_exist=True)
        deployment_status = project_path(args.deployment_status, "deployment status", must_exist=True)
        output = project_path(args.output, "final MP4 output")
        manifest_path = project_path(args.manifest, "final video manifest")
        scratch = project_path(args.scratch, "caption video scratch")
        require(relative_repo_path(capture_review) == CAPTURE_REVIEW_REL, "production build requires the canonical capture review")
        require(relative_repo_path(deploy_state) == DEPLOY_STATE_REL, "production build requires the canonical deployment state")
        require(relative_repo_path(srt_path) == SRT_REL, "production build requires the canonical measured SRT")
        require(Path(relative_repo_path(output)).parent.as_posix() == "demo/final-media", "final MP4 output must be directly under demo/final-media/")
        require(Path(relative_repo_path(manifest_path)).parent.as_posix() == "demo/final-media", "final video manifest must be directly under demo/final-media/")
        scratch_rel = relative_repo_path(scratch)
        require(scratch_rel.startswith(".artifacts/") and scratch_rel != ".artifacts", "caption video scratch must be a dedicated directory under ignored .artifacts/")

        inputs = validate_inputs(
            expected_sha=str(args.expected_sha).lower(),
            capture_review=capture_review,
            artifact_root=REPO,
            deployment_output=deployment_output,
            deployment_status=deployment_status,
            deploy_state=deploy_state,
        )
        if args.check_only:
            print(f"caption video inputs: PASS · exact runtime {inputs.exact_runtime_sha[:12]} · 11 gallery + 11 proof frames · 10 evidence frames · measured SRT")
            return 0
        manifest = build_video(
            inputs,
            output=output,
            srt_path=srt_path,
            manifest_path=manifest_path,
            scratch=scratch,
        )
        measured = manifest["timeline"]["measuredDurationSeconds"]
        print(f"caption video build: PASS · {measured:.3f}s · 1920x1080 · 30 fps · silent AAC · exact runtime {inputs.exact_runtime_sha[:12]}")
        return 0
    except (GateError, OSError, UnicodeError) as exc:
        print(f"caption video build: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
