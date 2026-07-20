#!/usr/bin/env python3
"""Build the narrated, captioned intermediate for the MemoryAgent submission video.

The production path is deliberately fail closed. It consumes only the canonical,
hash-bound media inventory produced by ``scripts/capture_submission_gallery.py``
and exact-deployment evidence kept inside this repository. It never captures the
live service, synthesizes speech, downloads media, or invents judge-facing proof.

The resulting MP4 is 1920x1080 H.264 at 30 fps with a required, locally generated
synthetic narration track. Every English caption is burned into the picture and
mirrored byte-for-byte in the measured SRT. The ten beat windows are frame-exact
and total 172 seconds.
"""

from __future__ import annotations

import argparse
from array import array
from contextlib import contextmanager
from dataclasses import dataclass, replace
import datetime as dt
import functools
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Iterable, Sequence
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


REPO_HINT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_HINT / "scripts"))
sys.path.insert(0, str(REPO_HINT / "demo" / "tools"))
from build_local_narration import (  # noqa: E402
    DEFAULT_AUDIO_REL as DEFAULT_NARRATION_AUDIO_REL,
    DEFAULT_MANIFEST_REL as DEFAULT_NARRATION_MANIFEST_REL,
    NarrationError,
    canonical_json_sha256,
    create_synthetic_fixture,
    validate_narration_bundle,
)
from exact_deploy_evidence import (  # noqa: E402
    ExactDeployEvidenceError,
    STRICT_FINAL_MARKER,
    TERMINAL_SUCCESS_TRUNCATED_OUTPUT,
    validate_exact_deploy_evidence as _validate_exact_deploy_evidence,
)
from repo_paths import ProjectFileSnapshot, REPO_ROOT, inside_repo, read_project_file_once  # noqa: E402


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
EXPECTED_LIVE_ORIGIN = "https://memory.43.106.13.19.sslip.io"

CAPTURE_REVIEW_REL = "demo/gallery/CAPTURE_REVIEW.json"
DEPLOY_STATE_REL = "deploy/DEPLOY_STATE.md"
CLAIM_MATRIX_REL = "docs/CLAIM_EVIDENCE_MATRIX.md"
SRT_REL = "demo/final-media/memoryagent-demo.en.srt"
ARCHITECTURE_REL = "demo/final-media/judge-architecture.jpg"
ARCHITECTURE_SOURCE_REL = "docs/judge-architecture.svg"
DEFAULT_OUTPUT_REL = ".artifacts/final-caption-video/caption-base.mp4"
DEFAULT_MANIFEST_REL = ".artifacts/final-caption-video/caption-base.manifest.json"
DEFAULT_SCRATCH_REL = ".artifacts/final-caption-video"
TRUSTED_EXECUTABLE_ENV = {
    "git": "MEMORYAGENT_GIT_EXECUTABLE",
    "ffmpeg": "MEMORYAGENT_FFMPEG_EXECUTABLE",
    "ffprobe": "MEMORYAGENT_FFPROBE_EXECUTABLE",
}

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


CAPTION_CONTRACT_REL = "demo/caption-timeline.json"


def load_caption_contract() -> tuple[ProjectFileSnapshot, tuple[tuple[int, int, str], ...]]:
    """Read the inert, tracked timeline once; no executable module is imported."""
    try:
        snapshot = read_project_file_once(CAPTION_CONTRACT_REL, "caption timeline contract")
        raw = json.loads(snapshot.text())
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("caption timeline contract is not stable valid UTF-8 JSON") from exc
    if not isinstance(raw, list) or len(raw) != 10:
        raise RuntimeError("caption timeline contract must contain exactly ten rows")

    rows: list[tuple[int, int, str]] = []
    previous_end = 0
    for index, row in enumerate(raw, start=1):
        if not isinstance(row, list) or len(row) != 3:
            raise RuntimeError(f"caption timeline row {index} has the wrong shape")
        start, end, caption = row
        if type(start) is not int or type(end) is not int or not isinstance(caption, str) or not caption.strip():
            raise RuntimeError(f"caption timeline row {index} has invalid fields")
        if start != previous_end or end <= start:
            raise RuntimeError(f"caption timeline row {index} is not frame-contiguous")
        if caption != caption.strip():
            raise RuntimeError(f"caption timeline row {index} has surrounding whitespace")
        rows.append((start, end, caption))
        previous_end = end
    if rows[0][0] != 0 or rows[-1][1] != EXPECTED_TOTAL_SECONDS:
        raise RuntimeError("caption timeline contract does not cover the exact 172-second final")
    return snapshot, tuple(rows)


CAPTION_CONTRACT_SNAPSHOT, CAPTION_CONTRACT = load_caption_contract()


def beat_from_contract(
    number: int,
    title: str,
    visuals: tuple[str, ...],
    labels: tuple[str, ...] = (),
    *,
    treatment: str = "proof",
) -> Beat:
    start, end, caption = CAPTION_CONTRACT[number - 1]
    return Beat(number, title, end - start, caption, visuals, labels, treatment)


BEATS: tuple[Beat, ...] = (
    beat_from_contract(
        1,
        "Stakes + Track 1",
        (PROOF_RELS[0],),
        treatment="title",
    ),
    beat_from_contract(
        2,
        "Exact live proof + Qwen vision",
        (PROOF_RELS[8], PROOF_RELS[7]),
        ("Live /health + /ready", "Original synthetic qwen-vl-max dry-run"),
    ),
    beat_from_contract(
        3,
        "Architecture + bounded scale path",
        (ARCHITECTURE_REL,),
        ("Evidence -> Qwen -> pgvector -> cited answer -> human decision",),
    ),
    beat_from_contract(
        4,
        "Cross-session memory",
        (PROOF_RELS[0],),
        ("Fresh session · grounded cited recall",),
    ),
    beat_from_contract(
        5,
        "Read-only self-audit + human control",
        (PROOF_RELS[2], PROOF_RELS[4]),
        ("Read-only field audit", "Live Defer only · zero mutation"),
    ),
    beat_from_contract(
        6,
        "Feedback persists across sessions",
        (PROOF_RELS[1],),
        ("Session A correction · fresh Session B cited application",),
    ),
    beat_from_contract(
        7,
        "Meaning-level audit + MCP",
        (PROOF_RELS[3], PROOF_RELS[6]),
        ("Authenticated Qwen meaning audit", "Shared core · four typed MCP tools"),
    ),
    beat_from_contract(
        8,
        "Timely forgetting",
        (PROOF_RELS[5],),
        ("Preview 1 · delete 1 · protect state · residue 0",),
    ),
    beat_from_contract(
        9,
        "Evidence, not hype",
        (),
        treatment="evidence",
    ),
    beat_from_contract(
        10,
        "Alibaba + public-source close",
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
    re.compile(r"^\.github/workflows/(?:demo-video|canonical-final-video)\.yml$"),
)
SHA40 = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
PRODUCER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")
DEPLOY_STATE_RECORD = re.compile(
    r"<!-- MEMORYAGENT_DEPLOY_STATE_V1 status=LIVE_VERIFIED_READY runtime_sha=([0-9a-f]{40}) -->"
)
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+\-/=]{8,}", re.IGNORECASE)
PRIVATE_IPV4 = re.compile(
    r"\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b"
)


class GateError(RuntimeError):
    """A fail-closed input, build, or verification error."""


@dataclass(frozen=True)
class TrustedExecutable:
    """One absolute external executable pinned to its bytes and filesystem identity."""

    name: str
    path: Path
    sha256: str
    size: int
    device: int
    inode: int
    mode_type: int
    link_count: int
    mtime_ns: int
    ctime_ns: int

    def assert_unchanged(self) -> None:
        current = _snapshot_trusted_executable(self.name, self.path)
        require(current == self, f"trusted {self.name} executable changed after resolution")


@dataclass(frozen=True)
class TrustedToolchain:
    """The single Git/ffmpeg/ffprobe trust contract used by every subprocess."""

    git: TrustedExecutable
    ffmpeg: TrustedExecutable
    ffprobe: TrustedExecutable

    def executable(self, name: str) -> TrustedExecutable:
        require(name in TRUSTED_EXECUTABLE_ENV, f"unsupported trusted executable {name}")
        return {"git": self.git, "ffmpeg": self.ffmpeg, "ffprobe": self.ffprobe}[name]


@dataclass(frozen=True)
class ValidatedInputs:
    exact_runtime_sha: str
    capture_head: str
    current_head: str
    captured_at: str
    live_base_url: str
    exact_deploy_evidence_mode: str
    deployment_producer: dict[str, str | int]
    builder_source: ProjectFileSnapshot
    narration_source: ProjectFileSnapshot
    capture_review: ProjectFileSnapshot
    deploy_state: ProjectFileSnapshot
    claim_matrix: ProjectFileSnapshot
    deployment_output: ProjectFileSnapshot
    deployment_status: ProjectFileSnapshot
    architecture_source: ProjectFileSnapshot
    caption_contract: ProjectFileSnapshot
    artifact_files: dict[str, ProjectFileSnapshot]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def project_path(value: str | Path, label: str, *, must_exist: bool = False) -> Path:
    try:
        return Path(inside_repo(value, label, must_exist=must_exist))
    except ValueError as exc:
        raise GateError(str(exc)) from exc


def snapshot_project_file(value: str | Path, label: str) -> ProjectFileSnapshot:
    try:
        return read_project_file_once(value, label)
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


def _is_reparse(metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(
        reparse_flag and getattr(metadata, "st_file_attributes", 0) & reparse_flag
    )


def _same_file_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev,
        left.st_ino,
        stat.S_IFMT(left.st_mode),
    ) == (
        right.st_dev,
        right.st_ino,
        stat.S_IFMT(right.st_mode),
    )


def _trusted_executable_filename(name: str) -> str:
    require(name in TRUSTED_EXECUTABLE_ENV, f"unsupported trusted executable {name}")
    return f"{name}.exe" if os.name == "nt" else name


def _require_allowed_executable_link_count(name: str, link_count: int) -> None:
    if name == "git":
        require(link_count >= 1, "trusted git executable has no filesystem link")
    else:
        require(link_count == 1, f"trusted {name} executable must have exactly one filesystem link")


def _reject_reparse_path_components(path: Path, label: str) -> None:
    """Reject indirection in every component of one existing absolute path."""

    require(path.is_absolute(), f"{label} must be an absolute path")
    parts = path.parts
    require(bool(parts), f"{label} has no filesystem components")
    current = Path(parts[0])
    try:
        root_metadata = current.lstat()
    except OSError as exc:
        raise GateError(f"{label} must be an existing non-reparse path") from exc
    require(not _is_reparse(root_metadata), f"{label} must not traverse a symlink or reparse point")
    for part in parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except OSError as exc:
            raise GateError(f"{label} must be an existing non-reparse path") from exc
        require(not _is_reparse(metadata), f"{label} must not traverse a symlink or reparse point")


def _snapshot_trusted_executable(name: str, path: Path) -> TrustedExecutable:
    """Read and identity-bind one configured executable without following links."""

    expected_name = _trusted_executable_filename(name)
    candidate = Path(path)
    require(candidate.is_absolute(), f"{TRUSTED_EXECUTABLE_ENV[name]} must be an absolute path")
    lexical = Path(os.path.abspath(candidate))
    names_match = lexical.name.casefold() == expected_name.casefold() if os.name == "nt" else lexical.name == expected_name
    require(names_match, f"{TRUSTED_EXECUTABLE_ENV[name]} must name exact {expected_name}")
    _reject_reparse_path_components(lexical, f"trusted {name} executable")

    try:
        resolved = lexical.resolve(strict=True)
        before_path = lexical.lstat()
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise GateError(f"trusted {name} executable must exist as a stable regular file") from exc
    require(resolved == lexical, f"trusted {name} executable must not use path indirection")
    require(stat.S_ISREG(before_path.st_mode) and not _is_reparse(before_path),
            f"trusted {name} executable must be a non-reparse regular file")
    _require_allowed_executable_link_count(name, before_path.st_nlink)
    if os.name != "nt":
        require(os.access(lexical, os.X_OK), f"trusted {name} executable is not executable")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    digest = hashlib.sha256()
    bytes_read = 0
    try:
        descriptor = os.open(lexical, flags)
        before_fd = os.fstat(descriptor)
        require(stat.S_ISREG(before_fd.st_mode) and before_fd.st_nlink == before_path.st_nlink,
                f"trusted {name} executable changed its filesystem link count before it could be pinned")
        _require_allowed_executable_link_count(name, before_fd.st_nlink)
        require(_same_file_identity(before_path, before_fd),
                f"trusted {name} executable changed identity before it could be pinned")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            bytes_read += len(chunk)
        after_fd = os.fstat(descriptor)
    except OSError as exc:
        raise GateError(f"trusted {name} executable could not be read through a stable descriptor") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    try:
        after_path = lexical.lstat()
        _reject_reparse_path_components(lexical, f"trusted {name} executable")
        still_resolved = lexical.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise GateError(f"trusted {name} executable changed path identity while it was pinned") from exc
    require(still_resolved == resolved, f"trusted {name} executable changed its resolved path")
    require(
        all(
            _same_file_identity(left, right)
            for left, right in (
                (before_path, before_fd),
                (before_fd, after_fd),
                (after_fd, after_path),
            )
        ),
        f"trusted {name} executable changed filesystem identity while it was pinned",
    )
    require(after_fd.st_nlink == before_fd.st_nlink == after_path.st_nlink,
            f"trusted {name} executable changed its filesystem link count")
    _require_allowed_executable_link_count(name, after_fd.st_nlink)
    require(
        before_fd.st_size == after_fd.st_size == bytes_read
        and before_fd.st_mtime_ns == after_fd.st_mtime_ns
        and before_fd.st_ctime_ns == after_fd.st_ctime_ns,
        f"trusted {name} executable changed bytes while it was pinned",
    )
    return TrustedExecutable(
        name=name,
        path=resolved,
        sha256=digest.hexdigest(),
        size=bytes_read,
        device=after_fd.st_dev,
        inode=after_fd.st_ino,
        mode_type=stat.S_IFMT(after_fd.st_mode),
        link_count=after_fd.st_nlink,
        mtime_ns=after_fd.st_mtime_ns,
        ctime_ns=after_fd.st_ctime_ns,
    )


@functools.lru_cache(maxsize=1)
def trusted_toolchain() -> TrustedToolchain:
    """Resolve every production subprocess only from explicit absolute trust roots."""

    configured = {
        name: os.environ.get(variable, "").strip()
        for name, variable in TRUSTED_EXECUTABLE_ENV.items()
    }
    require(
        all(configured.values()),
        "subprocess execution requires explicit absolute MEMORYAGENT_GIT_EXECUTABLE, "
        "MEMORYAGENT_FFMPEG_EXECUTABLE, and MEMORYAGENT_FFPROBE_EXECUTABLE paths",
    )
    git_executable = _snapshot_trusted_executable("git", Path(configured["git"]))
    ffmpeg = _snapshot_trusted_executable("ffmpeg", Path(configured["ffmpeg"]))
    ffprobe = _snapshot_trusted_executable("ffprobe", Path(configured["ffprobe"]))
    require(ffmpeg.path.parent == ffprobe.path.parent,
            "trusted ffmpeg and ffprobe executables must be sibling files from one toolchain directory")
    require(ffmpeg.path != ffprobe.path, "trusted ffmpeg and ffprobe executables must be distinct")
    return TrustedToolchain(git=git_executable, ffmpeg=ffmpeg, ffprobe=ffprobe)


@contextmanager
def trusted_invocation(name: str) -> Iterable[str]:
    """Verify the cached executable immediately before and after one invocation."""

    executable = trusted_toolchain().executable(name)
    executable.assert_unchanged()
    try:
        yield str(executable.path)
    finally:
        executable.assert_unchanged()


def run_trusted_tool(
    name: str,
    arguments: Sequence[str],
    **kwargs: Any,
) -> subprocess.CompletedProcess[Any]:
    """Run one command without ever delegating executable lookup to the OS."""

    with trusted_invocation(name) as executable:
        return subprocess.run([executable, *arguments], **kwargs)


def _self_test_path_directories() -> tuple[Path, ...]:
    """Enumerate safe absolute PATH directories without using process search order."""

    directories: dict[str, Path] = {}
    repository = Path(os.path.abspath(REPO))
    working_directory = Path(os.path.abspath(Path.cwd()))
    for raw_entry in os.environ.get("PATH", "").split(os.pathsep):
        entry = raw_entry.strip()
        if len(entry) >= 2 and entry[0] == entry[-1] == '"':
            entry = entry[1:-1]
        if not entry:
            continue
        directory = Path(entry)
        if not directory.is_absolute():
            continue
        lexical = Path(os.path.abspath(directory))
        if lexical == working_directory:
            continue
        try:
            lexical.relative_to(repository)
        except ValueError:
            pass
        else:
            continue
        try:
            _reject_reparse_path_components(lexical, "self-test executable directory")
            resolved = lexical.resolve(strict=True)
            metadata = lexical.lstat()
        except (GateError, FileNotFoundError, OSError, RuntimeError):
            continue
        if resolved != lexical or not stat.S_ISDIR(metadata.st_mode) or _is_reparse(metadata):
            continue
        directories[os.path.normcase(str(resolved))] = resolved
    return tuple(directories.values())


def _is_self_test_executable_candidate(name: str, path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return False
    return (
        stat.S_ISREG(metadata.st_mode)
        and not _is_reparse(metadata)
        and (metadata.st_nlink >= 1 if name == "git" else metadata.st_nlink == 1)
        and (os.name == "nt" or os.access(path, os.X_OK))
    )


def _discover_self_test_executable(name: str) -> Path:
    """Find one unambiguous executable only for an explicitly non-production fixture."""

    candidates = tuple(
        directory / _trusted_executable_filename(name)
        for directory in _self_test_path_directories()
        if _is_self_test_executable_candidate(name, directory / _trusted_executable_filename(name))
    )
    require(
        len(candidates) == 1,
        f"self-test {name} discovery requires exactly one complete non-reparse PATH candidate; "
        f"set {TRUSTED_EXECUTABLE_ENV[name]} explicitly when PATH is ambiguous",
    )
    return candidates[0]


def _discover_self_test_media_executables() -> tuple[Path, Path]:
    """Find one unambiguous sibling media-tool pair for a non-production fixture."""

    candidates: list[tuple[Path, Path]] = []
    for directory in _self_test_path_directories():
        paths = tuple(directory / _trusted_executable_filename(name) for name in ("ffmpeg", "ffprobe"))
        if all(_is_self_test_executable_candidate(name, path) for name, path in zip(("ffmpeg", "ffprobe"), paths)):
            candidates.append((paths[0], paths[1]))

    require(
        len(candidates) == 1,
        "self-test media discovery requires exactly one complete non-reparse ffmpeg/ffprobe PATH directory; "
        "set MEMORYAGENT_FFMPEG_EXECUTABLE and MEMORYAGENT_FFPROBE_EXECUTABLE explicitly when PATH is ambiguous",
    )
    return candidates[0]


@contextmanager
def self_test_tool_environment() -> Iterable[None]:
    """Temporarily configure the fixture-only PATH fallback for ``--self-test``."""

    variables = tuple(TRUSTED_EXECUTABLE_ENV.values())
    original = {variable: os.environ.get(variable) for variable in variables}
    populated = [bool(value and value.strip()) for value in original.values()]
    require(all(populated) or not any(populated),
            "set all three MEMORYAGENT_*_EXECUTABLE trust paths, or none for a self-test")
    if not any(populated):
        git_executable = _discover_self_test_executable("git")
        ffmpeg, ffprobe = _discover_self_test_media_executables()
        os.environ[TRUSTED_EXECUTABLE_ENV["git"]] = str(git_executable)
        os.environ[TRUSTED_EXECUTABLE_ENV["ffmpeg"]] = str(ffmpeg)
        os.environ[TRUSTED_EXECUTABLE_ENV["ffprobe"]] = str(ffprobe)
    trusted_toolchain.cache_clear()
    try:
        yield
    finally:
        for variable, value in original.items():
            if value is None:
                os.environ.pop(variable, None)
            else:
                os.environ[variable] = value
        trusted_toolchain.cache_clear()


def create_build_session(scratch: Path) -> Path:
    """Create an unpredictable, private scratch child for one encode."""

    scratch.mkdir(parents=True, exist_ok=True)
    metadata = scratch.lstat()
    require(stat.S_ISDIR(metadata.st_mode) and not _is_reparse(metadata), "caption video scratch must be a real directory")
    try:
        scratch.resolve(strict=True).relative_to(REPO)
    except (OSError, RuntimeError, ValueError) as exc:
        raise GateError("caption video scratch must remain project-contained") from exc
    session = Path(tempfile.mkdtemp(prefix="memoryagent-caption-build-", dir=scratch))
    session_metadata = session.lstat()
    require(stat.S_ISDIR(session_metadata.st_mode) and not _is_reparse(session_metadata), "build session is not a real directory")
    require(session.parent == scratch, "build session escaped the requested scratch root")
    return session


def exclusive_write_bytes(path: Path, content: bytes) -> None:
    """Create one new regular file without following a pre-existing link."""

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        view = memoryview(content)
        written = 0
        while written < len(view):
            count = os.write(descriptor, view[written:])
            if count <= 0:
                raise OSError("exclusive scratch write made no progress")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def load_snapshot_json(snapshot: ProjectFileSnapshot, label: str) -> Any:
    try:
        return json.loads(snapshot.text())
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{label} is not valid UTF-8 JSON") from exc


def git(*args: str, check: bool = True) -> str:
    result = run_trusted_tool(
        "git",
        ["-C", str(REPO), *args],
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
    result = run_trusted_tool(
        "git",
        ["-C", str(REPO), *args],
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


def ensure_snapshot_matches_head(snapshot: ProjectFileSnapshot, label: str) -> None:
    """Bind retained bytes directly to the tracked blob named by current HEAD.

    ``hash-object --path`` applies Git's checked-in clean filter, so a normal
    CRLF checkout compares to the LF blob without reopening the working file.
    """

    rel = snapshot.relative_path
    require(git_success("ls-files", "--error-unmatch", "--", rel), f"{label} must be committed before a production build")
    result = run_trusted_tool(
        "git",
        ["-C", str(REPO), "hash-object", f"--path={rel}", "--stdin"],
        check=False,
        input=snapshot.data,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    require(result.returncode == 0, f"{label} snapshot could not be mapped to a Git blob")
    snapshot_blob = result.stdout.decode("ascii", errors="strict").strip()
    head_blob = git("rev-parse", f"HEAD:{rel}")
    require(snapshot_blob == head_blob, f"{label} snapshot is not byte-equal to current HEAD after Git clean filtering")


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


def artifact_snapshot(artifact_root: Path, rel: str) -> ProjectFileSnapshot:
    root = artifact_root.resolve(strict=True)
    snapshot = snapshot_project_file(root / Path(rel), f"capture artifact {rel}")
    try:
        snapshot.path.relative_to(root)
    except ValueError as exc:
        raise GateError(f"capture artifact {rel} escapes its project-contained root") from exc
    return snapshot


def validate_image_dimensions(rel: str, content: bytes) -> None:
    try:
        with Image.open(io.BytesIO(content)) as image:
            image.verify()
        with Image.open(io.BytesIO(content)) as image:
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
) -> tuple[
    dict[str, Any],
    dict[str, ProjectFileSnapshot],
    dict[str, str],
    ProjectFileSnapshot,
    ProjectFileSnapshot,
]:
    review_snapshot = snapshot_project_file(review_path, "capture review")
    review = load_snapshot_json(review_snapshot, "capture review")
    require(isinstance(review, dict), "capture review must be a JSON object")
    require(review.get("schemaVersion") == 3 and review.get("status") == "passed", "capture review is not schema-v3 passed")
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
    require(base_url == EXPECTED_LIVE_ORIGIN, "capture review liveBaseUrl is not the pinned credential destination")
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
    evidence_mode = gates.get("exactDeploymentEvidenceMode")
    require(
        evidence_mode in {STRICT_FINAL_MARKER, TERMINAL_SUCCESS_TRUNCATED_OUTPUT},
        "capture review has no recognized exact-deploy evidence mode",
    )
    deployment_evidence = review.get("deploymentEvidence")
    require(isinstance(deployment_evidence, dict), "capture review has no bound deployment evidence record")
    require(deployment_evidence.get("mode") == evidence_mode, "capture review deployment evidence mode is inconsistent")
    producer = deployment_evidence.get("producer")
    require(isinstance(producer, dict), "capture review has no producer-bound deployment identity")
    for name in ("invocationId", "commandId"):
        value = producer.get(name)
        require(
            isinstance(value, str) and PRODUCER_ID.fullmatch(value) is not None,
            f"capture review deployment producer {name} is invalid",
        )
    output_record = deployment_evidence.get("output")
    require(isinstance(output_record, dict), "capture review has no deployment output binding")
    require(producer.get("outputSha256") == output_record.get("sha256"), "capture review producer outputSha256 is inconsistent")
    require(
        type(producer.get("outputBytes")) is int and producer.get("outputBytes") == output_record.get("size"),
        "capture review producer outputBytes is inconsistent",
    )

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
    subtitle_timeline = review.get("subtitleTimeline")
    require(isinstance(subtitle_timeline, dict), "capture review has no immutable subtitle timeline binding")
    canonical_record = subtitle_timeline.get("canonicalContract")
    require(isinstance(canonical_record, dict), "capture review has no canonical subtitle contract record")
    require(
        canonical_record.get("path") == CAPTION_CONTRACT_SNAPSHOT.relative_path
        and canonical_record.get("sha256") == CAPTION_CONTRACT_SNAPSHOT.sha256
        and canonical_record.get("size") == CAPTION_CONTRACT_SNAPSHOT.size,
        "capture review canonical subtitle contract does not match the tracked read-once bytes",
    )
    measured_record = subtitle_timeline.get("measuredInput")
    require(isinstance(measured_record, dict), "capture review has no measured subtitle input binding")
    require(
        isinstance(measured_record.get("path"), str)
        and SHA256.fullmatch(str(measured_record.get("sha256", "")).lower()) is not None
        and type(measured_record.get("size")) is int
        and measured_record.get("size") > 0,
        "capture review measured subtitle input binding is invalid",
    )
    require(subtitle_timeline.get("matchesCanonicalContract") is True, "capture review subtitle input did not match the canonical contract")

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
    architecture_source = snapshot_project_file(ARCHITECTURE_SOURCE_REL, "architecture source")
    require(architecture_source.sha256 == architecture_source_hash.lower(), "architecture source changed after capture")
    require(normalized.get(ARCHITECTURE_REL) == architecture_raster_hash.lower(), "architecture raster hash disagrees with the artifact inventory")

    files: dict[str, ProjectFileSnapshot] = {}
    for rel, expected_hash in normalized.items():
        snapshot = artifact_snapshot(artifact_root, rel)
        require(snapshot.sha256 == expected_hash, f"capture artifact {rel} is stale or differs from CAPTURE_REVIEW.json")
        if snapshot.path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            validate_image_dimensions(rel, snapshot.data)
        files[rel] = snapshot

    canonical_srt_bytes = files[SRT_REL].data
    expected_srt_bytes = expected_srt(beats).encode("utf-8")
    require(canonical_srt_bytes == expected_srt_bytes, "measured SRT bytes do not exactly match the canonical ten-beat frame timeline")
    canonical_srt = canonical_srt_bytes.decode("utf-8")
    require(BEARER.search(canonical_srt) is None and EMAIL.search(canonical_srt) is None, "measured SRT contains secret-shaped content")
    return review, files, normalized, review_snapshot, architecture_source


def validate_deploy_state_text(text: str, expected_sha: str) -> None:
    candidate_lines = [line.strip() for line in text.splitlines() if "MEMORYAGENT_DEPLOY_STATE_V1" in line]
    require(len(candidate_lines) == 1, "DEPLOY_STATE.md must contain exactly one v1 machine release record")
    match = DEPLOY_STATE_RECORD.fullmatch(candidate_lines[0])
    require(match is not None, "DEPLOY_STATE.md machine release record is malformed or not LIVE_VERIFIED_READY")
    require(match.group(1) == expected_sha, "DEPLOY_STATE.md machine release record binds a different runtime SHA")


def validate_deploy_state(snapshot: ProjectFileSnapshot, expected_sha: str) -> None:
    validate_deploy_state_text(snapshot.text(errors="replace"), expected_sha)


def validate_claim_matrix(snapshot: ProjectFileSnapshot | Path) -> None:
    if isinstance(snapshot, Path):
        snapshot = snapshot_project_file(snapshot, "claim/evidence matrix")
    text = snapshot.text()
    for snippet in REQUIRED_CLAIM_SNIPPETS:
        require(snippet in text, f"claim/evidence matrix no longer supports the final evidence card: {snippet}")


def validate_bound_deployment_evidence(
    review: dict[str, Any],
    status: ProjectFileSnapshot,
    output: ProjectFileSnapshot,
    observed_mode: str,
) -> None:
    evidence = review.get("deploymentEvidence")
    require(isinstance(evidence, dict), "capture review has no deployment evidence binding")
    require(evidence.get("mode") == observed_mode, "deployment evidence mode differs from the capture review")
    status_payload = load_snapshot_json(status, "deployment status")
    require(isinstance(status_payload, dict), "deployment status must be a JSON object")
    producer = evidence.get("producer")
    require(isinstance(producer, dict), "capture review has no deployment producer binding")
    expected_producer = {
        "invocationId": status_payload.get("invocationId"),
        "commandId": status_payload.get("commandId"),
        "outputSha256": output.sha256,
        "outputBytes": output.size,
    }
    require(producer == expected_producer, "deployment producer identity or output binding differs from the capture review")
    for name, snapshot in (("status", status), ("output", output)):
        record = evidence.get(name)
        require(isinstance(record, dict), f"capture review has no deployment {name} binding")
        require(record.get("path") == snapshot.relative_path, f"deployment {name} path differs from the capture review")
        require(record.get("sha256") == snapshot.sha256, f"deployment {name} bytes differ from the capture review")
        require(type(record.get("size")) is int and record.get("size") == snapshot.size, f"deployment {name} size differs from the capture review")


def validate_exact_deploy_evidence(expected_sha: str, status: Any, output: str | bytes) -> str:
    """Translate the shared exact-deploy contract into this gate's error type."""

    try:
        return _validate_exact_deploy_evidence(expected_sha, status, output)
    except ExactDeployEvidenceError as exc:
        raise GateError(str(exc)) from exc


def validate_exact_release(
    expected_sha: str,
    review: dict[str, Any],
    deployment_output: ProjectFileSnapshot,
    deployment_status: ProjectFileSnapshot,
    deploy_state: ProjectFileSnapshot,
) -> tuple[str, str, str, dict[str, str | int]]:
    require(SHA40.fullmatch(expected_sha) is not None, "--expected-sha must be 40 lowercase hex characters")
    require(git_success("cat-file", "-e", f"{expected_sha}^{{commit}}"), "expected runtime SHA is absent from this repository")
    ensure_ignored_untracked(deployment_output.path, "deployment output")
    ensure_ignored_untracked(deployment_status.path, "deployment status")

    status = load_snapshot_json(deployment_status, "deployment status")
    evidence_mode = validate_exact_deploy_evidence(expected_sha, status, deployment_output.data)
    validate_bound_deployment_evidence(review, deployment_status, deployment_output, evidence_mode)
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
    producer = {
        "invocationId": str(status["invocationId"]),
        "commandId": str(status["commandId"]),
        "outputSha256": deployment_output.sha256,
        "outputBytes": deployment_output.size,
    }
    return capture_head, current_head, evidence_mode, producer


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
    deployment_output_snapshot = snapshot_project_file(deployment_output, "deployment output")
    deployment_status_snapshot = snapshot_project_file(deployment_status, "deployment status")
    deploy_state_snapshot = snapshot_project_file(deploy_state, "deployment state")
    review, artifact_files, _artifact_hashes, review_snapshot, architecture_source = validate_capture_review(
        capture_review,
        artifact_root,
        expected_sha,
        beats,
    )
    claim_matrix_path = project_path(CLAIM_MATRIX_REL, "claim/evidence matrix", must_exist=True)
    builder_source = snapshot_project_file("demo/tools/build_caption_video.py", "caption video builder")
    narration_source = snapshot_project_file("demo/tools/build_local_narration.py", "local narration builder and validator")
    caption_contract_snapshot = CAPTION_CONTRACT_SNAPSHOT
    claim_matrix_snapshot = snapshot_project_file(claim_matrix_path, "claim/evidence matrix")
    if production_mode:
        ensure_snapshot_matches_head(builder_source, "caption video builder")
        ensure_snapshot_matches_head(narration_source, "local narration builder and validator")
        ensure_snapshot_matches_head(caption_contract_snapshot, "caption timeline contract")
        ensure_snapshot_matches_head(claim_matrix_snapshot, "claim/evidence matrix")
        ensure_snapshot_matches_head(deploy_state_snapshot, "deployment state")
        ensure_snapshot_matches_head(architecture_source, "architecture source")
    validate_claim_matrix(claim_matrix_snapshot)
    capture_head, current_head, evidence_mode, producer = validate_exact_release(
        expected_sha,
        review,
        deployment_output_snapshot,
        deployment_status_snapshot,
        deploy_state_snapshot,
    )
    return ValidatedInputs(
        exact_runtime_sha=expected_sha,
        capture_head=capture_head,
        current_head=current_head,
        captured_at=str(review["capturedAt"]),
        live_base_url=str(review["liveBaseUrl"]),
        exact_deploy_evidence_mode=evidence_mode,
        deployment_producer=producer,
        builder_source=builder_source,
        narration_source=narration_source,
        capture_review=review_snapshot,
        deploy_state=deploy_state_snapshot,
        deployment_output=deployment_output_snapshot,
        deployment_status=deployment_status_snapshot,
        claim_matrix=claim_matrix_snapshot,
        architecture_source=architecture_source,
        caption_contract=caption_contract_snapshot,
        artifact_files=artifact_files,
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


def place_contained(canvas: Image.Image, source: ProjectFileSnapshot, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    with Image.open(io.BytesIO(source.data)) as image:
        fitted = ImageOps.contain(image.convert("RGB"), (x1 - x0, y1 - y0), Image.Resampling.LANCZOS)
    x = x0 + (x1 - x0 - fitted.width) // 2
    y = y0 + (y1 - y0 - fitted.height) // 2
    canvas.paste(fitted, (x, y))


def draw_panel(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], *, fill: str = "#0d211b", outline: str = "#315e4e") -> None:
    draw.rounded_rectangle(box, radius=22, fill=fill, outline=outline, width=3)


def render_title(canvas: Image.Image, draw: ImageDraw.ImageDraw, source: ProjectFileSnapshot, live_base_url: str) -> None:
    with Image.open(io.BytesIO(source.data)) as image:
        background = ImageOps.fit(image.convert("RGB"), CANVAS, Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(7))
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
        render_title(canvas, draw, inputs.artifact_files[beat.visuals[0]], inputs.live_base_url)
    else:
        draw.rectangle((0, 0, CANVAS[0], 10), fill="#34d399")
        draw.text((58, 51), f"BEAT {beat.number:02d} / {len(BEATS):02d}", anchor="lm", font=font(23), fill="#65e6ae")
        draw.text((285, 51), beat.title, anchor="lm", font=font(35), fill="#ffffff")
        draw.text((1860, 51), "NARRATED · CAPTIONED", anchor="rm", font=font(21), fill="#9eb8ad")
        if beat.treatment == "evidence":
            render_evidence(draw)
        elif len(beat.visuals) == 1:
            box = (70, 120, 1850, 770)
            draw_panel(draw, box, fill="#091b15")
            place_contained(canvas, inputs.artifact_files[beat.visuals[0]], (85, 135, 1835, 755))
            if beat.labels:
                draw.rounded_rectangle((110, 680, 1810, 748), radius=18, fill="#071510", outline="#3b755e", width=2)
                draw.text((960, 714), beat.labels[0], anchor="mm", font=font(25), fill="#d8eee5")
        else:
            boxes = ((55, 125, 940, 765), (980, 125, 1865, 765))
            for index, (visual, box) in enumerate(zip(beat.visuals, boxes)):
                draw_panel(draw, box, fill="#091b15")
                place_contained(canvas, inputs.artifact_files[visual], (box[0] + 14, box[1] + 14, box[2] - 14, box[3] - 74))
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
    draw.text((1862, 1067), "Local synthetic narration · burned English captions", anchor="rm", font=font(18), fill="#759487")
    if self_test_label:
        draw.rounded_rectangle((650, 12, 1270, 40), radius=12, fill="#a71919", outline="#ff8b8b", width=1)
        draw.text((960, 26), "SYNTHETIC SELF-TEST - NOT SUBMISSION EVIDENCE", anchor="mm", font=font(15), fill="#ffffff")

    encoded = io.BytesIO()
    canvas.save(encoded, format="PNG", optimize=True)
    rendered = encoded.getvalue()
    exclusive_write_bytes(output, rendered)
    with Image.open(io.BytesIO(rendered)) as check:
        require(check.size == CANVAS, f"rendered beat {beat.number} is not 1920x1080")


def binary_version(name: str) -> str:
    result = run_trusted_tool(
        name,
        ["-version"],
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


def encode_video(
    frame_paths: Sequence[Path],
    beats: Sequence[Beat],
    narration_audio: Path,
    output: Path,
    scratch: Path,
) -> None:
    require(len(frame_paths) == len(beats) and frame_paths, "video frame/beat inventory is incomplete")
    require(narration_audio.parent == scratch and narration_audio.is_file(), "validated narration escaped build scratch")
    concat_path = scratch / "caption-video.ffconcat"
    lines = ["ffconcat version 1.0"]
    for frame_path, beat in zip(frame_paths, beats):
        require(frame_path.parent == scratch, "rendered beat escaped the build scratch directory")
        lines.append(f"file '{frame_path.name}'")
        lines.append(f"duration {beat.seconds:.6f}")
    lines.append(f"file '{frame_paths[-1].name}'")
    exclusive_write_bytes(concat_path, ("\n".join(lines) + "\n").encode("utf-8"))

    total_seconds = sum(beat.seconds for beat in beats)
    total_frames = total_seconds * FPS
    command = [
        "-n",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_path),
        "-i",
        str(narration_audio),
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
    result = run_trusted_tool(
        "ffmpeg",
        command,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    exclusive_write_bytes(scratch / "ffmpeg.stderr.log", result.stderr)
    require(result.returncode == 0 and output.is_file() and output.stat().st_size > 1024, f"ffmpeg encode failed (exit {result.returncode}); inspect the repo-local scratch log")


def decoded_audio_signal(path: Path) -> dict[str, int | float]:
    with trusted_invocation("ffmpeg") as ffmpeg:
        process = subprocess.Popen(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path), "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        require(process.stdout is not None, "failed to open decoded audio stream")
        peak = 0
        square_sum = 0
        sample_count = 0
        active_samples = 0
        clipped_samples = 0
        pcm_digest = hashlib.sha256()
        remainder = b""
        while True:
            chunk = process.stdout.read(1024 * 1024)
            if not chunk:
                break
            chunk = remainder + chunk
            remainder = chunk[-1:] if len(chunk) % 2 else b""
            usable = chunk[:-1] if remainder else chunk
            pcm_digest.update(usable)
            samples = array("h")
            samples.frombytes(usable)
            if sys.byteorder != "little":
                samples.byteswap()
            if samples:
                peak = max(peak, abs(min(samples)), abs(max(samples)))
                square_sum += sum(int(sample) * int(sample) for sample in samples)
                sample_count += len(samples)
                active_samples += sum(1 for sample in samples if abs(sample) >= 64)
                clipped_samples += sum(1 for sample in samples if abs(sample) >= 32_767)
        stderr = process.stderr.read() if process.stderr is not None else b""
        return_code = process.wait()
    require(return_code == 0 and not remainder, f"narration verification failed (exit {return_code})")
    require(not stderr and sample_count > 0, "narration verification emitted an ffmpeg error or no samples")
    return {
        "peakS16": peak,
        "rmsS16": round(math.sqrt(square_sum / sample_count), 6),
        "activeSampleRatio": round(active_samples / sample_count, 9),
        "clippedSamples": clipped_samples,
        "sampleCount": sample_count,
        "pcmSha256": pcm_digest.hexdigest(),
    }


def probe_video(path: Path, expected_seconds: int) -> dict[str, Any]:
    result = run_trusted_tool(
        "ffprobe",
        ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)],
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
    require(audio.get("sample_rate") == "48000" and audio.get("channels") == 2, "final narration audio is not 48 kHz stereo")
    duration = float(probe.get("format", {}).get("duration", 0.0))
    require(abs(duration - expected_seconds) <= max(0.05, 2 / FPS), "measured MP4 duration differs from the frame timeline")
    require(duration < STRICT_LIMIT_SECONDS, "measured MP4 duration reaches the 175-second safety ceiling")
    probe_text = json.dumps(probe, ensure_ascii=False)
    require(BEARER.search(probe_text) is None and EMAIL.search(probe_text) is None and PRIVATE_IPV4.search(probe_text) is None, "final MP4 metadata contains sensitive-shaped content")
    signal = decoded_audio_signal(path)
    require(int(signal["peakS16"]) >= 128, "encoded narration audio is silent or too close to silence")
    require(float(signal["rmsS16"]) >= 5.0, "encoded narration audio has no meaningful signal")
    require(float(signal["activeSampleRatio"]) >= 0.0002, "encoded narration audio contains too little non-silent audio")
    require(int(signal["clippedSamples"]) == 0 and int(signal["peakS16"]) < 32_767, "encoded narration audio contains clipping")
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
        "decodedAudioPeakS16": signal["peakS16"],
        "decodedAudioRmsS16": signal["rmsS16"],
        "decodedAudioActiveSampleRatio": signal["activeSampleRatio"],
        "decodedAudioClippedSamples": signal["clippedSamples"],
        "decodedAudioSampleCount": signal["sampleCount"],
        "decodedAudioPcmSha256": signal["pcmSha256"],
    }


def atomic_write_text(path: Path, content: str, scratch: Path) -> None:
    temp = scratch / f".{path.name}.{secrets.token_hex(16)}.writing"
    exclusive_write_bytes(temp, content.encode("utf-8"))
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
    narration_audio: Path,
    narration_manifest: Path,
    beats: Sequence[Beat] = BEATS,
    self_test_label: bool = False,
) -> dict[str, Any]:
    total_seconds = sum(beat.seconds for beat in beats)
    require(total_seconds < STRICT_LIMIT_SECONDS, "caption timeline reaches the 175-second ceiling")
    if beats is BEATS:
        require(total_seconds == EXPECTED_TOTAL_SECONDS, "canonical timeline is not exactly 172 seconds")
    require(output.suffix.lower() == ".mp4" and manifest_path.suffix.lower() == ".json", "final output extensions must be .mp4 and .json")
    require(srt_path.suffix.lower() == ".srt", "subtitle output extension must be .srt")
    require(
        len({output, srt_path, manifest_path, scratch, narration_audio, narration_manifest}) == 6,
        "caption-base outputs, scratch, narration WAV, and narration manifest must all be distinct",
    )
    bound_srt = inputs.artifact_files.get(SRT_REL)
    require(bound_srt is not None, "validated inputs have no canonical SRT snapshot")
    try:
        requested_srt = srt_path.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise GateError("validated SRT path disappeared before the build") from exc
    require(requested_srt == bound_srt.path, "requested SRT differs from the validated read-once snapshot")
    require(bound_srt.data == expected_srt(beats).encode("utf-8"), "validated SRT bytes differ from the active caption timeline")

    narration_windows = tuple(
        (int(start), int(end), str(caption)) for start, end, caption in caption_windows(beats)
    )
    try:
        narration = validate_narration_bundle(
            narration_audio,
            narration_manifest,
            windows=narration_windows,
            production_mode=not self_test_label,
        )
    except NarrationError as exc:
        raise GateError(str(exc)) from exc

    session_scratch = create_build_session(scratch)
    retained_narration = session_scratch / f"local-narration-{secrets.token_hex(12)}.wav"
    exclusive_write_bytes(retained_narration, narration.audio.data)
    frame_paths: list[Path] = []
    for beat in beats:
        frame_path = session_scratch / f"beat-{beat.number:02d}-{secrets.token_hex(12)}.png"
        render_beat_frame(beat, inputs, frame_path, self_test_label=self_test_label)
        frame_paths.append(frame_path)

    temporary_video = session_scratch / f"memoryagent-caption-video-{secrets.token_hex(16)}.rendering.mp4"
    encode_video(frame_paths, beats, retained_narration, temporary_video, session_scratch)
    technical = probe_video(temporary_video, total_seconds)

    # The SRT is canonical, public, human-reviewed evidence. It is a read-only input
    # to this intermediate builder and must never be rewritten as a build side effect.
    output.parent.mkdir(parents=True, exist_ok=True)
    os.replace(temporary_video, output)

    manifest = {
        "schemaVersion": 4,
        "status": "passed",
        "builder": "memoryagent-caption-led-ten-beat-v4-narrated",
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "exactRuntimeSource": inputs.exact_runtime_sha,
        "captureSubmissionHead": inputs.capture_head,
        "builderSourceHead": inputs.current_head,
        "builderSource": {
            "path": inputs.builder_source.relative_path,
            "sha256": inputs.builder_source.sha256,
            "size": inputs.builder_source.size,
        },
        "narrationValidatorSource": {
            "path": inputs.narration_source.relative_path,
            "sha256": inputs.narration_source.sha256,
            "size": inputs.narration_source.size,
        },
        "captureReview": {
            "path": inputs.capture_review.relative_path,
            "sha256": inputs.capture_review.sha256,
            "size": inputs.capture_review.size,
            "capturedAt": inputs.captured_at,
            "liveBaseUrl": inputs.live_base_url,
        },
        "releaseEvidence": {
            "exactDeployEvidenceMode": inputs.exact_deploy_evidence_mode,
            "producer": inputs.deployment_producer,
            "deployState": {"path": inputs.deploy_state.relative_path, "sha256": inputs.deploy_state.sha256, "size": inputs.deploy_state.size},
            "deploymentStatus": {"path": inputs.deployment_status.relative_path, "sha256": inputs.deployment_status.sha256, "size": inputs.deployment_status.size},
            "deploymentOutput": {"path": inputs.deployment_output.relative_path, "sha256": inputs.deployment_output.sha256, "size": inputs.deployment_output.size},
            "claimEvidenceMatrix": {"path": inputs.claim_matrix.relative_path, "sha256": inputs.claim_matrix.sha256, "size": inputs.claim_matrix.size},
            "architectureBinding": {
                "source": {"path": inputs.architecture_source.relative_path, "sha256": inputs.architecture_source.sha256, "size": inputs.architecture_source.size},
                "raster": {"path": ARCHITECTURE_REL, "sha256": inputs.artifact_files[ARCHITECTURE_REL].sha256, "size": inputs.artifact_files[ARCHITECTURE_REL].size},
            },
        },
        "timeline": {
            "canonicalContract": {
                "path": inputs.caption_contract.relative_path,
                "sha256": inputs.caption_contract.sha256,
                "size": inputs.caption_contract.size,
            },
            "fps": FPS,
            "strictLimitSeconds": STRICT_LIMIT_SECONDS,
            "plannedDurationSeconds": total_seconds,
            "measuredDurationSeconds": technical["durationSeconds"],
            "totalFrames": total_seconds * FPS,
            "beats": timeline_manifest(beats),
        },
        "narration": {
            "manifestPath": narration.manifest.relative_path,
            "manifestSha256": narration.manifest.sha256,
            "audioPath": narration.audio.relative_path,
            "audioSha256": narration.audio.sha256,
            "generator": narration.payload["generator"],
            "voice": {
                "name": narration.payload["voice"]["name"],
                "culture": narration.payload["voice"]["culture"],
                "gender": narration.payload["voice"]["gender"],
            },
            "timelineContract": {
                "path": narration.payload["timelineContract"]["path"],
                "sha256": narration.payload["timelineContract"]["sha256"],
                "size": narration.payload["timelineContract"]["size"],
            },
            "rights": {
                "syntheticVoiceDisclosure": narration.payload["rights"]["syntheticVoiceDisclosure"],
                "disclosure": narration.payload["rights"]["disclosure"],
                "thirdPartyMusic": narration.payload["rights"]["thirdPartyMusic"],
                "thirdPartyAudio": narration.payload["rights"]["thirdPartyAudio"],
                **(
                    {"commercialUseRightsApproved": narration.payload["rights"]["commercialUseRightsApproved"]}
                    if "commercialUseRightsApproved" in narration.payload["rights"]
                    else {}
                ),
                "humanVoiceRightsReviewRequired": narration.payload["rights"]["humanVoiceRightsReviewRequired"],
                "automatedProvenanceIsAuthoritativeRightsProof": narration.payload["rights"]["automatedProvenanceIsAuthoritativeRightsProof"],
            },
            "generationEvidence": {
                "evidenceType": narration.payload["generationEvidence"]["evidenceType"],
                "sha256": canonical_json_sha256(narration.payload["generationEvidence"]),
                "generatorSource": narration.payload["generationEvidence"]["generatorSource"],
                "assurance": narration.payload["generationEvidence"]["assurance"],
            },
            "measuredAudio": narration.measured_audio,
        },
        "rightsSafeAudio": {
            "voiceUsed": True,
            "ttsUsed": narration.payload["generator"] != "synthetic-self-test-tone-v1",
            "musicUsed": False,
            "mode": narration.payload["generator"],
            "decodedPeakS16": technical["decodedAudioPeakS16"],
            "decodedRmsS16": technical["decodedAudioRmsS16"],
            "decodedActiveSampleRatio": technical["decodedAudioActiveSampleRatio"],
            "decodedClippedSamples": technical["decodedAudioClippedSamples"],
            "decodedSampleCount": technical["decodedAudioSampleCount"],
            "decodedPcmSha256": technical["decodedAudioPcmSha256"],
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
        "inputs": {rel: snapshot.sha256 for rel, snapshot in inputs.artifact_files.items()},
        "outputs": {
            "video": {"path": relative_repo_path(output), "sha256": sha256_file(output), **technical},
            "subtitles": {
                "path": bound_srt.relative_path,
                "sha256": bound_srt.sha256,
                "size": bound_srt.size,
                "entries": len(beats),
                "timing": "frame-exact",
                "role": "validated-read-only-canonical-input",
            },
        },
    }
    atomic_write_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", session_scratch)
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
    with self_test_tool_environment():
        trusted_toolchain()
        return _self_test_impl(full_duration=full_duration)


def _self_test_impl(*, full_duration: bool = False) -> int:
    root = project_path(".artifacts/caption-video-selftest", "self-test root")
    safe_reset_selftest_root(root)
    fixture_root = root / "fixture-root"
    fixture_root.mkdir(parents=True)
    test_beats = BEATS if full_duration else tuple(replace(beat, seconds=1) for beat in BEATS)

    evidence_sha = "1" * 40
    evidence_status_base = {
        "memorySha": evidence_sha,
        "status": "Success",
        "terminal": True,
        "exitCode": 0,
        "outputCaptured": True,
        "projectContained": True,
        "invocationId": "invoke-caption-parser-selftest",
        "commandId": "command-caption-parser-selftest",
    }
    marker_prefix = (
        f"EXACT_CHECKOUT_OK app=memoryagent sha={evidence_sha}\n"
        f"EXACT_APP_DEPLOY_OK app=memoryagent sha={evidence_sha}\n"
    )
    def bound_status(output: str, **overrides: Any) -> dict[str, Any]:
        raw = output.encode("utf-8")
        return {
            **evidence_status_base,
            "outputSha256": hashlib.sha256(raw).hexdigest(),
            "outputBytes": len(raw),
            **overrides,
        }

    autopilot_sha = "a" * 40
    strict_output = marker_prefix + f"EXACT_DEPLOY_SUCCESS memory={evidence_sha} autopilot={autopilot_sha}\n"
    require(
        validate_exact_deploy_evidence(
            evidence_sha,
            bound_status(strict_output),
            strict_output,
        ) == STRICT_FINAL_MARKER,
        "strict final-marker evidence self-test failed",
    )
    require(
        validate_exact_deploy_evidence(evidence_sha, bound_status(marker_prefix), marker_prefix)
        == TERMINAL_SUCCESS_TRUNCATED_OUTPUT,
        "terminal-success truncated-output evidence self-test failed",
    )
    rejected = False
    try:
        conflicting_output = marker_prefix + f"EXACT_DEPLOY_SUCCESS memory={'2' * 40} autopilot={autopilot_sha}\n"
        validate_exact_deploy_evidence(evidence_sha, bound_status(conflicting_output), conflicting_output)
    except GateError:
        rejected = True
    require(rejected, "exact-deploy evidence self-test accepted a conflicting final marker")
    rejected = False
    try:
        validate_exact_deploy_evidence(evidence_sha, bound_status(marker_prefix, outputCaptured=False), marker_prefix)
    except GateError:
        rejected = True
    require(rejected, "exact-deploy evidence self-test accepted an uncaptured truncation fallback")

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
    deployment_output = root / "exact-deploy-output.selftest.txt"
    deployment_output.write_text(
        f"EXACT_CHECKOUT_OK app=memoryagent sha={current_head}\n"
        f"EXACT_APP_DEPLOY_OK app=memoryagent sha={current_head}\n"
        f"EXACT_DEPLOY_SUCCESS memory={current_head} autopilot={current_head}\n",
        encoding="utf-8",
    )
    output_snapshot = snapshot_project_file(deployment_output, "self-test deployment output")
    deployment_status = root / "exact-deploy-status.selftest.json"
    deployment_status.write_text(
        json.dumps(
            {
                "memorySha": current_head,
                "status": "Success",
                "terminal": True,
                "exitCode": 0,
                "outputCaptured": True,
                "projectContained": True,
                "invocationId": "invoke-caption-video-selftest",
                "commandId": "command-caption-video-selftest",
                "outputSha256": output_snapshot.sha256,
                "outputBytes": output_snapshot.size,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    status_snapshot = snapshot_project_file(deployment_status, "self-test deployment status")
    capture_review = root / "CAPTURE_REVIEW.selftest.json"
    architecture_source = project_path(ARCHITECTURE_SOURCE_REL, "architecture source", must_exist=True)
    review_payload = {
        "schemaVersion": 3,
        "status": "passed",
        "capturedAt": now,
        "liveBaseUrl": EXPECTED_LIVE_ORIGIN,
        "exactRuntimeSource": current_head,
        "submissionPackHeadAtCapture": current_head,
        "deploymentEvidence": {
            "mode": STRICT_FINAL_MARKER,
            "producer": {
                "invocationId": "invoke-caption-video-selftest",
                "commandId": "command-caption-video-selftest",
                "outputSha256": output_snapshot.sha256,
                "outputBytes": output_snapshot.size,
            },
            "status": {"path": status_snapshot.relative_path, "sha256": status_snapshot.sha256, "size": status_snapshot.size},
            "output": {"path": output_snapshot.relative_path, "sha256": output_snapshot.sha256, "size": output_snapshot.size},
        },
        "models": {
            "embedder": EXPECTED_EMBEDDER,
            "narrator": EXPECTED_NARRATOR,
            "judge": "qwen-plus",
            "vision": EXPECTED_VISION,
            "embedDim": EXPECTED_EMBED_DIM,
        },
        "gates": {
            **REQUIRED_BOOLEAN_GATES,
            "exactDeploymentEvidenceMode": STRICT_FINAL_MARKER,
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
        "subtitleTimeline": {
            "canonicalContract": {
                "path": CAPTION_CONTRACT_SNAPSHOT.relative_path,
                "sha256": CAPTION_CONTRACT_SNAPSHOT.sha256,
                "size": CAPTION_CONTRACT_SNAPSHOT.size,
            },
            "measuredInput": {
                "path": ".artifacts/caption-video-selftest/measured-windows.json",
                "sha256": "0" * 64,
                "size": 1,
            },
            "matchesCanonicalContract": True,
        },
        "artifacts": artifact_hashes,
    }
    capture_review.write_text(json.dumps(review_payload, indent=2) + "\n", encoding="utf-8")
    deploy_state = root / "DEPLOY_STATE.selftest.md"
    deploy_state.write_text(
        f"# Synthetic self-test only\n\n<!-- MEMORYAGENT_DEPLOY_STATE_V1 status=LIVE_VERIFIED_READY runtime_sha={current_head} -->\n",
        encoding="utf-8",
    )

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
    narration_audio = root / "SYNTHETIC-NOT-SUBMISSION-NARRATION.wav"
    narration_manifest = root / "SYNTHETIC-NOT-SUBMISSION-NARRATION.manifest.json"
    create_synthetic_fixture(
        narration_audio,
        narration_manifest,
        windows=tuple(
            (int(start), int(end), str(caption)) for start, end, caption in caption_windows(test_beats)
        ),
    )
    srt_before = srt_path.lstat()
    srt_bytes_before = srt_path.read_bytes()
    manifest = build_video(
        inputs,
        output=output_dir / f"{output_stem}.mp4",
        srt_path=srt_path,
        manifest_path=output_dir / f"{output_stem}.manifest.json",
        scratch=root / "build-scratch",
        narration_audio=narration_audio,
        narration_manifest=narration_manifest,
        beats=test_beats,
        self_test_label=True,
    )
    srt_after = srt_path.lstat()
    require(
        (srt_before.st_dev, srt_before.st_ino, srt_before.st_size, srt_before.st_mtime_ns, srt_before.st_ctime_ns)
        == (srt_after.st_dev, srt_after.st_ino, srt_after.st_size, srt_after.st_mtime_ns, srt_after.st_ctime_ns)
        and srt_path.read_bytes() == srt_bytes_before,
        "caption video build mutated or replaced the canonical SRT input",
    )
    require(manifest["outputs"]["video"]["frameCount"] == sum(beat.seconds for beat in test_beats) * FPS, "self-test frame-count assertion failed")
    require(manifest["rightsSafeAudio"]["decodedPeakS16"] >= 128, "self-test narration assertion failed")
    require(manifest["rightsSafeAudio"]["decodedClippedSamples"] == 0, "self-test clipping assertion failed")

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
        require("pinned credential destination" in str(exc), "self-test unsafe-origin rejection was not explicit")
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
    print(f"caption video self-test: PASS · {duration_label} · non-silent local fixture · claim-boundary/hash/origin/SRT/path gates")
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
    parser.add_argument("--output", default=DEFAULT_OUTPUT_REL, help="ignored repo-contained caption-base MP4 path")
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST_REL, help="ignored repo-contained caption-base manifest path")
    parser.add_argument("--narration-audio", default=DEFAULT_NARRATION_AUDIO_REL, help="project-contained local narration WAV")
    parser.add_argument("--narration-manifest", default=DEFAULT_NARRATION_MANIFEST_REL, help="project-contained local narration manifest JSON")
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
        narration_audio = project_path(args.narration_audio, "local narration WAV", must_exist=True)
        narration_manifest = project_path(args.narration_manifest, "local narration manifest", must_exist=True)
        scratch = project_path(args.scratch, "caption video scratch")
        require(relative_repo_path(capture_review) == CAPTURE_REVIEW_REL, "production build requires the canonical capture review")
        require(relative_repo_path(deploy_state) == DEPLOY_STATE_REL, "production build requires the canonical deployment state")
        require(relative_repo_path(srt_path) == SRT_REL, "production build requires the canonical measured SRT")
        output_rel = Path(relative_repo_path(output))
        manifest_rel = Path(relative_repo_path(manifest_path))
        require(output_rel.parent.as_posix() == ".artifacts/final-caption-video", "direct caption-base MP4 output must stay under ignored .artifacts/final-caption-video/")
        require(manifest_rel.parent.as_posix() == ".artifacts/final-caption-video", "direct caption-base manifest must stay under ignored .artifacts/final-caption-video/")
        require(output.name != "memoryagent-demo.mp4", "only the real-motion orchestrator may promote the canonical final MP4")
        require(manifest_path.name != "memoryagent-demo.manifest.json", "only the real-motion orchestrator may promote the canonical final manifest")
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
            try:
                validate_narration_bundle(narration_audio, narration_manifest, production_mode=True)
            except NarrationError as exc:
                raise GateError(str(exc)) from exc
            print(f"caption video inputs: PASS · exact runtime {inputs.exact_runtime_sha[:12]} · 11 gallery + 11 proof frames · 10 evidence frames · measured SRT · local narration")
            return 0
        manifest = build_video(
            inputs,
            output=output,
            srt_path=srt_path,
            manifest_path=manifest_path,
            scratch=scratch,
            narration_audio=narration_audio,
            narration_manifest=narration_manifest,
        )
        measured = manifest["timeline"]["measuredDurationSeconds"]
        print(f"caption video build: PASS · {measured:.3f}s · 1920x1080 · 30 fps · local narrated AAC · exact runtime {inputs.exact_runtime_sha[:12]}")
        return 0
    except (GateError, OSError, UnicodeError) as exc:
        print(f"caption video build: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
