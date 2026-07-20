#!/usr/bin/env python3
"""Compose and prove a narrated submission video with genuine live motion.

The existing judge-first renderer remains the source of title, architecture,
metrics, claim-locked captions and disclosed ElevenLabs synthetic narration.
This compositor places a separately recorded, SHA-bound live browser interaction
into one reviewed timeline window, then measures the shipped pixels and decoded
audio.  It never contacts the live service, ElevenLabs, or a reviewer credential.

Production inputs must be regular project-contained files.  The interaction
manifest must bind the exact CAPTURE_REVIEW bytes, deployed SHA, public origin and
raw browser-video hash.  The base manifest must bind the exact narration WAV,
narration manifest and caption timeline.  The final preserves the base AAC narration,
discloses local synthetic speech, contains no third-party music, and fails closed on
digital silence or clipping.
"""
from __future__ import annotations

import argparse
import array
import datetime as dt
from dataclasses import dataclass
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Sequence


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "demo" / "tools"))
sys.path.insert(0, str(ROOT / "scripts"))
from build_local_narration import (  # noqa: E402
    ELEVENLABS_DISCLOSURE as DISCLOSURE,
    GENERATOR_ID as CANONICAL_NARRATION_GENERATOR,
    NarrationError,
    canonical_json_sha256,
    load_caption_timeline,
    validate_narration_bundle,
)
from exact_deploy_evidence import (  # noqa: E402
    ExactDeployEvidenceError,
    STRICT_FINAL_MARKER,
    TERMINAL_SUCCESS_TRUNCATED_OUTPUT,
    validate_exact_deploy_evidence,
)
from repo_paths import ProjectFileSnapshot, read_project_file_once  # noqa: E402

DEFAULT_OUTPUT = "demo/final-media/memoryagent-demo.mp4"
DEFAULT_SRT_OUTPUT = "demo/final-media/memoryagent-demo.en.srt"
DEFAULT_MANIFEST = "demo/final-media/memoryagent-demo.manifest.json"
DEFAULT_QA = "demo/final-media/memoryagent-demo.qa.json"
DEFAULT_THUMBNAIL = "demo/final-media/youtube-thumbnail.png"
DEFAULT_NARRATION_AUDIO = ".artifacts/final-narration/memoryagent-narration.wav"
DEFAULT_NARRATION_MANIFEST = ".artifacts/final-narration/memoryagent-narration.manifest.json"
DEFAULT_URL = "https://memory.43.106.13.19.sslip.io"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SRT_TIME_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2}),(\d{3})$")
STRICT_LIMIT_SECONDS = 175.0
FPS = 30.0
AUDIO_SAMPLE_RATE = 48000
AUDIO_CHANNELS = 2
ACTIVE_SAMPLE_THRESHOLD = 256
CLIPPING_SAMPLE_THRESHOLD = 32760
MIN_NARRATION_PEAK_S16 = 2_048
MIN_NARRATION_RMS_S16 = 256.0
MIN_NARRATION_ACTIVE_RATIO = 0.01
MIN_INTEGRATED_LUFS = -28.0
MAX_INTEGRATED_LUFS = -10.0
MAX_TRUE_PEAK_DBFS = -1.0
MAX_LOUDNESS_RANGE_LU = 20.0
BASE_SCHEMA_VERSION = 4
BASE_BUILDER_ID = "memoryagent-caption-led-ten-beat-v4-narrated"
RELEASE_SOURCE_RELS = (
    "demo/tools/build_local_narration.py",
    "demo/tools/build_elevenlabs_narration.py",
    "demo/tools/build_caption_video.py",
    "demo/tools/record_live_motion.py",
    "demo/tools/compose_real_motion_video.py",
    "demo/tools/build_real_motion_submission.py",
    "scripts/repo_paths.py",
    "scripts/exact_deploy_evidence.py",
    "scripts/capture_submission_gallery.py",
)
FINAL_SCHEMA_VERSION = 2
FINAL_BUILDER_ID = "caption-led-real-motion-compositor-v3-narrated-immutable-inputs"
CLAIM_BOUNDARY = (
    "Live footage demonstrates interaction with the deployed app; benchmark and security claims "
    "remain bounded by CAPTURE_REVIEW and the existing caption source."
)
TRUSTED_EXECUTABLE_ENV = {
    "git": "MEMORYAGENT_GIT_EXECUTABLE",
    "ffmpeg": "MEMORYAGENT_FFMPEG_EXECUTABLE",
    "ffprobe": "MEMORYAGENT_FFPROBE_EXECUTABLE",
}
EXPECTED_CAPTURE_QUESTION = (
    "Using only the retrieved memory, return exactly one sentence that states the true employer cost "
    "for Northwind Trading in 2026-05 and includes citation marker [1]. Mention no other amounts, "
    "ratios, employee counts, or calculations."
)
PRODUCTION_INTERACTION_KEYS = {
    "schemaVersion", "status", "mode", "submissionEligible", "expectedRuntimeSha", "publicUrl",
    "recorderSource", "capturedAt", "finishedAt", "evidenceManifestPath", "evidenceManifestSha256",
    "reviewerCredentialUsed", "reviewerCredentialRendered", "durableReviewerWritesCreated",
    "publicSeed", "canonicalQuestionSource", "recallProof", "actions", "rawVideo", "frameDiversity",
    "poster",
}
RECALL_PROOF_KEYS = {
    "question", "company", "requestLimit", "modelId", "grounding", "citationCount", "answerSha256",
}
CORE_INPUT_KEYS = {
    "baseVideo", "baseManifest", "narrationAudio", "narrationManifest", "liveVideo",
    "interactionManifest", "captureReview", "canonicalSrt", "thumbnail", "captionTimeline",
}
CANONICAL_RIGHTS_PROFILE = {
    "voice": True,
    "humanVoice": False,
    "syntheticVoice": True,
    "syntheticVoiceDisclosure": True,
    "tts": True,
    "thirdPartyMusic": False,
    "thirdPartyAudio": True,
    "commercialUseRightsApproved": True,
    "audio": "entrant-approved ElevenLabs synthetic narration; no music or fallback voice",
    "humanVoiceRightsReviewRequired": True,
    "automatedProvenanceIsAuthoritativeRightsProof": False,
}
CANONICAL_AUDIO_POLICY = "disclosed entrant-approved ElevenLabs synthetic narration; no music or fallback voice"
SAFE_SELFTEST_ROOTS = {
    ".artifacts/final-video/compositor-selftest",
    ".artifacts/final-video/memory-recorder-selftest",
    ".artifacts/final-video/recording-runtime",
}


class GateError(RuntimeError):
    pass


class RollbackError(GateError):
    """A failed rollback retained private recovery material for manual repair."""


@dataclass(frozen=True)
class ImmutableInput:
    """One source path snapshotted into a private, build-owned regular file."""

    source_path: Path
    source_relative: str
    staged_path: Path
    sha256: str
    size: int

    def record(self) -> dict[str, Any]:
        return {
            "path": self.source_relative,
            "stagedPath": relative(self.staged_path),
            "sha256": self.sha256,
            "size": self.size,
        }


@dataclass(frozen=True)
class TrustedExecutable:
    """One absolute external executable pinned to its filesystem/content identity."""

    name: str
    path: Path
    trust_source: str
    path_sha256: str
    sha256: str
    size: int
    device: int
    inode: int
    mode_type: int
    link_count: int
    mtime_ns: int
    ctime_ns: int

    def record(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "trustSource": self.trust_source,
            "absolutePathSha256": self.path_sha256,
            "sha256": self.sha256,
            "size": self.size,
            "linkCount": self.link_count,
        }

    def assert_unchanged(self) -> None:
        _reject_absolute_reparse_components(
            self.path,
            f"trusted executable {self.name}",
        )
        try:
            metadata = self.path.lstat()
            still_resolved = self.path.resolve(strict=True)
        except OSError as exc:
            raise GateError(f"trusted executable {self.name} disappeared") from exc
        require(still_resolved == self.path,
                f"trusted executable {self.name} changed its resolved path")
        require(stat.S_ISREG(metadata.st_mode) and not _is_reparse(metadata),
                f"trusted executable {self.name} is no longer a regular file")
        _require_allowed_executable_link_count(self.name, metadata.st_nlink)
        require(
            (
                metadata.st_dev,
                metadata.st_ino,
                stat.S_IFMT(metadata.st_mode),
                metadata.st_nlink,
                metadata.st_size,
                metadata.st_mtime_ns,
                metadata.st_ctime_ns,
            )
            == (
                self.device,
                self.inode,
                self.mode_type,
                self.link_count,
                self.size,
                self.mtime_ns,
                self.ctime_ns,
            ),
            f"trusted executable {self.name} changed identity after resolution",
        )

    def verified_record(self) -> dict[str, Any]:
        current = _snapshot_trusted_executable(self.name, self.path, self.trust_source)
        require(current.record() == self.record(),
                f"trusted executable {self.name} changed bytes after resolution")
        return current.record()


@dataclass(frozen=True)
class OwnedPath:
    """A path entry whose exact identity belongs to the active promotion transaction."""

    path: Path
    device: int
    inode: int
    mode_type: int

    @classmethod
    def capture(cls, path: Path, label: str) -> "OwnedPath":
        try:
            metadata = path.lstat()
        except OSError as exc:
            raise GateError(f"{label} disappeared while its identity was captured") from exc
        require(stat.S_ISREG(metadata.st_mode) and not _is_reparse(metadata),
                f"{label} must be a non-reparse regular file")
        return cls(path, metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode))

    def still_owned(self) -> bool:
        try:
            metadata = self.path.lstat()
        except FileNotFoundError:
            return False
        return (
            metadata.st_dev,
            metadata.st_ino,
            stat.S_IFMT(metadata.st_mode),
        ) == (self.device, self.inode, self.mode_type)


_TRUSTED_EXECUTABLE_CACHE: dict[str, TrustedExecutable] = {}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def require_exact_keys(payload: Any, expected: set[str], label: str) -> dict[str, Any]:
    require(isinstance(payload, dict), f"{label} must be a JSON object")
    actual = set(payload)
    require(actual == expected, f"{label} fields differ from the canonical contract")
    return payload


def _is_reparse(metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(reparse_flag and attributes & reparse_flag)


def _reject_absolute_reparse_components(path: Path, label: str) -> None:
    """Reject indirection in every component of one existing absolute path."""

    require(path.is_absolute(), f"{label} must be absolute")
    parts = path.parts
    require(bool(parts), f"{label} has no filesystem components")
    current = Path(parts[0])
    for part in parts:
        if part != parts[0]:
            current /= part
        try:
            metadata = current.lstat()
        except OSError as exc:
            raise GateError(f"{label} has an unreadable path component") from exc
        require(not _is_reparse(metadata),
                f"{label} must not traverse a symlink or reparse point")


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


def _require_allowed_executable_link_count(name: str, link_count: int) -> None:
    if name == "git":
        require(link_count >= 1, "trusted executable git has no filesystem link")
    else:
        require(link_count == 1,
                f"trusted executable {name} must have exactly one filesystem link")


def _snapshot_trusted_executable(name: str, path: Path, trust_source: str) -> TrustedExecutable:
    """Hash a stable external executable through a verified descriptor."""

    _reject_absolute_reparse_components(path, f"trusted executable {name}")
    try:
        before_path = path.lstat()
    except OSError as exc:
        raise GateError(f"trusted executable {name} is unavailable") from exc
    require(stat.S_ISREG(before_path.st_mode) and not _is_reparse(before_path),
            f"trusted executable {name} must be a non-reparse regular file")
    _require_allowed_executable_link_count(name, before_path.st_nlink)
    require(os.access(path, os.X_OK), f"trusted executable {name} is not executable")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        descriptor = os.open(path, flags)
        before_fd = os.fstat(descriptor)
        require(
            stat.S_ISREG(before_fd.st_mode)
            and before_fd.st_nlink == before_path.st_nlink
            and _same_file_identity(before_path, before_fd),
                f"trusted executable {name} changed before it could be read")
        _require_allowed_executable_link_count(name, before_fd.st_nlink)
        digest = hashlib.sha256()
        size = 0
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
            size += len(block)
        after_fd = os.fstat(descriptor)
    except OSError as exc:
        raise GateError(f"trusted executable {name} could not be read safely") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    try:
        after_path = path.lstat()
        _reject_absolute_reparse_components(path, f"trusted executable {name}")
        still_resolved = path.resolve(strict=True)
    except OSError as exc:
        raise GateError(f"trusted executable {name} disappeared while it was read") from exc
    require(
        still_resolved == path
        and before_path.st_nlink == before_fd.st_nlink == after_fd.st_nlink == after_path.st_nlink
        and
        _same_file_identity(before_path, before_fd)
        and _same_file_identity(before_fd, after_fd)
        and _same_file_identity(after_fd, after_path)
        and before_fd.st_size == after_fd.st_size == size
        and before_fd.st_mtime_ns == after_fd.st_mtime_ns
        and before_fd.st_ctime_ns == after_fd.st_ctime_ns,
        f"trusted executable {name} changed while it was read",
    )
    _require_allowed_executable_link_count(name, after_fd.st_nlink)
    canonical_path = os.path.normcase(os.path.normpath(str(path)))
    return TrustedExecutable(
        name=name,
        path=path,
        trust_source=trust_source,
        path_sha256=hashlib.sha256(canonical_path.encode("utf-8")).hexdigest(),
        sha256=digest.hexdigest(),
        size=size,
        device=after_fd.st_dev,
        inode=after_fd.st_ino,
        mode_type=stat.S_IFMT(after_fd.st_mode),
        link_count=after_fd.st_nlink,
        mtime_ns=after_fd.st_mtime_ns,
        ctime_ns=after_fd.st_ctime_ns,
    )


def clear_trusted_executable_cache() -> None:
    """Clear process-local tool resolution state for focused tests."""

    _TRUSTED_EXECUTABLE_CACHE.clear()


def _trusted_executable_filename(name: str) -> str:
    require(name in TRUSTED_EXECUTABLE_ENV, f"unsupported trusted executable {name}")
    return f"{name}.exe" if os.name == "nt" else name


def _discover_fixture_executable(name: str) -> Path:
    """Find one unambiguous PATH candidate only for a non-production self-test."""

    expected_name = _trusted_executable_filename(name)
    candidates: dict[str, Path] = {}
    repository = ROOT.resolve(strict=True)
    working_directory = Path.cwd().resolve(strict=True)
    for raw_entry in os.environ.get("PATH", "").split(os.pathsep):
        entry = raw_entry.strip()
        if len(entry) >= 2 and entry[0] == entry[-1] == '"':
            entry = entry[1:-1]
        if not entry:
            continue
        directory = Path(entry)
        if not directory.is_absolute():
            continue
        lexical_directory = Path(os.path.abspath(directory))
        if lexical_directory == working_directory:
            continue
        try:
            lexical_directory.relative_to(repository)
        except ValueError:
            pass
        else:
            continue
        candidate = lexical_directory / expected_name
        try:
            _reject_absolute_reparse_components(candidate, f"fixture-discovered executable {name}")
            resolved = candidate.resolve(strict=True)
            metadata = candidate.lstat()
        except (GateError, FileNotFoundError, OSError, RuntimeError):
            continue
        if resolved != candidate or not stat.S_ISREG(metadata.st_mode) or _is_reparse(metadata):
            continue
        try:
            _require_allowed_executable_link_count(name, metadata.st_nlink)
        except GateError:
            continue
        if os.name != "nt" and not os.access(candidate, os.X_OK):
            continue
        candidates[os.path.normcase(os.path.normpath(str(resolved)))] = resolved

    require(
        len(candidates) == 1,
        f"self-test {name} discovery requires exactly one complete non-reparse PATH candidate; "
        f"set {TRUSTED_EXECUTABLE_ENV[name]} explicitly when PATH is ambiguous",
    )
    return next(iter(candidates.values()))


def resolve_trusted_executable(name: str, *, allow_discovery: bool | None = None) -> TrustedExecutable:
    """Resolve an explicitly trusted production tool or a fixture-only discovery."""

    require(name in TRUSTED_EXECUTABLE_ENV, f"unsupported trusted executable {name}")
    cached = _TRUSTED_EXECUTABLE_CACHE.get(name)
    if cached is not None:
        require(allow_discovery is not False or cached.trust_source != "fixture-discovery",
                f"{TRUSTED_EXECUTABLE_ENV[name]} must explicitly bind the production {name} executable")
        cached.assert_unchanged()
        return cached

    environment_name = TRUSTED_EXECUTABLE_ENV[name]
    override = os.environ.get(environment_name)
    if override:
        candidate = Path(override)
        require(candidate.is_absolute(), f"{environment_name} must be an absolute path")
        trust_source = environment_name
    else:
        require(allow_discovery is True,
                f"{environment_name} must explicitly bind the production {name} executable")
        candidate = _discover_fixture_executable(name)
        trust_source = "fixture-discovery"
    lexical = Path(os.path.abspath(candidate))
    expected_name = _trusted_executable_filename(name)
    names_match = lexical.name.casefold() == expected_name.casefold() if os.name == "nt" else lexical.name == expected_name
    require(names_match, f"{environment_name} must name exact {expected_name}")
    _reject_absolute_reparse_components(lexical, f"trusted executable {name}")
    try:
        resolved = lexical.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise GateError(f"trusted executable {name} could not be resolved") from exc
    require(resolved.is_absolute(), f"trusted executable {name} did not resolve absolutely")
    require(resolved == lexical,
            f"trusted executable {name} must not resolve through path indirection")
    try:
        resolved.relative_to(ROOT.resolve(strict=True))
    except ValueError:
        pass
    else:
        raise GateError(f"trusted executable {name} must not come from this repository")
    if not override:
        try:
            cwd = Path.cwd().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise GateError("current directory could not be resolved for executable trust") from exc
        require(resolved.parent != cwd,
                f"trusted executable {name} must not be selected from the current directory")
    trusted = _snapshot_trusted_executable(name, resolved, trust_source)
    _TRUSTED_EXECUTABLE_CACHE[name] = trusted
    return trusted


def trusted_toolchain_records(*, allow_discovery: bool = False) -> dict[str, dict[str, Any]]:
    executables = {
        name: resolve_trusted_executable(name, allow_discovery=allow_discovery)
        for name in sorted(TRUSTED_EXECUTABLE_ENV)
    }
    require(
        executables["ffmpeg"].path.parent == executables["ffprobe"].path.parent,
        "trusted ffmpeg and ffprobe executables must be sibling files from one toolchain directory",
    )
    return {name: executable.verified_record() for name, executable in executables.items()}


def validate_trusted_toolchain(record: Any, *, allow_discovery: bool = False) -> None:
    require(isinstance(record, dict) and set(record) == set(TRUSTED_EXECUTABLE_ENV),
            "final manifest trusted toolchain inventory is incomplete")
    require(record == trusted_toolchain_records(allow_discovery=allow_discovery),
            "final manifest trusted executable identity differs from this verifier")


def _run_git(
    arguments: Sequence[str],
    *,
    input_bytes: bytes | None = None,
) -> subprocess.CompletedProcess[bytes]:
    executable = resolve_trusted_executable("git")
    executable.assert_unchanged()
    try:
        return subprocess.run(
            [str(executable.path), *arguments],
            check=False,
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    finally:
        executable.assert_unchanged()


def run_tool(
    name: str,
    arguments: Sequence[str],
    label: str,
    *,
    binary: bool = False,
) -> bytes | str:
    executable = resolve_trusted_executable(name)
    executable.assert_unchanged()
    try:
        completed = subprocess.run(
            [str(executable.path), *arguments],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    finally:
        executable.assert_unchanged()
    if completed.returncode != 0:
        diagnostic = completed.stderr.decode("utf-8", errors="replace")[-3000:]
        raise GateError(f"{label} failed: {diagnostic}")
    return completed.stdout if binary else completed.stdout.decode("utf-8", errors="strict")


def create_private_build_session(scratch: Path) -> Path:
    """Create an unpredictable, project-contained staging directory for one transaction."""

    scratch = project_path(scratch, "compose scratch")
    safe_root = Path(os.path.abspath(ROOT / ".artifacts" / "final-video"))
    try:
        scratch_relative = scratch.relative_to(safe_root)
    except ValueError as exc:
        raise GateError("compose scratch must be under .artifacts/final-video") from exc
    require(scratch_relative.parts not in {(), (".",)},
            "compose scratch must be a dedicated child of .artifacts/final-video")
    scratch.mkdir(parents=True, exist_ok=True)
    metadata = scratch.lstat()
    require(stat.S_ISDIR(metadata.st_mode) and not _is_reparse(metadata),
            "compose scratch must be a real directory")
    session = Path(tempfile.mkdtemp(prefix="memoryagent-compose-private-", dir=scratch))
    require(session.parent == scratch and not _is_reparse(session.lstat()),
            "private compose session escaped its scratch root")
    try:
        session.chmod(0o700)
    except OSError as exc:
        raise GateError("private compose session permissions could not be restricted") from exc
    return session


def _remove_tree(path: Path) -> None:
    """Remove one narrow final-video tree after rejecting path indirection."""

    repository = Path(os.path.abspath(ROOT))
    safe_root = repository / ".artifacts" / "final-video"
    target = Path(os.path.abspath(path))
    try:
        relative_target = target.relative_to(safe_root)
    except ValueError as exc:
        raise GateError("cleanup target must stay under .artifacts/final-video") from exc
    require(relative_target.parts not in {(), (".",)},
            "cleanup target must be narrower than .artifacts/final-video")

    # Resolve no component here: resolution would hide a junction or symlink.
    # Every extant ancestor through the exact target must be a real directory.
    current = repository
    for part in (".artifacts", "final-video", *relative_target.parts):
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return
        require(stat.S_ISDIR(metadata.st_mode), "cleanup path components must be directories")
        require(not _is_reparse(metadata), "cleanup target must not traverse a symlink or reparse point")

    def make_writable_and_retry(function: Any, target: str, _error: Any) -> None:
        target_path = Path(target)
        target_path.chmod(stat.S_IWRITE | stat.S_IREAD)
        function(target)

    shutil.rmtree(target, onerror=make_writable_and_retry)


def _exclusive_write(path: Path, content: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        view = memoryview(content)
        written = 0
        while written < len(view):
            count = os.write(descriptor, view[written:])
            require(count > 0, "immutable staging write made no progress")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def stage_snapshot(
    snapshot: ProjectFileSnapshot,
    session: Path,
    destination_name: str,
) -> ImmutableInput:
    """Materialize exactly the read-once bytes and make the retained copy read-only."""

    require(Path(destination_name).name == destination_name and destination_name not in {"", ".", ".."},
            "immutable staging destination name is invalid")
    destination = session / destination_name
    _exclusive_write(destination, snapshot.data)
    require(sha256_file(destination) == snapshot.sha256 and destination.stat().st_size == snapshot.size,
            f"immutable staged copy of {snapshot.relative_path} differs from its read-once bytes")
    try:
        destination.chmod(stat.S_IREAD)
    except OSError as exc:
        destination.unlink(missing_ok=True)
        raise GateError(f"immutable staged copy of {snapshot.relative_path} could not be made read-only") from exc
    return ImmutableInput(
        source_path=snapshot.path,
        source_relative=snapshot.relative_path,
        staged_path=destination,
        sha256=snapshot.sha256,
        size=snapshot.size,
    )


def stage_project_input(
    source: Path,
    label: str,
    session: Path,
    destination_name: str,
) -> ImmutableInput:
    try:
        snapshot = read_project_file_once(source, label)
    except ValueError as exc:
        raise GateError(str(exc)) from exc
    return stage_snapshot(snapshot, session, destination_name)


def safe_reset_artifact_directory(relative_path: str, label: str) -> Path:
    require(relative_path in SAFE_SELFTEST_ROOTS, f"{label} cleanup target is not allowlisted")
    root = Path(os.path.abspath(ROOT / relative_path))
    try:
        relative = root.relative_to(ROOT.resolve(strict=True))
    except (OSError, RuntimeError, ValueError) as exc:
        raise GateError(f"{label} escaped the repository") from exc
    require(relative.as_posix() == relative_path, f"{label} cleanup target is not canonical")
    current = ROOT.resolve(strict=True)
    for part in relative.parts:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            break
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        attributes = getattr(metadata, "st_file_attributes", 0)
        require(
            not stat.S_ISLNK(metadata.st_mode)
            and not bool(reparse_flag and attributes & reparse_flag),
            f"{label} must not traverse a symlink or reparse point",
        )
    try:
        metadata = root.lstat()
    except FileNotFoundError:
        return root
    require(stat.S_ISDIR(metadata.st_mode), f"{label} is not a directory")
    _remove_tree(root)
    return root


def project_path(value: str | Path, label: str, *, exists: bool = False) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    resolved = candidate.resolve(strict=exists)
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise GateError(f"{label} must stay inside this repository") from exc
    if exists:
        require(resolved.is_file(), f"{label} must be a regular file")
        require(not resolved.is_symlink(), f"{label} must not be a symlink")
        require(resolved.stat().st_nlink == 1, f"{label} must have exactly one hard link")
    return resolved


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tracked_source_record(relative_path: str, label: str, *, require_head: bool) -> dict[str, Any]:
    try:
        snapshot = read_project_file_once(relative_path, label)
    except ValueError as exc:
        raise GateError(str(exc)) from exc
    if require_head:
        tracked = _run_git(
            ["-C", str(ROOT), "ls-files", "--error-unmatch", "--", relative_path],
        )
        require(tracked.returncode == 0, f"{label} must be committed before a production build")
        cleaned = _run_git(
            ["-C", str(ROOT), "hash-object", f"--path={relative_path}", "--stdin"],
            input_bytes=snapshot.data,
        )
        require(cleaned.returncode == 0, f"{label} snapshot could not be mapped to a Git blob")
        head = _run_git(
            ["-C", str(ROOT), "rev-parse", f"HEAD:{relative_path}"],
        )
        require(head.returncode == 0, f"cannot read {label} blob from final source HEAD")
        require(cleaned.stdout.strip() == head.stdout.strip(),
                f"{label} differs from final source HEAD after Git clean filtering")
    return {"path": snapshot.relative_path, "sha256": snapshot.sha256, "size": snapshot.size}


def current_source_head() -> str:
    completed = _run_git(["-C", str(ROOT), "rev-parse", "HEAD"])
    require(completed.returncode == 0, "cannot read the final source HEAD")
    try:
        head = completed.stdout.decode("ascii", errors="strict").strip()
    except UnicodeDecodeError as exc:
        raise GateError("final source HEAD is not ASCII") from exc
    require(bool(SHA_RE.fullmatch(head)), "final source HEAD is not an exact 40-character SHA")
    return head


def require_builder_source_head(base_manifest: dict[str, Any], *, expected_head: str | None = None) -> str:
    head = expected_head if expected_head is not None else current_source_head()
    require(bool(SHA_RE.fullmatch(head)), "expected builder source HEAD is not an exact 40-character SHA")
    require(base_manifest.get("builderSourceHead") == head,
            "caption-base builderSourceHead differs from the current final source HEAD")
    return head


def require_tracked_source(
    record: Any,
    relative_path: str,
    label: str,
    *,
    require_head: bool,
) -> dict[str, Any]:
    require(isinstance(record, dict), f"caption-base manifest has no {label} record")
    current = tracked_source_record(relative_path, label, require_head=require_head)
    require(record == current, f"caption-base {label} binding is stale")
    return current


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{label} is not valid UTF-8 JSON") from exc
    require(isinstance(payload, dict), f"{label} must be a JSON object")
    return payload


def ffprobe(path: Path) -> dict[str, Any]:
    raw = run_tool(
        "ffprobe",
        ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)],
        f"ffprobe {relative(path)}",
    )
    try:
        return json.loads(str(raw))
    except json.JSONDecodeError as exc:
        raise GateError("ffprobe returned invalid JSON") from exc


def media_summary(path: Path) -> dict[str, Any]:
    probe = ffprobe(path)
    streams = probe.get("streams", [])
    videos = [row for row in streams if row.get("codec_type") == "video"]
    audios = [row for row in streams if row.get("codec_type") == "audio"]
    require(len(videos) == 1, f"{relative(path)} must contain exactly one video stream")
    duration = float(probe.get("format", {}).get("duration") or videos[0].get("duration") or 0)
    require(math.isfinite(duration) and duration > 0, f"{relative(path)} has no positive duration")
    video = videos[0]
    return {
        "durationSeconds": round(duration, 6),
        "videoStreamCount": len(videos),
        "audioStreamCount": len(audios),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "videoCodec": video.get("codec_name"),
        "pixelFormat": video.get("pix_fmt"),
        "averageFrameRate": video.get("avg_frame_rate"),
        "frameCount": (
            int(video["nb_read_frames"])
            if str(video.get("nb_read_frames", "")).isdigit()
            else int(video["nb_frames"])
            if str(video.get("nb_frames", "")).isdigit()
            else None
        ),
        "audioCodec": audios[0].get("codec_name") if audios else None,
        "audioSampleRate": int(audios[0].get("sample_rate") or 0) if audios else None,
        "audioChannels": int(audios[0].get("channels") or 0) if audios else None,
    }


def frame_rate(value: str | None) -> float:
    if not value or "/" not in value:
        return 0.0
    numerator, denominator = value.split("/", 1)
    return float(numerator) / float(denominator) if float(denominator) else 0.0


def decoded_audio_stats(path: Path) -> dict[str, Any]:
    """Measure normalized decoded PCM without trusting container loudness metadata."""
    executable = resolve_trusted_executable("ffmpeg")
    command = [
        str(executable.path), "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0", "-vn",
        "-ac", str(AUDIO_CHANNELS), "-ar", str(AUDIO_SAMPLE_RATE), "-f", "s16le", "-",
    ]
    executable.assert_unchanged()
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    require(process.stdout is not None and process.stderr is not None, "failed to open decoded-audio verifier")
    total_samples = 0
    sum_squares = 0
    peak = 0
    active_samples = 0
    clipped_samples = 0
    pcm_digest = hashlib.sha256()
    remainder = b""
    while True:
        chunk = process.stdout.read(1024 * 1024)
        if not chunk:
            break
        content = remainder + chunk
        aligned = len(content) - (len(content) % 2)
        decoded = content[:aligned]
        remainder = content[aligned:]
        if not decoded:
            continue
        pcm_digest.update(decoded)
        samples = array.array("h")
        samples.frombytes(decoded)
        if sys.byteorder != "little":
            samples.byteswap()
        total_samples += len(samples)
        for sample in samples:
            absolute = abs(int(sample))
            peak = max(peak, absolute)
            sum_squares += absolute * absolute
            active_samples += int(absolute >= ACTIVE_SAMPLE_THRESHOLD)
            clipped_samples += int(absolute >= CLIPPING_SAMPLE_THRESHOLD)
    stderr = process.stderr.read().decode("utf-8", errors="replace")
    return_code = process.wait()
    executable.assert_unchanged()
    require(return_code == 0, f"decoded-audio verification failed: {stderr[-2000:]}")
    require(not remainder, "decoded PCM byte count is not sample-aligned")
    require(total_samples > 0, "decoded audio contains no PCM samples")
    duration = total_samples / (AUDIO_SAMPLE_RATE * AUDIO_CHANNELS)
    return {
        "normalization": "signed-16 little-endian, 48 kHz, stereo",
        "sampleRate": AUDIO_SAMPLE_RATE,
        "channels": AUDIO_CHANNELS,
        "totalSamples": total_samples,
        "durationSeconds": round(duration, 6),
        "peakS16": peak,
        "rmsS16": round(math.sqrt(sum_squares / total_samples), 3),
        "activeThresholdS16": ACTIVE_SAMPLE_THRESHOLD,
        "activeSamples": active_samples,
        "activeSampleRatio": round(active_samples / total_samples, 6),
        "clippingThresholdS16": CLIPPING_SAMPLE_THRESHOLD,
        "clippedSamples": clipped_samples,
        "pcmSha256": pcm_digest.hexdigest(),
    }


def require_narration_quality(stats: dict[str, Any], label: str) -> None:
    require(int(stats.get("peakS16") or 0) >= MIN_NARRATION_PEAK_S16,
            f"{label} decodes to digital silence or near-silence")
    require(float(stats.get("rmsS16") or 0) >= MIN_NARRATION_RMS_S16,
            f"{label} decoded RMS is too low to prove audible narration")
    require(float(stats.get("activeSampleRatio") or 0) >= MIN_NARRATION_ACTIVE_RATIO,
            f"{label} contains too little active speech")
    require(int(stats.get("clippedSamples") or 0) == 0,
            f"{label} contains decoded clipping at or above {CLIPPING_SAMPLE_THRESHOLD}")


def require_audio_preserved(base: dict[str, Any], final: dict[str, Any]) -> None:
    require(base.get("pcmSha256") == final.get("pcmSha256"),
            "final decoded narration differs from the base AAC stream")
    require(base.get("totalSamples") == final.get("totalSamples"),
            "final decoded narration sample count differs from the base AAC stream")


def ebur128_stats(path: Path) -> dict[str, float]:
    executable = resolve_trusted_executable("ffmpeg")
    executable.assert_unchanged()
    try:
        completed = subprocess.run(
            [
                str(executable.path), "-nostdin", "-hide_banner", "-nostats", "-i", str(path),
                "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-",
            ],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    finally:
        executable.assert_unchanged()
    require(completed.returncode == 0, f"EBU R128 analysis failed for {relative(path)}")
    summary = completed.stderr.rsplit("Summary:", 1)
    require(len(summary) == 2, f"EBU R128 summary is absent for {relative(path)}")

    def metric(pattern: str, label: str) -> float:
        match = re.search(pattern, summary[1], re.MULTILINE)
        require(match is not None, f"EBU R128 {label} is absent for {relative(path)}")
        value = float(match.group(1))
        require(math.isfinite(value), f"EBU R128 {label} is not finite for {relative(path)}")
        return value

    measured = {
        "integratedLufs": metric(r"Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?)\s+LUFS", "integrated loudness"),
        "loudnessRangeLu": metric(r"Loudness range:\s+LRA:\s+(-?\d+(?:\.\d+)?)\s+LU", "loudness range"),
        "truePeakDbfs": metric(r"True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS", "true peak"),
    }
    require(MIN_INTEGRATED_LUFS <= measured["integratedLufs"] <= MAX_INTEGRATED_LUFS,
            f"{relative(path)} integrated loudness is outside the reviewed narration range")
    require(0.0 <= measured["loudnessRangeLu"] <= MAX_LOUDNESS_RANGE_LU,
            f"{relative(path)} loudness range is too wide")
    require(measured["truePeakDbfs"] <= MAX_TRUE_PEAK_DBFS,
            f"{relative(path)} true peak leaves less than 1 dB of headroom")
    return measured


def frame_hashes(path: Path, *, start: float = 0.0, duration: float | None = None) -> list[str]:
    command = ["-v", "error"]
    if start > 0:
        command += ["-ss", f"{start:.6f}"]
    command += ["-i", str(path)]
    if duration is not None:
        command += ["-t", f"{duration:.6f}"]
    command += ["-vf", "fps=2,scale=320:-2", "-an", "-f", "framemd5", "-"]
    text = str(run_tool("ffmpeg", command, f"sample frame diversity for {relative(path)}"))
    hashes = []
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) >= 6 and re.fullmatch(r"[0-9a-f]{32}", parts[-1]):
            hashes.append(parts[-1])
    return hashes


def diversity(path: Path, *, start: float = 0.0, duration: float | None = None) -> dict[str, Any]:
    hashes = frame_hashes(path, start=start, duration=duration)
    require(len(hashes) >= 8, f"{relative(path)} produced too few diversity samples")
    unique = len(set(hashes))
    longest = 1
    run_length = 1
    for left, right in zip(hashes, hashes[1:]):
        run_length = run_length + 1 if left == right else 1
        longest = max(longest, run_length)
    return {
        "sampleRateFps": 2,
        "samples": len(hashes),
        "uniqueFrames": unique,
        "uniqueRatio": round(unique / len(hashes), 4),
        "longestIdenticalRunSamples": longest,
    }


def srt_seconds(value: str) -> float:
    match = SRT_TIME_RE.fullmatch(value.strip())
    require(match is not None, f"invalid SRT timestamp: {value!r}")
    h, m, s, ms = [int(part) for part in match.groups()]
    return h * 3600 + m * 60 + s + ms / 1000


def canonical_srt_bytes(windows: Sequence[tuple[int, int, str]]) -> bytes:
    def timestamp(seconds: int) -> str:
        hours, remainder = divmod(seconds, 3600)
        minutes, secs = divmod(remainder, 60)
        return f"{hours:02d}:{minutes:02d}:{secs:02d},000"

    blocks = [
        f"{index}\n{timestamp(start)} --> {timestamp(end)}\n{text}\n"
        for index, (start, end, text) in enumerate(windows, start=1)
    ]
    return "\n".join(blocks).encode("utf-8")


def validate_srt(path: Path, duration: float) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    require("\r" not in text, "SRT must use canonical LF line endings")
    windows = []
    for line in text.splitlines():
        if " --> " not in line:
            continue
        start, end = line.split(" --> ", 1)
        windows.append((srt_seconds(start), srt_seconds(end)))
    require(windows, "SRT has no timed cues")
    previous = 0.0
    for start, end in windows:
        require(0 <= start < end <= duration + 0.05, "SRT cue is outside the final video")
        require(start + 1e-6 >= previous, "SRT cues overlap or are non-monotonic")
        previous = end
    return {"cues": len(windows), "firstStart": windows[0][0], "lastEnd": windows[-1][1]}


def evidence_runtime_sha(payload: dict[str, Any]) -> str:
    candidates = [payload.get("exactRuntimeSource"), payload.get("exactDeployedApplicationSha")]
    values = [str(value) for value in candidates if isinstance(value, str)]
    require(len(values) == 1 and SHA_RE.fullmatch(values[0]) is not None,
            "CAPTURE_REVIEW has no unambiguous exact deployed application SHA")
    return values[0]


def _logical_relative(staged_path: Path, source_path: Path | None) -> str:
    if source_path is None:
        return relative(staged_path)
    lexical = Path(os.path.abspath(source_path))
    try:
        return lexical.relative_to(ROOT).as_posix()
    except ValueError as exc:
        raise GateError("logical input source escaped the repository") from exc


def validate_recall_proof(payload: Any, canonical_question: str) -> dict[str, Any]:
    proof = require_exact_keys(payload, RECALL_PROOF_KEYS, "interaction recallProof")
    require(proof.get("question") == canonical_question, "interaction recall proof question is noncanonical")
    require(proof.get("company") == "Northwind Trading", "interaction recall proof company is noncanonical")
    require(type(proof.get("requestLimit")) is int and proof.get("requestLimit") == 3,
            "interaction recall proof must use exact integer limit=3")
    require(proof.get("modelId") == "qwen-plus", "interaction recall proof did not use qwen-plus")
    grounding = require_exact_keys(proof.get("grounding"), {"status", "attempts"},
                                   "interaction recallProof.grounding")
    require((grounding.get("status"), grounding.get("attempts")) in (("passed", 1), ("repaired", 2)),
            "interaction recall proof grounding pair is invalid")
    require(type(proof.get("citationCount")) is int and 1 <= proof["citationCount"] <= 3,
            "interaction recall proof citation count is invalid")
    require(isinstance(proof.get("answerSha256"), str)
            and SHA256_RE.fullmatch(proof["answerSha256"]) is not None,
            "interaction recall proof answer SHA-256 is invalid")
    return proof


def validate_exact_deployment_binding(
    evidence: dict[str, Any],
    expected_sha: str,
    status_input: ImmutableInput,
    output_input: ImmutableInput,
) -> dict[str, Any]:
    gates = evidence.get("gates")
    require(isinstance(gates, dict), "CAPTURE_REVIEW has no gate results")
    require(gates.get("exactDeploymentEvidence") is True,
            "CAPTURE_REVIEW does not prove exact deployment evidence")
    require(gates.get("reviewerCredentialRendered") is False,
            "CAPTURE_REVIEW does not prove reviewer credentials stayed out of media")
    evidence_mode = gates.get("exactDeploymentEvidenceMode")
    require(evidence_mode in {STRICT_FINAL_MARKER, TERMINAL_SUCCESS_TRUNCATED_OUTPUT},
            "CAPTURE_REVIEW exact deployment mode is not recognized")
    deployment = require_exact_keys(
        evidence.get("deploymentEvidence"),
        {"mode", "producer", "status", "output"},
        "CAPTURE_REVIEW deploymentEvidence",
    )
    require(deployment.get("mode") == evidence_mode,
            "CAPTURE_REVIEW deployment evidence mode is inconsistent")
    producer = require_exact_keys(
        deployment.get("producer"),
        {"invocationId", "commandId", "outputSha256", "outputBytes"},
        "CAPTURE_REVIEW deployment producer",
    )
    for field in ("invocationId", "commandId"):
        require(isinstance(producer.get(field), str) and bool(producer[field].strip()),
                f"CAPTURE_REVIEW deployment producer {field} is invalid")
    for name, staged in (("status", status_input), ("output", output_input)):
        record = require_exact_keys(deployment.get(name), {"path", "sha256", "size"},
                                    f"CAPTURE_REVIEW deployment {name}")
        require(record == {
            "path": staged.source_relative,
            "sha256": staged.sha256,
            "size": staged.size,
        }, f"CAPTURE_REVIEW deployment {name} binding differs from immutable staging")
    require(producer.get("outputSha256") == output_input.sha256
            and producer.get("outputBytes") == output_input.size,
            "CAPTURE_REVIEW deployment producer output binding is inconsistent")
    status = read_json(status_input.staged_path, "immutable deployment status")
    require(producer.get("invocationId") == status.get("invocationId")
            and producer.get("commandId") == status.get("commandId"),
            "CAPTURE_REVIEW deployment producer identity differs from immutable status")
    try:
        observed_mode = validate_exact_deploy_evidence(
            expected_sha,
            status,
            output_input.staged_path.read_bytes(),
        )
    except ExactDeployEvidenceError as exc:
        raise GateError(str(exc)) from exc
    require(observed_mode == evidence_mode,
            "immutable deployment bytes differ from the CAPTURE_REVIEW evidence mode")
    return deployment


def validate_bindings(
    *, expected_sha: str, expected_url: str, evidence_path: Path,
    interaction_path: Path, live_video: Path, allow_fixture: bool,
    evidence_source: Path | None = None, interaction_source: Path | None = None,
    live_video_source: Path | None = None, poster_input: ImmutableInput | None = None,
    deployment_status_input: ImmutableInput | None = None,
    deployment_output_input: ImmutableInput | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    require(SHA_RE.fullmatch(expected_sha) is not None, "--expected-sha must be 40 lowercase hex characters")
    evidence = read_json(evidence_path, "CAPTURE_REVIEW")
    interaction = read_json(interaction_path, "interaction manifest")
    require(evidence.get("status") == "passed", "CAPTURE_REVIEW status is not passed")
    require(evidence_runtime_sha(evidence) == expected_sha, "CAPTURE_REVIEW exact SHA does not match --expected-sha")
    if not allow_fixture:
        require(evidence.get("schemaVersion") == 3, "CAPTURE_REVIEW is not canonical schema-v3")
        require(evidence.get("liveBaseUrl") == expected_url, "CAPTURE_REVIEW public origin mismatch")
        require(isinstance(evidence.get("submissionPackHeadAtCapture"), str)
                and SHA_RE.fullmatch(evidence["submissionPackHeadAtCapture"]) is not None,
                "CAPTURE_REVIEW submission source identity is invalid")
        require(deployment_status_input is not None and deployment_output_input is not None,
                "production validation requires immutable deployment evidence")
        validate_exact_deployment_binding(
            evidence,
            expected_sha,
            deployment_status_input,
            deployment_output_input,
        )
        require_exact_keys(interaction, PRODUCTION_INTERACTION_KEYS, "interaction manifest")
    else:
        require(interaction.get("schemaVersion") == 1, "fixture interaction manifest is not schema-v1")
    require(interaction.get("status") == "passed", "interaction manifest status is not passed")
    require(interaction.get("expectedRuntimeSha") == expected_sha, "interaction manifest exact SHA mismatch")
    require(interaction.get("publicUrl") == expected_url, "interaction manifest public origin mismatch")
    for field in ("reviewerCredentialRendered", "reviewerCredentialUsed", "durableReviewerWritesCreated"):
        require(interaction.get(field) is False, f"interaction manifest {field} must be exactly false")
    expected_evidence_relative = _logical_relative(evidence_path, evidence_source)
    require(interaction.get("evidenceManifestPath") == expected_evidence_relative,
            "interaction manifest CAPTURE_REVIEW path binding is stale")
    require(interaction.get("evidenceManifestSha256") == sha256_file(evidence_path),
            "interaction manifest is not bound to these CAPTURE_REVIEW bytes")
    expected_recorder_source = tracked_source_record(
        "demo/tools/record_live_motion.py",
        "live motion recorder source",
        require_head=not allow_fixture,
    )
    require(interaction.get("recorderSource") == expected_recorder_source,
            "interaction manifest live-recorder source binding is stale")
    if not allow_fixture:
        require(interaction.get("mode") == "live", "production requires a live interaction manifest")
        require(interaction.get("submissionEligible") is True, "interaction is marked non-submission/draft")
        require(interaction.get("publicSeed") == "idempotent canonical demo seed",
                "interaction manifest public seed is noncanonical")
        canonical_source = tracked_source_record(
            "scripts/capture_submission_gallery.py",
            "canonical capture-question source",
            require_head=True,
        )
        expected_question_source = {
            "path": canonical_source["path"],
            "sha256": canonical_source["sha256"],
            "question": EXPECTED_CAPTURE_QUESTION,
        }
        require(interaction.get("canonicalQuestionSource") == expected_question_source,
                "interaction manifest canonicalQuestionSource is stale or noncanonical")
        validate_recall_proof(interaction.get("recallProof"), EXPECTED_CAPTURE_QUESTION)
    else:
        require(interaction.get("mode") == "fixture", "fixture interaction mode is invalid")
        require(interaction.get("submissionEligible") is False, "fixture interaction became submission-eligible")
    raw = interaction.get("rawVideo")
    require(isinstance(raw, dict), "interaction manifest has no rawVideo record")
    live_summary = media_summary(live_video)
    expected_raw = {
        "path": _logical_relative(live_video, live_video_source),
        "sha256": sha256_file(live_video),
        "bytes": live_video.stat().st_size,
        **live_summary,
    }
    require(raw == expected_raw, "live video record differs from immutable staged bytes")
    measured_diversity = diversity(live_video, duration=min(float(live_summary["durationSeconds"]), 30.0))
    require(interaction.get("frameDiversity") == measured_diversity,
            "interaction frame-diversity record differs from immutable staged video")
    require(isinstance(interaction.get("actions"), list) and bool(interaction["actions"]),
            "interaction manifest has no recorded action sequence")
    if poster_input is not None:
        poster_record = require_exact_keys(interaction.get("poster"), {"path", "sha256", "bytes"},
                                           "interaction poster")
        require(poster_record == {
            "path": poster_input.source_relative,
            "sha256": poster_input.sha256,
            "bytes": poster_input.size,
        }, "interaction poster differs from immutable staged bytes")
    return evidence, interaction


def require_bound_file(
    record: dict[str, Any],
    path: Path,
    label: str,
    *,
    expected_relative: str | None = None,
) -> None:
    require(record.get("path") == (expected_relative or relative(path)), f"{label} path binding mismatch")
    require(record.get("sha256") == sha256_file(path), f"{label} hash binding mismatch")
    if "size" in record:
        require(record.get("size") == path.stat().st_size, f"{label} size binding mismatch")


def validate_narration_rights(
    generated_rights: Any,
    base_rights: Any,
    *,
    allow_fixture: bool,
) -> dict[str, Any]:
    """Require the exact nested narration rights disclosure and its projection."""

    fixture_disclosure = generated_rights.get("disclosure") if isinstance(generated_rights, dict) else None
    expected_generated_rights = (
        {
            "syntheticVoiceDisclosure": True,
            "disclosure": fixture_disclosure,
            "networkUsed": False,
            "musicUsed": False,
            "thirdPartyMusic": False,
            "thirdPartyAudio": False,
            "generatedLocally": True,
            "humanVoiceRightsReviewRequired": True,
            "automatedProvenanceIsAuthoritativeRightsProof": False,
        }
        if allow_fixture
        else {
            "syntheticVoiceDisclosure": True,
            "disclosure": DISCLOSURE,
            "networkUsed": True,
            "musicUsed": False,
            "thirdPartyMusic": False,
            "thirdPartyAudio": True,
            "generatedLocally": False,
            "commercialUseRightsApproved": True,
            "humanVoiceRightsReviewRequired": True,
            "automatedProvenanceIsAuthoritativeRightsProof": False,
        }
    )
    require(generated_rights == expected_generated_rights,
            "narration manifest rights record is not the exact canonical disclosure")
    expected_base_rights = {
        key: expected_generated_rights[key]
        for key in (
            "syntheticVoiceDisclosure", "disclosure", "thirdPartyMusic",
            "humanVoiceRightsReviewRequired", "automatedProvenanceIsAuthoritativeRightsProof",
        )
    }
    if not allow_fixture:
        expected_base_rights["thirdPartyAudio"] = True
        expected_base_rights["commercialUseRightsApproved"] = True
    require(base_rights == expected_base_rights,
            "caption-base narration rights are not an exact projection of the narration manifest")
    return expected_base_rights


def validate_base_and_narration(
    *, expected_sha: str, base_video: Path, base_manifest_path: Path, srt: Path,
    narration_audio: Path, narration_manifest_path: Path, evidence_path: Path,
    expected_url: str, allow_fixture: bool,
    base_video_source: Path | None = None, base_manifest_source: Path | None = None,
    srt_source: Path | None = None, narration_audio_source: Path | None = None,
    narration_manifest_source: Path | None = None, evidence_source: Path | None = None,
    timeline_input: ImmutableInput | None = None,
    release_inputs: dict[str, ImmutableInput] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Validate every base/narration binding and independently measure decoded audio."""
    base_manifest = read_json(base_manifest_path, "caption-base manifest")
    narration_manifest = read_json(narration_manifest_path, "narration manifest")
    require(base_manifest.get("status") == "passed", "caption-base manifest status is not passed")
    require(base_manifest.get("exactRuntimeSource") == expected_sha, "caption-base exact runtime SHA mismatch")
    require(narration_manifest.get("status") == "passed", "narration manifest status is not passed")
    require(narration_manifest.get("schemaVersion") == 1, "unsupported narration-manifest schema")
    if not allow_fixture:
        evidence = read_json(evidence_path, "CAPTURE_REVIEW")
        capture_record = base_manifest.get("captureReview")
        require(isinstance(capture_record, dict), "caption-base manifest has no CAPTURE_REVIEW binding")
        require_bound_file(
            capture_record,
            evidence_path,
            "caption-base CAPTURE_REVIEW",
            expected_relative=_logical_relative(evidence_path, evidence_source),
        )
        require(capture_record.get("liveBaseUrl") == expected_url,
                "caption-base CAPTURE_REVIEW public origin mismatch")
        require(capture_record.get("capturedAt") == evidence.get("capturedAt"),
                "caption-base CAPTURE_REVIEW capture time mismatch")
        require(base_manifest.get("captureSubmissionHead") == evidence.get("submissionPackHeadAtCapture"),
                "caption-base capture submission HEAD mismatch")
        base_inputs = base_manifest.get("inputs")
        review_artifacts = evidence.get("artifacts")
        require(isinstance(base_inputs, dict) and isinstance(review_artifacts, dict),
                "caption-base or CAPTURE_REVIEW has no visual artifact inventory")
        require(base_inputs == review_artifacts,
                "caption-base visual inputs are not the exact CAPTURE_REVIEW artifact inventory")
        require(_logical_relative(narration_audio, narration_audio_source) == DEFAULT_NARRATION_AUDIO,
                "production narration audio must use the canonical ignored path")
        require(_logical_relative(narration_manifest_path, narration_manifest_source) == DEFAULT_NARRATION_MANIFEST,
                "production narration manifest must use the canonical ignored path")
        require(base_manifest.get("schemaVersion") == BASE_SCHEMA_VERSION, "caption-base schema is not canonical narrated v4")
        require(base_manifest.get("builder") == BASE_BUILDER_ID, "caption-base builder is not canonical narrated v4")
        require_builder_source_head(base_manifest)
        require(narration_manifest.get("fixtureOnly") is False,
                "production rejects a fixture-only narration manifest")
        try:
            validated_narration = validate_narration_bundle(
                narration_audio,
                narration_manifest_path,
                production_mode=True,
                expected_audio_path=narration_audio_source,
                expected_manifest_path=narration_manifest_source,
            )
            timeline_snapshot, canonical_windows = load_caption_timeline()
        except NarrationError as exc:
            raise GateError(str(exc)) from exc
        require(validated_narration.payload == narration_manifest,
                "narration manifest changed between canonical and compositor validation")
        require(srt.read_bytes() == canonical_srt_bytes(canonical_windows),
                "caption-base SRT bytes differ from the canonical narrated timeline")
        timeline = base_manifest.get("timeline")
        require(isinstance(timeline, dict), "caption-base manifest has no timeline record")
        canonical_record = timeline.get("canonicalContract")
        expected_timeline_record = {
            "path": timeline_input.source_relative if timeline_input is not None else timeline_snapshot.relative_path,
            "sha256": timeline_input.sha256 if timeline_input is not None else timeline_snapshot.sha256,
            "size": timeline_input.size if timeline_input is not None else timeline_snapshot.size,
        }
        if timeline_input is not None:
            require(timeline_snapshot.sha256 == timeline_input.sha256
                    and timeline_snapshot.size == timeline_input.size
                    and timeline_snapshot.relative_path == timeline_input.source_relative,
                    "canonical timeline changed after immutable staging")
        require(canonical_record == expected_timeline_record,
                "caption-base canonical timeline binding is stale")
        require_tracked_source(
            base_manifest.get("builderSource"),
            "demo/tools/build_caption_video.py",
            "caption video builder source",
            require_head=True,
        )
        require(release_inputs is not None, "production caption-base validation has no immutable release inputs")
        release = require_exact_keys(
            base_manifest.get("releaseEvidence"),
            {
                "exactDeployEvidenceMode", "producer", "deployState", "deploymentStatus",
                "deploymentOutput", "claimEvidenceMatrix", "architectureBinding",
            },
            "caption-base releaseEvidence",
        )
        deployment = require_exact_keys(
            evidence.get("deploymentEvidence"),
            {"mode", "producer", "status", "output"},
            "CAPTURE_REVIEW deploymentEvidence",
        )
        require(release.get("exactDeployEvidenceMode") == deployment.get("mode"),
                "caption-base exact deployment mode differs from CAPTURE_REVIEW")
        require(release.get("producer") == deployment.get("producer"),
                "caption-base deployment producer differs from CAPTURE_REVIEW")
        require(release.get("deploymentStatus") == deployment.get("status"),
                "caption-base deployment status binding differs from CAPTURE_REVIEW")
        require(release.get("deploymentOutput") == deployment.get("output"),
                "caption-base deployment output binding differs from CAPTURE_REVIEW")
        release_records = {
            "deployState": release.get("deployState"),
            "deploymentStatus": release.get("deploymentStatus"),
            "deploymentOutput": release.get("deploymentOutput"),
            "claimEvidenceMatrix": release.get("claimEvidenceMatrix"),
            "architectureSource": release.get("architectureBinding", {}).get("source"),
            "architectureRaster": release.get("architectureBinding", {}).get("raster"),
        }
        require(set(release_inputs) == set(release_records),
                "immutable release-evidence input inventory is incomplete")
        for name, staged in release_inputs.items():
            expected_record = {
                "path": staged.source_relative,
                "sha256": staged.sha256,
                "size": staged.size,
            }
            require(release_records[name] == expected_record,
                    f"caption-base release evidence {name} differs from immutable staging")
        require_tracked_source(
            base_manifest.get("narrationValidatorSource"),
            "demo/tools/build_local_narration.py",
            "local narration builder and validator source",
            require_head=True,
        )

    outputs = base_manifest.get("outputs")
    require(isinstance(outputs, dict), "caption-base manifest has no outputs record")
    base_video_record = outputs.get("video")
    base_srt_record = outputs.get("subtitles")
    require(isinstance(base_video_record, dict) and isinstance(base_srt_record, dict),
            "caption-base manifest has incomplete video/subtitle bindings")
    require_bound_file(
        base_video_record,
        base_video,
        "caption-base video",
        expected_relative=_logical_relative(base_video, base_video_source),
    )
    require_bound_file(
        base_srt_record,
        srt,
        "caption-base SRT",
        expected_relative=_logical_relative(srt, srt_source),
    )

    narration = base_manifest.get("narration")
    require(isinstance(narration, dict), "caption-base manifest has no narration evidence")
    expected_narration_keys = {
        "manifestPath", "manifestSha256", "audioPath", "audioSha256", "generator", "voice",
        "timelineContract", "rights", "measuredAudio",
    }
    if not allow_fixture:
        expected_narration_keys.add("generationEvidence")
    require(set(narration) == expected_narration_keys,
            "caption-base narration fields differ from the canonical contract")
    require(narration.get("manifestPath") == _logical_relative(narration_manifest_path, narration_manifest_source),
            "caption-base narration-manifest path mismatch")
    require(narration.get("manifestSha256") == sha256_file(narration_manifest_path),
            "caption-base narration-manifest hash mismatch")
    require(narration.get("audioPath") == _logical_relative(narration_audio, narration_audio_source),
            "caption-base narration-audio path mismatch")
    require(narration.get("audioSha256") == sha256_file(narration_audio),
            "caption-base narration-audio hash mismatch")
    generator = str(narration.get("generator") or "")
    if allow_fixture:
        require(bool(generator), "fixture caption-base narration has no generator disclosure")
    else:
        require(generator == CANONICAL_NARRATION_GENERATOR,
                "caption-base narration must disclose the canonical ElevenLabs generator")
    voice = narration.get("voice")
    require(isinstance(voice, dict) and all(str(voice.get(key) or "").strip() for key in ("name", "culture", "gender")),
            "caption-base narration has incomplete synthetic voice disclosure")
    rights = narration.get("rights")
    require(isinstance(rights, dict), "caption-base narration has no rights record")
    measured_record = narration.get("measuredAudio")
    require(isinstance(measured_record, dict), "caption-base narration has no measuredAudio record")
    require(int(measured_record.get("clippedSamples") or 0) == 0,
            "caption-base narration manifest reports clipped samples")
    require(int(measured_record.get("nonSilentBeatCount") or 0) > 0,
            "caption-base narration manifest reports no non-silent beats")

    require(narration_manifest.get("generator") == narration.get("generator"),
            "caption-base narration generator differs from the bound narration manifest")
    generated_voice = narration_manifest.get("voice")
    require(isinstance(generated_voice, dict), "narration manifest has no voice record")
    for key in ("name", "culture", "gender"):
        require(voice.get(key) == generated_voice.get(key),
                f"caption-base narration voice.{key} differs from the bound narration manifest")
    generated_timeline = narration_manifest.get("timelineContract")
    require(isinstance(generated_timeline, dict), "narration manifest has no timeline contract")
    for key in ("path", "sha256", "size"):
        require(narration.get("timelineContract", {}).get(key) == generated_timeline.get(key),
                f"caption-base narration timelineContract.{key} differs from the bound narration manifest")
    if not allow_fixture:
        require(narration.get("timelineContract") == base_manifest["timeline"]["canonicalContract"],
                "caption-base visual, subtitle, and narration timelines are not identical")
    generated_rights = narration_manifest.get("rights")
    validate_narration_rights(generated_rights, rights, allow_fixture=allow_fixture)
    if not allow_fixture:
        generation_evidence = narration_manifest.get("generationEvidence")
        require(isinstance(generation_evidence, dict), "narration manifest has no generationEvidence")
        expected_generation_projection = {
            "evidenceType": generation_evidence.get("evidenceType"),
            "sha256": canonical_json_sha256(generation_evidence),
            "generatorSource": generation_evidence.get("generatorSource"),
            "assurance": generation_evidence.get("assurance"),
        }
        require(narration.get("generationEvidence") == expected_generation_projection,
                "caption-base narration generation evidence differs from its immutable manifest")
    source_audio_record = narration_manifest.get("audio")
    require(isinstance(source_audio_record, dict), "narration manifest has no audio binding")
    require_bound_file(
        source_audio_record,
        narration_audio,
        "narration source audio",
        expected_relative=_logical_relative(narration_audio, narration_audio_source),
    )
    for key in (
        "sampleRate", "channels", "bitsPerSample", "sampleFrames", "durationSeconds",
        "peakS16", "rmsS16", "activeSampleRatio", "clippedSamples", "nonSilentBeatCount",
    ):
        require(measured_record.get(key) == source_audio_record.get(key),
                f"caption-base measuredAudio.{key} differs from the bound narration manifest")
    segments = narration_manifest.get("segments")
    require(isinstance(segments, list) and len(segments) > 0, "narration manifest has no segments")
    if not allow_fixture:
        require(len(segments) == 10, "production narration manifest must bind exactly ten beats")
    timeline = narration.get("timelineContract")
    require(isinstance(timeline, dict), "narration has no timeline contract binding")
    if timeline_input is None:
        timeline_path = project_path(str(timeline.get("path") or ""), "narration timeline contract", exists=True)
        require_bound_file(timeline, timeline_path, "narration timeline contract")
    else:
        require_bound_file(
            timeline,
            timeline_input.staged_path,
            "narration timeline contract",
            expected_relative=timeline_input.source_relative,
        )

    rights_safe = base_manifest.get("rightsSafeAudio")
    require(isinstance(rights_safe, dict), "caption-base manifest has no rightsSafeAudio record")
    require(rights_safe.get("voiceUsed") is True and rights_safe.get("ttsUsed") is True,
            "caption-base rights record does not disclose synthetic narration")
    require(rights_safe.get("musicUsed") is False,
            "caption-base rights record does not prove music is absent")

    source_stats = decoded_audio_stats(narration_audio)
    base_stats = decoded_audio_stats(base_video)
    require_narration_quality(source_stats, "narration source")
    require_narration_quality(base_stats, "caption-base AAC narration")
    source_stats["ebuR128"] = ebur128_stats(narration_audio)
    base_stats["ebuR128"] = ebur128_stats(base_video)
    if not allow_fixture:
        expected_rights_safe = {
            "voiceUsed": True,
            "ttsUsed": True,
            "musicUsed": False,
            "mode": narration_manifest["generator"],
            "decodedPeakS16": base_stats["peakS16"],
            "decodedRmsS16": base_stats["rmsS16"],
            "decodedActiveSampleRatio": base_stats["activeSampleRatio"],
            "decodedClippedSamples": base_stats["clippedSamples"],
            "decodedSampleCount": base_stats["totalSamples"],
            "decodedPcmSha256": base_stats["pcmSha256"],
        }
        require(rights_safe == expected_rights_safe,
                "caption-base rightsSafeAudio differs from exact decoded narration evidence")
    return base_manifest, narration_manifest, source_stats, base_stats


def staged_copy(source: Path, scratch: Path, destination_name: str, *, expected_sha256: str) -> Path:
    """Copy only bytes already bound by the caller's immutable snapshot digest."""
    require(SHA256_RE.fullmatch(expected_sha256) is not None, "staged copy requires a valid expected SHA-256")
    scratch.mkdir(parents=True, exist_ok=True)
    try:
        snapshot = read_project_file_once(source, f"immutable source for {destination_name}")
    except ValueError as exc:
        raise GateError(str(exc)) from exc
    require(snapshot.sha256 == expected_sha256,
            f"immutable source for {destination_name} differs from its validated SHA-256")
    temporary = scratch / f".{destination_name}.{os.urandom(12).hex()}.staged"
    try:
        _exclusive_write(temporary, snapshot.data)
        require(sha256_file(temporary) == expected_sha256,
                f"staged copy of {relative(source)} changed validated bytes")
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def staged_json(payload: dict[str, Any], scratch: Path, destination_name: str) -> Path:
    """Serialize JSON completely before any canonical output is promoted."""
    scratch.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination_name}.", suffix=".staged", dir=scratch)
    os.close(fd)
    temporary = Path(temp_name)
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        read_json(temporary, f"staged {destination_name}")
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _same_owned_identity(left: OwnedPath, right: OwnedPath) -> bool:
    return (
        left.device,
        left.inode,
        left.mode_type,
    ) == (
        right.device,
        right.inode,
        right.mode_type,
    )


def _publish_noreplace(
    source: Path,
    destination: Path,
    scratch: Path,
    label: str,
    *,
    expected_source: OwnedPath | None = None,
) -> OwnedPath:
    """Publish one regular file without ever replacing an existing path entry.

    A hard link gives us create-if-absent semantics on every supported platform.
    All canonical outputs and their private staging area must therefore reside on
    the same filesystem.  There is deliberately no copy/replace fallback because
    either alternative would reintroduce the overwrite race this gate prevents.
    """

    source_owner = expected_source or OwnedPath.capture(source, f"{label} source")
    require(source_owner.path == source and source_owner.still_owned(),
            f"{label} source changed before publication")
    try:
        os.link(source, destination, follow_symlinks=False)
    except FileExistsError as exc:
        raise GateError(f"{label} refused to overwrite existing {relative(destination)}") from exc
    except OSError as exc:
        raise GateError(
            f"{label} requires same-filesystem hard-link publication for {relative(destination)}"
        ) from exc

    expected_destination = OwnedPath(
        destination,
        source_owner.device,
        source_owner.inode,
        source_owner.mode_type,
    )
    try:
        published = OwnedPath.capture(destination, f"{label} destination")
        require(_same_owned_identity(source_owner, published),
                f"{label} destination changed during publication")
    except BaseException as publication_exc:
        try:
            _quarantine_owned_publication(
                expected_destination,
                scratch,
                f"cleanup after failed {label}",
            )
        except BaseException as cleanup_exc:
            raise RollbackError(
                f"{label} failed after publication and safe cleanup also failed: {cleanup_exc}"
            ) from publication_exc
        raise

    # The caller must register this public identity before withdrawing the source
    # link.  That ordering keeps the publication rollback-owned even if private
    # source cleanup encounters a racing path replacement.
    return published


def _quarantine_owned_publication(owner: OwnedPath, scratch: Path, label: str) -> None:
    """Withdraw a publication without deleting an entry that changed ownership.

    The public entry is first atomically moved into a private quarantine.  Only
    the exact transaction-owned identity may then be deleted.  If another file
    won the race, it is restored without overwrite or retained in quarantine.
    """

    fd, quarantine_name = tempfile.mkstemp(
        prefix=f".{owner.path.name}.", suffix=".quarantine", dir=scratch,
    )
    os.close(fd)
    quarantine = Path(quarantine_name)
    moved = False
    try:
        try:
            os.replace(owner.path, quarantine)
            moved = True
        except FileNotFoundError:
            return
        moved_owner = OwnedPath.capture(quarantine, f"{label} quarantine")
        if _same_owned_identity(owner, moved_owner):
            try:
                quarantine.unlink()
            except OSError:
                # A stale private link is harmless once the public path is gone.
                pass
            return

        try:
            _publish_noreplace(
                quarantine,
                owner.path,
                scratch,
                f"{label} concurrent-file restoration",
                expected_source=moved_owner,
            )
            _quarantine_owned_publication(
                moved_owner,
                scratch,
                f"{label} concurrent-file source cleanup",
            )
        except BaseException as restore_exc:
            raise RollbackError(
                f"{label} changed ownership during rollback; concurrent bytes retained at "
                f"{relative(quarantine)}"
            ) from restore_exc
        raise RollbackError(
            f"{label} changed ownership during rollback; the concurrent destination was preserved"
        )
    finally:
        if not moved:
            quarantine.unlink(missing_ok=True)


def _backup_destination(destination: Path, scratch: Path) -> OwnedPath | None:
    fd, backup_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".rollback", dir=scratch,
    )
    os.close(fd)
    backup = Path(backup_name)
    moved = False
    try:
        try:
            os.replace(destination, backup)
            moved = True
        except FileNotFoundError:
            return None
        try:
            return OwnedPath.capture(backup, f"rollback copy of {relative(destination)}")
        except BaseException as exc:
            raise RollbackError(
                f"existing {relative(destination)} changed to an unsupported path entry; "
                f"it was preserved at {relative(backup)}"
            ) from exc
    finally:
        if not moved:
            backup.unlink(missing_ok=True)


def promote_output_bundle(
    staged_outputs: Sequence[tuple[Path, Path]],
    scratch: Path,
    *,
    replace: bool,
    verify_promoted: Callable[[], Any] | None = None,
) -> None:
    """Promote a complete output bundle, rolling back every destination on failure.

    Windows has no atomic multi-file rename.  We therefore preflight and stage all
    bytes, preserve every replaced destination, publish every new path with
    create-if-absent semantics, promote the manifest last, and restore the complete
    old bundle if any step fails.
    """
    destinations = [destination for _source, destination in staged_outputs]
    require(len(set(destinations)) == len(destinations), "output bundle destinations must be distinct")
    for source, destination in staged_outputs:
        require(source.is_file(), f"staged output {relative(source)} is missing")
        destination.parent.mkdir(parents=True, exist_ok=True)
        require(replace or not destination.exists(),
                f"refusing to replace existing {relative(destination)} without --replace")

    scratch.mkdir(parents=True, exist_ok=True)
    backups: dict[Path, OwnedPath] = {}
    promoted: list[OwnedPath] = []
    committed = False
    try:
        if replace:
            for destination in destinations:
                backup = _backup_destination(destination, scratch)
                if backup is not None:
                    backups[destination] = backup
        for source, destination in staged_outputs:
            source_owner = OwnedPath.capture(
                source,
                f"staged source for {relative(destination)}",
            )
            promoted.append(_publish_noreplace(
                source,
                destination,
                scratch,
                f"final output promotion for {relative(destination)}",
                expected_source=source_owner,
            ))
            _quarantine_owned_publication(
                source_owner,
                scratch,
                f"staged source cleanup for {relative(destination)}",
            )
        if verify_promoted is not None:
            verify_promoted()
        committed = True
    except BaseException as exc:
        rollback_errors: list[str] = []
        for owner in reversed(promoted):
            try:
                _quarantine_owned_publication(
                    owner,
                    scratch,
                    f"rollback of {relative(owner.path)}",
                )
            except BaseException as rollback_exc:
                rollback_errors.append(f"withdraw {relative(owner.path)}: {rollback_exc}")
        for destination, backup_owner in backups.items():
            try:
                _publish_noreplace(
                    backup_owner.path,
                    destination,
                    scratch,
                    f"rollback restoration for {relative(destination)}",
                    expected_source=backup_owner,
                )
                _quarantine_owned_publication(
                    backup_owner,
                    scratch,
                    f"rollback source cleanup for {relative(destination)}",
                )
            except BaseException as rollback_exc:
                rollback_errors.append(f"restore {relative(destination)}: {rollback_exc}")
        if not rollback_errors:
            raise
        raise RollbackError(
            "final output promotion failed and rollback could not restore a coherent bundle: "
            + "; ".join(rollback_errors)
            + "; retained rollback files: "
            + ", ".join(
                relative(owner.path) for owner in backups.values() if owner.path.exists()
            )
        ) from exc
    finally:
        if committed:
            for backup_owner in backups.values():
                try:
                    if backup_owner.still_owned():
                        backup_owner.path.unlink()
                except OSError:
                    # A private stale rollback file does not invalidate a fully
                    # verified public bundle; later project cleanup may remove it.
                    pass


def _declared_source(record: Any, label: str) -> Path:
    require(isinstance(record, dict), f"{label} record is missing")
    path = record.get("path")
    require(isinstance(path, str) and bool(path), f"{label} path is missing")
    return project_path(path, label, exists=True)


def stage_compose_inputs(
    *,
    session: Path,
    base_video: Path,
    base_manifest: Path,
    narration_audio: Path,
    narration_manifest: Path,
    live_video: Path,
    interaction_manifest: Path,
    evidence_manifest: Path,
    srt: Path,
    thumbnail: Path,
    allow_fixture: bool,
) -> tuple[dict[str, ImmutableInput], dict[str, ImmutableInput], ImmutableInput | None]:
    """Snapshot every build/release input before any validation or media use."""

    core_sources = {
        "baseVideo": (base_video, "caption-base video", "01-base-video" + base_video.suffix),
        "baseManifest": (base_manifest, "caption-base manifest", "02-base-manifest.json"),
        "narrationAudio": (narration_audio, "narration audio", "03-narration" + narration_audio.suffix),
        "narrationManifest": (narration_manifest, "narration manifest", "04-narration-manifest.json"),
        "liveVideo": (live_video, "live interaction video", "05-live-video" + live_video.suffix),
        "interactionManifest": (interaction_manifest, "live interaction manifest", "06-interaction.json"),
        "captureReview": (evidence_manifest, "CAPTURE_REVIEW", "07-capture-review.json"),
        "canonicalSrt": (srt, "canonical SRT", "08-canonical.srt"),
        "thumbnail": (thumbnail, "thumbnail", "09-thumbnail" + thumbnail.suffix),
    }
    inventory = {
        key: stage_project_input(source, label, session, destination)
        for key, (source, label, destination) in core_sources.items()
    }

    narration_payload = read_json(inventory["narrationManifest"].staged_path, "immutable narration manifest")
    timeline_source = _declared_source(narration_payload.get("timelineContract"), "narration timeline contract")
    inventory["captionTimeline"] = stage_project_input(
        timeline_source,
        "narration timeline contract",
        session,
        "10-caption-timeline.json",
    )

    interaction_payload = read_json(inventory["interactionManifest"].staged_path, "immutable interaction manifest")
    poster_input: ImmutableInput | None = None
    poster_record = interaction_payload.get("poster")
    if isinstance(poster_record, dict) and isinstance(poster_record.get("path"), str):
        poster_input = stage_project_input(
            _declared_source(poster_record, "interaction poster"),
            "interaction poster",
            session,
            "11-live-poster" + Path(str(poster_record["path"])).suffix,
        )
        inventory["livePoster"] = poster_input
    elif not allow_fixture:
        raise GateError("production interaction manifest has no poster binding")

    release_inputs: dict[str, ImmutableInput] = {}
    if not allow_fixture:
        base_payload = read_json(inventory["baseManifest"].staged_path, "immutable caption-base manifest")
        release = require_exact_keys(
            base_payload.get("releaseEvidence"),
            {
                "exactDeployEvidenceMode", "producer", "deployState", "deploymentStatus",
                "deploymentOutput", "claimEvidenceMatrix", "architectureBinding",
            },
            "caption-base releaseEvidence",
        )
        architecture = require_exact_keys(
            release.get("architectureBinding"), {"source", "raster"},
            "caption-base releaseEvidence.architectureBinding",
        )
        records = {
            "deployState": release.get("deployState"),
            "deploymentStatus": release.get("deploymentStatus"),
            "deploymentOutput": release.get("deploymentOutput"),
            "claimEvidenceMatrix": release.get("claimEvidenceMatrix"),
            "architectureSource": architecture.get("source"),
            "architectureRaster": architecture.get("raster"),
        }
        for index, (name, record) in enumerate(records.items(), start=20):
            source = _declared_source(record, f"release evidence {name}")
            suffix = source.suffix or ".evidence"
            staged = stage_project_input(
                source,
                f"release evidence {name}",
                session,
                f"{index:02d}-{name}{suffix}",
            )
            release_inputs[name] = staged
            inventory[name] = staged
    return inventory, release_inputs, poster_input


def validate_compose_path_aliases(
    source_files: Sequence[Path],
    output_files: Sequence[Path],
    *,
    srt: Path,
    output_srt: Path,
) -> None:
    """Allow only the canonical SRT's deliberate snapshot-before-replace alias."""

    require(len(set(source_files)) == len(source_files),
            "immutable compose inputs must all be distinct files")
    require(len(set(output_files)) == len(output_files),
            "final video, SRT, manifest, and QA outputs must be distinct")
    aliases = set(source_files).intersection(output_files)
    # ``compose`` has already required the input to exist.  Keep this helper
    # path-only so its alias matrix remains independently testable pre-capture.
    canonical_srt = (ROOT / DEFAULT_SRT_OUTPUT).resolve()
    allowed_aliases = (
        {canonical_srt}
        if srt == output_srt == canonical_srt
        else set()
    )
    require(
        aliases == allowed_aliases,
        "only the canonical SRT may alias its final output after immutable staging",
    )


def compose(
    *, base_video: Path, base_manifest: Path, narration_audio: Path,
    narration_manifest: Path, live_video: Path, interaction_manifest: Path,
    evidence_manifest: Path, srt: Path, output_srt: Path, thumbnail: Path,
    output: Path, manifest_path: Path, qa_path: Path, scratch: Path,
    expected_sha: str, expected_url: str, overlay_start: float,
    overlay_end: float, replace: bool, allow_fixture: bool = False,
) -> dict[str, Any]:
    toolchain = trusted_toolchain_records(allow_discovery=allow_fixture)
    source_files = (
        base_video, base_manifest, narration_audio, narration_manifest, live_video,
        interaction_manifest, evidence_manifest, srt, thumbnail,
    )
    resolved_source_files = tuple(project_path(path, label, exists=True) for path, label in zip(source_files, (
        "base video", "base manifest", "narration audio", "narration manifest", "live video",
        "interaction manifest", "CAPTURE_REVIEW", "SRT", "thumbnail",
    )))
    output_files = (output, output_srt, manifest_path, qa_path)
    resolved_output_files = tuple(
        project_path(destination, f"final output {destination.name}")
        for destination in output_files
    )
    validate_compose_path_aliases(
        resolved_source_files,
        resolved_output_files,
        srt=project_path(srt, "SRT", exists=True),
        output_srt=project_path(output_srt, "final SRT output"),
    )
    for destination in resolved_output_files:
        require(replace or not destination.exists(),
                f"refusing to replace existing {relative(destination)} without --replace")
    require(0 <= overlay_start < overlay_end, "invalid live overlay window")
    media_sources = {
        relative_path: tracked_source_record(
            relative_path,
            f"media tool {Path(relative_path).name}",
            require_head=not allow_fixture,
        )
        for relative_path in RELEASE_SOURCE_RELS
    }
    session = create_private_build_session(scratch)
    succeeded = False
    preserve_failed_session = False
    try:
        inventory, release_inputs, poster_input = stage_compose_inputs(
            session=session,
            base_video=base_video,
            base_manifest=base_manifest,
            narration_audio=narration_audio,
            narration_manifest=narration_manifest,
            live_video=live_video,
            interaction_manifest=interaction_manifest,
            evidence_manifest=evidence_manifest,
            srt=srt,
            thumbnail=thumbnail,
            allow_fixture=allow_fixture,
        )
        _evidence, interaction = validate_bindings(
            expected_sha=expected_sha,
            expected_url=expected_url,
            evidence_path=inventory["captureReview"].staged_path,
            interaction_path=inventory["interactionManifest"].staged_path,
            live_video=inventory["liveVideo"].staged_path,
            evidence_source=evidence_manifest,
            interaction_source=interaction_manifest,
            live_video_source=live_video,
            poster_input=poster_input,
            deployment_status_input=release_inputs.get("deploymentStatus"),
            deployment_output_input=release_inputs.get("deploymentOutput"),
            allow_fixture=allow_fixture,
        )
        base_evidence, _narration_evidence, source_audio_stats, base_audio_stats = validate_base_and_narration(
            expected_sha=expected_sha,
            base_video=inventory["baseVideo"].staged_path,
            base_manifest_path=inventory["baseManifest"].staged_path,
            srt=inventory["canonicalSrt"].staged_path,
            narration_audio=inventory["narrationAudio"].staged_path,
            narration_manifest_path=inventory["narrationManifest"].staged_path,
            evidence_path=inventory["captureReview"].staged_path,
            base_video_source=base_video,
            base_manifest_source=base_manifest,
            srt_source=srt,
            narration_audio_source=narration_audio,
            narration_manifest_source=narration_manifest,
            evidence_source=evidence_manifest,
            timeline_input=inventory["captionTimeline"],
            release_inputs=release_inputs,
            expected_url=expected_url,
            allow_fixture=allow_fixture,
        )
        staged_base = inventory["baseVideo"].staged_path
        staged_live = inventory["liveVideo"].staged_path
        staged_canonical_srt = inventory["canonicalSrt"].staged_path
        base = media_summary(staged_base)
        live = media_summary(staged_live)
        base_timeline = base_evidence.get("timeline")
        require(isinstance(base_timeline, dict), "caption-base manifest has no timeline record")
        expected_frame_count = base_timeline.get("totalFrames")
        require(type(expected_frame_count) is int and expected_frame_count > 0,
                "caption-base timeline has no exact positive frame count")
        expected_duration = expected_frame_count / FPS
        if not allow_fixture:
            require(expected_frame_count == 5_160 and expected_duration == 172.0,
                    "production caption timeline must be exactly 5,160 frames / 172 seconds")
        require(base["width"] == 1920 and base["height"] == 1080, "base video must be 1920x1080")
        require(base["videoCodec"] == "h264" and base["pixelFormat"] == "yuv420p",
                "base video must be H.264/yuv420p")
        require(base["audioStreamCount"] == 1 and base["audioCodec"] == "aac",
                "base video must have exactly one AAC narration stream")
        require(base["audioSampleRate"] == AUDIO_SAMPLE_RATE and base["audioChannels"] == AUDIO_CHANNELS,
                "base AAC narration must be 48 kHz stereo")
        require(abs(frame_rate(base["averageFrameRate"]) - FPS) < 0.02, "base video must be 30 fps")
        require(base["frameCount"] == expected_frame_count,
                "caption-base decoded frame count differs from its exact timeline")
        require(abs(float(base["durationSeconds"]) - expected_duration) <= 0.01,
                "caption-base duration differs from its exact frame timeline")
        require(live["audioStreamCount"] == 0, "live recorder must not capture any audio stream")
        require(live["width"] == 1920 and live["height"] == 1080, "live recording must be 1920x1080")
        require(live["durationSeconds"] >= 4.0, "live recording is too short to prove interaction")
        require(overlay_end <= expected_duration + 1e-6, "live overlay extends past the base timeline")
        require(abs(float(source_audio_stats["durationSeconds"]) - expected_duration) <= 0.01,
                "narration source duration differs from the exact caption timeline")
        live_diversity = diversity(staged_live, duration=min(float(live["durationSeconds"]), overlay_end - overlay_start))
        require(live_diversity["uniqueFrames"] >= 8 and live_diversity["uniqueRatio"] >= 0.25,
                "live recording is too static; genuine interaction motion was not demonstrated")
        validate_srt(staged_canonical_srt, expected_duration)

        candidate = session / "real-motion.rendering.mp4"
        window = overlay_end - overlay_start
        filter_graph = (
            f"[1:v]fps=30,scale=1424:800:force_original_aspect_ratio=decrease,"
            f"pad=1424:800:(ow-iw)/2:(oh-ih)/2:color=0x06110d,"
            f"tpad=stop_mode=clone:stop_duration={window:.6f},trim=duration={window:.6f},"
            f"setpts=PTS-STARTPTS+{overlay_start:.6f}/TB,"
            "drawbox=x=0:y=0:w=iw:h=ih:color=0x67e8b2:t=6[live];"
            f"[0:v][live]overlay=x=248:y=58:eof_action=pass:shortest=0:"
            f"enable='between(t,{overlay_start:.6f},{overlay_end:.6f})'[video]"
        )
        run_tool("ffmpeg", [
            "-y", "-v", "error", "-i", str(staged_base), "-i", str(staged_live),
            "-filter_complex", filter_graph, "-map", "[video]", "-map", "0:a:0",
            "-map_metadata", "-1", "-c:v", "libx264", "-preset", "ultrafast" if allow_fixture else "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "copy", "-movflags", "+faststart",
            "-t", f"{expected_duration:.6f}", str(candidate),
        ], "compose real-motion final")
        final = media_summary(candidate)
        require(final["durationSeconds"] < STRICT_LIMIT_SECONDS, "final reaches the 175-second publication ceiling")
        require(abs(float(final["durationSeconds"]) - expected_duration) <= 0.01,
                "final duration differs from the exact frame timeline")
        require(final["width"] == 1920 and final["height"] == 1080, "final is not 1920x1080")
        require(final["videoCodec"] == "h264" and final["pixelFormat"] == "yuv420p",
                "final must be H.264/yuv420p")
        require(abs(frame_rate(final["averageFrameRate"]) - FPS) < 0.02, "final is not 30 fps")
        require(final["frameCount"] == expected_frame_count == base["frameCount"],
                "final frame count differs from the exact caption-base timeline")
        require(final["audioStreamCount"] == 1 and final["audioCodec"] == "aac",
                "final must contain exactly one AAC narration stream")
        require(final["audioSampleRate"] == AUDIO_SAMPLE_RATE and final["audioChannels"] == AUDIO_CHANNELS,
                "final narration stream must be 48 kHz stereo")
        final_audio_stats = decoded_audio_stats(candidate)
        require_narration_quality(final_audio_stats, "final AAC narration")
        final_audio_stats["ebuR128"] = ebur128_stats(candidate)
        require_audio_preserved(base_audio_stats, final_audio_stats)
        overlay_diversity = diversity(candidate, start=overlay_start, duration=window)
        require(overlay_diversity["uniqueFrames"] >= 8 and overlay_diversity["uniqueRatio"] >= 0.25,
                "shipped overlay window does not retain real motion")

        staged_outputs: list[tuple[Path, Path]] = [(candidate, output)]
        staged_srt = staged_copy(
            staged_canonical_srt,
            session,
            output_srt.name,
            expected_sha256=inventory["canonicalSrt"].sha256,
        )
        staged_outputs.append((staged_srt, output_srt))
        output_srt_qa = validate_srt(staged_srt, expected_duration)
        require(sha256_file(staged_srt) == inventory["canonicalSrt"].sha256,
                "public SRT is not byte-identical to the immutable canonical SRT")
        final_sha = sha256_file(candidate)
        live_safety = {
            "mode": interaction.get("mode"),
            "submissionEligible": interaction.get("submissionEligible"),
            "reviewerCredentialRendered": interaction.get("reviewerCredentialRendered"),
            "reviewerCredentialUsed": interaction.get("reviewerCredentialUsed"),
            "durableReviewerWritesCreated": interaction.get("durableReviewerWritesCreated"),
            "canonicalQuestionSource": interaction.get("canonicalQuestionSource"),
            "recallProof": interaction.get("recallProof"),
        }
        qa = {
            "schemaVersion": 2,
            "status": "passed",
            "duration": {
                "expectedSeconds": expected_duration,
                "baseSeconds": base["durationSeconds"],
                "finalSeconds": final["durationSeconds"],
                "exactFrames": expected_frame_count,
                "fps": FPS,
                "limitSeconds": 175,
            },
            "video": final,
            "audio": {
                "policy": CANONICAL_AUDIO_POLICY,
                "generator": base_evidence["narration"]["generator"],
                "voice": base_evidence["narration"]["voice"],
                "rights": base_evidence["narration"]["rights"],
                "generationEvidence": base_evidence["narration"].get("generationEvidence"),
                "syntheticVoiceDisclosure": True,
                "tts": True,
                "music": False,
                "sourceNarration": source_audio_stats,
                "baseDecoded": base_audio_stats,
                "finalDecoded": final_audio_stats,
                "preservedFromBaseAac": True,
            },
            "subtitles": {
                **output_srt_qa,
                "canonicalInputSha256": inventory["canonicalSrt"].sha256,
                "outputSha256": inventory["canonicalSrt"].sha256,
                "byteIdentical": True,
            },
            "liveInputFrameDiversity": live_diversity,
            "shippedOverlayFrameDiversity": overlay_diversity,
            "overlayWindow": {"startSeconds": overlay_start, "endSeconds": overlay_end},
            "liveSafety": live_safety,
        }
        input_records = {key: value.record() for key, value in sorted(inventory.items())}
        manifest = {
            "schemaVersion": FINAL_SCHEMA_VERSION,
            "status": "passed",
            "builder": FINAL_BUILDER_ID,
            "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "exactRuntimeSource": expected_sha,
            "publicUrl": expected_url,
            "toolchain": trusted_toolchain_records(allow_discovery=allow_fixture),
            "builderSources": media_sources,
            "rightsProfile": dict(CANONICAL_RIGHTS_PROFILE),
            "inputSnapshots": input_records,
            "evidence": {
                "captureReview": inventory["captureReview"].record(),
                "deploymentEvidence": _evidence.get("deploymentEvidence"),
            },
            "liveInteraction": {
                "manifest": inventory["interactionManifest"].record(),
                "video": inventory["liveVideo"].record(),
                "poster": poster_input.record() if poster_input is not None else None,
                **live_safety,
                "actions": interaction.get("actions"),
                "overlayStartSeconds": overlay_start,
                "overlayEndSeconds": overlay_end,
            },
            "inputs": {
                "baseVideo": inventory["baseVideo"].record(),
                "baseManifest": inventory["baseManifest"].record(),
                "narration": {
                    "audio": inventory["narrationAudio"].record(),
                    "manifest": inventory["narrationManifest"].record(),
                    "generator": base_evidence["narration"]["generator"],
                    "voice": base_evidence["narration"]["voice"],
                    "timelineContract": base_evidence["narration"]["timelineContract"],
                    "rights": base_evidence["narration"]["rights"],
                    "generationEvidence": base_evidence["narration"].get("generationEvidence"),
                    "sourceDecoded": source_audio_stats,
                    "baseDecoded": base_audio_stats,
                },
                "subtitles": inventory["canonicalSrt"].record(),
                "thumbnail": inventory["thumbnail"].record(),
                "timeline": inventory["captionTimeline"].record(),
                "releaseEvidence": base_evidence.get("releaseEvidence"),
            },
            "outputs": {
                "video": {"path": relative(output), "sha256": final_sha, "size": candidate.stat().st_size, **final},
                "subtitles": {
                    "path": relative(output_srt), "sha256": inventory["canonicalSrt"].sha256,
                    "size": staged_srt.stat().st_size, **output_srt_qa,
                },
                "thumbnail": {
                    "path": inventory["thumbnail"].source_relative,
                    "sha256": inventory["thumbnail"].sha256,
                    "size": inventory["thumbnail"].size,
                },
                "qa": {"path": relative(qa_path)},
            },
            "claimBoundary": CLAIM_BOUNDARY,
        }
        require(manifest["toolchain"] == toolchain,
                "trusted executable identity changed during composition")
        staged_qa = staged_json(qa, session, qa_path.name)
        staged_outputs.append((staged_qa, qa_path))
        manifest["outputs"]["qa"]["sha256"] = sha256_file(staged_qa)
        manifest["outputs"]["qa"]["size"] = staged_qa.stat().st_size
        staged_manifest = staged_json(manifest, session, manifest_path.name)
        staged_outputs.append((staged_manifest, manifest_path))
        promote_output_bundle(
            staged_outputs,
            session,
            replace=replace,
            verify_promoted=lambda: verify_existing(manifest_path, qa_path, allow_fixture=allow_fixture),
        )
        succeeded = True
        return {"manifest": manifest, "qa": qa}
    except RollbackError:
        preserve_failed_session = True
        raise
    finally:
        if not succeeded and not preserve_failed_session:
            _remove_tree(session)


def _logical_source_path(path_text: Any, label: str) -> Path:
    require(isinstance(path_text, str) and bool(path_text), f"{label} logical path is missing")
    raw = Path(path_text)
    require(not raw.is_absolute() and raw.as_posix() == path_text and ".." not in raw.parts,
            f"{label} logical path is not canonical")
    return ROOT / raw


def _verification_input(
    record: Any,
    label: str,
    session: Path,
    destination_name: str,
) -> ImmutableInput:
    bound = require_exact_keys(record, {"path", "stagedPath", "sha256", "size"}, label)
    require(isinstance(bound.get("sha256"), str) and SHA256_RE.fullmatch(bound["sha256"]) is not None,
            f"{label} SHA-256 is invalid")
    require(type(bound.get("size")) is int and bound["size"] >= 0, f"{label} size is invalid")
    retained_path = project_path(str(bound.get("stagedPath") or ""), f"{label} retained stage", exists=True)
    try:
        retained = read_project_file_once(retained_path, f"{label} retained stage")
    except ValueError as exc:
        raise GateError(str(exc)) from exc
    require(retained.sha256 == bound["sha256"] and retained.size == bound["size"],
            f"{label} retained staged bytes drifted")
    verification = stage_snapshot(retained, session, destination_name)
    source = _logical_source_path(bound.get("path"), label)
    return ImmutableInput(
        source_path=source,
        source_relative=str(bound["path"]),
        staged_path=verification.staged_path,
        sha256=verification.sha256,
        size=verification.size,
    )


def _verification_output(
    record: dict[str, Any],
    label: str,
    session: Path,
    destination_name: str,
) -> ImmutableInput:
    source = project_path(str(record.get("path") or ""), label, exists=True)
    staged = stage_project_input(source, label, session, destination_name)
    require(record.get("sha256") == staged.sha256 and record.get("size") == staged.size,
            f"{label} differs from its manifest byte binding")
    return staged


def validate_final_rights_profile(rights_profile: Any) -> None:
    require(rights_profile == CANONICAL_RIGHTS_PROFILE,
            "final manifest rights profile is not exact")


def validate_final_input_cross_bindings(
    evidence_record: dict[str, Any],
    live_record: dict[str, Any],
    inputs: dict[str, Any],
    inventory_payload: dict[str, Any],
) -> dict[str, Any]:
    require(evidence_record.get("captureReview") == inventory_payload["captureReview"],
            "final CAPTURE_REVIEW cross-binding is stale")
    require(live_record.get("manifest") == inventory_payload["interactionManifest"]
            and live_record.get("video") == inventory_payload["liveVideo"],
            "final live interaction cross-binding is stale")
    require(live_record.get("poster") == inventory_payload.get("livePoster"),
            "final live poster cross-binding is stale")
    require(inputs.get("baseVideo") == inventory_payload["baseVideo"]
            and inputs.get("baseManifest") == inventory_payload["baseManifest"]
            and inputs.get("subtitles") == inventory_payload["canonicalSrt"]
            and inputs.get("thumbnail") == inventory_payload["thumbnail"]
            and inputs.get("timeline") == inventory_payload["captionTimeline"],
            "final input cross-binding is stale")
    narration_record = require_exact_keys(
        inputs.get("narration"),
        {
            "audio", "manifest", "generator", "voice", "timelineContract", "rights",
            "generationEvidence", "sourceDecoded", "baseDecoded",
        },
        "final manifest narration",
    )
    require(narration_record.get("audio") == inventory_payload["narrationAudio"]
            and narration_record.get("manifest") == inventory_payload["narrationManifest"],
            "final narration immutable-input cross-binding is stale")
    return narration_record


def validate_final_narration_evidence_bindings(
    narration_record: dict[str, Any],
    base_evidence: dict[str, Any],
    source_audio_stats: dict[str, Any],
    base_audio_stats: dict[str, Any],
) -> None:
    for key in ("generator", "voice", "timelineContract", "rights", "generationEvidence"):
        require(narration_record.get(key) == base_evidence["narration"].get(key),
                f"final narration {key} differs from immutable caption-base evidence")
    require(narration_record.get("sourceDecoded") == source_audio_stats
            and narration_record.get("baseDecoded") == base_audio_stats,
            "final narration measurements differ from immutable inputs")


def validate_final_media_contract(
    base_measured: dict[str, Any],
    measured: dict[str, Any],
    expected_frame_count: Any,
    *,
    allow_fixture: bool,
) -> float:
    require(type(expected_frame_count) is int and expected_frame_count > 0,
            "caption-base timeline has no exact positive frame count")
    expected_duration = expected_frame_count / FPS
    if not allow_fixture:
        require(expected_frame_count == 5_160 and expected_duration == 172.0,
                "production frame timeline is not exactly 5,160 frames / 172 seconds")
    require(base_measured["frameCount"] == expected_frame_count == measured["frameCount"],
            "base/final frame counts differ from the exact timeline")
    require(abs(float(base_measured["durationSeconds"]) - expected_duration) <= 0.01
            and abs(float(measured["durationSeconds"]) - expected_duration) <= 0.01,
            "base/final duration differs from the exact frame timeline")
    require(measured["width"] == 1920 and measured["height"] == 1080
            and measured["videoCodec"] == "h264" and measured["pixelFormat"] == "yuv420p"
            and abs(frame_rate(measured["averageFrameRate"]) - FPS) < 0.02,
            "final video codec/frame geometry is noncanonical")
    require(measured["audioStreamCount"] == 1 and measured["audioCodec"] == "aac"
            and measured["audioSampleRate"] == AUDIO_SAMPLE_RATE
            and measured["audioChannels"] == AUDIO_CHANNELS,
            "final narration stream is noncanonical")
    return expected_duration


def validate_srt_output_binding(
    subtitle_record: dict[str, Any],
    final_subtitles: ImmutableInput,
    canonical_srt: ImmutableInput,
    srt_qa: dict[str, Any],
) -> None:
    require(final_subtitles.staged_path.read_bytes() == canonical_srt.staged_path.read_bytes(),
            "final subtitles are not byte-identical to immutable canonical SRT bytes")
    require(subtitle_record == {
        "path": final_subtitles.source_relative,
        "sha256": final_subtitles.sha256,
        "size": final_subtitles.size,
        **srt_qa,
    }, "final subtitle record differs from immutable re-measurement")
    require(final_subtitles.sha256 == canonical_srt.sha256,
            "final subtitle hash differs from the immutable canonical SRT")


def validate_exact_final_qa(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    require(actual == expected, "final QA differs from exact immutable re-measurement")


def validate_final_claim_boundary(value: Any) -> None:
    require(value == CLAIM_BOUNDARY, "final manifest claim boundary is not exact")


def verify_existing(manifest_path: Path, qa_path: Path, *, allow_fixture: bool = False) -> dict[str, Any]:
    """Snapshot once, then validate and consume only private verification bytes."""

    trusted_toolchain_records(allow_discovery=allow_fixture)
    verify_root = project_path(".artifacts/final-video/verification", "verification scratch")
    session = create_private_build_session(verify_root)
    try:
        manifest_input = stage_project_input(
            manifest_path, "real-motion manifest", session, "00-final-manifest.json",
        )
        qa_input = stage_project_input(qa_path, "real-motion QA", session, "01-final-qa.json")
        manifest = read_json(manifest_input.staged_path, "immutable real-motion manifest")
        qa = read_json(qa_input.staged_path, "immutable real-motion QA")
        require_exact_keys(
            manifest,
            {
                "schemaVersion", "status", "builder", "generatedAt", "exactRuntimeSource", "publicUrl",
                "toolchain", "builderSources", "rightsProfile", "inputSnapshots", "evidence", "liveInteraction",
                "inputs", "outputs", "claimBoundary",
            },
            "real-motion manifest",
        )
        require(manifest.get("schemaVersion") == FINAL_SCHEMA_VERSION
                and manifest.get("status") == "passed"
                and manifest.get("builder") == FINAL_BUILDER_ID,
                "final manifest is not the canonical immutable narrated build")
        require(qa.get("schemaVersion") == 2 and qa.get("status") == "passed",
                "final QA is not canonical schema-v2 passed")
        validate_trusted_toolchain(manifest.get("toolchain"), allow_discovery=allow_fixture)
        validate_final_claim_boundary(manifest.get("claimBoundary"))
        builder_sources = manifest.get("builderSources")
        require(isinstance(builder_sources, dict) and set(builder_sources) == set(RELEASE_SOURCE_RELS),
                "final manifest release-critical source inventory is incomplete")
        for relative_path in RELEASE_SOURCE_RELS:
            current = tracked_source_record(
                relative_path,
                f"release-critical source {Path(relative_path).name}",
                require_head=not allow_fixture,
            )
            require(builder_sources.get(relative_path) == current,
                    f"final manifest source binding is stale for {relative_path}")
        validate_final_rights_profile(manifest.get("rightsProfile"))

        inventory_payload = manifest.get("inputSnapshots")
        require(isinstance(inventory_payload, dict), "final manifest has no immutable input inventory")
        expected_inventory = set(CORE_INPUT_KEYS)
        if not allow_fixture:
            expected_inventory |= {
                "livePoster", "deployState", "deploymentStatus", "deploymentOutput",
                "claimEvidenceMatrix", "architectureSource", "architectureRaster",
            }
        require(set(inventory_payload) == expected_inventory,
                "final manifest immutable input inventory differs from the canonical contract")
        inventory = {
            key: _verification_input(
                inventory_payload[key],
                f"inputSnapshots.{key}",
                session,
                f"input-{index:02d}-{key}{Path(str(inventory_payload[key]['path'])).suffix or '.bin'}",
            )
            for index, key in enumerate(sorted(inventory_payload), start=10)
        }

        expected_sha = str(manifest.get("exactRuntimeSource") or "")
        expected_url = str(manifest.get("publicUrl") or "")
        evidence_record = require_exact_keys(
            manifest.get("evidence"), {"captureReview", "deploymentEvidence"}, "final manifest evidence",
        )
        live_record = require_exact_keys(
            manifest.get("liveInteraction"),
            {
                "manifest", "video", "poster", "mode", "submissionEligible", "reviewerCredentialRendered",
                "reviewerCredentialUsed", "durableReviewerWritesCreated", "canonicalQuestionSource", "recallProof",
                "actions", "overlayStartSeconds", "overlayEndSeconds",
            },
            "final manifest liveInteraction",
        )
        inputs = require_exact_keys(
            manifest.get("inputs"),
            {"baseVideo", "baseManifest", "narration", "subtitles", "thumbnail", "timeline", "releaseEvidence"},
            "final manifest inputs",
        )
        outputs = require_exact_keys(
            manifest.get("outputs"), {"video", "subtitles", "thumbnail", "qa"}, "final manifest outputs",
        )
        narration_record = validate_final_input_cross_bindings(
            evidence_record, live_record, inputs, inventory_payload,
        )

        release_inputs = {
            key: inventory[key]
            for key in (
                "deployState", "deploymentStatus", "deploymentOutput", "claimEvidenceMatrix",
                "architectureSource", "architectureRaster",
            )
            if key in inventory
        }
        _evidence, interaction = validate_bindings(
            expected_sha=expected_sha,
            expected_url=expected_url,
            evidence_path=inventory["captureReview"].staged_path,
            interaction_path=inventory["interactionManifest"].staged_path,
            live_video=inventory["liveVideo"].staged_path,
            evidence_source=inventory["captureReview"].source_path,
            interaction_source=inventory["interactionManifest"].source_path,
            live_video_source=inventory["liveVideo"].source_path,
            poster_input=inventory.get("livePoster"),
            deployment_status_input=release_inputs.get("deploymentStatus"),
            deployment_output_input=release_inputs.get("deploymentOutput"),
            allow_fixture=allow_fixture,
        )
        require(evidence_record.get("deploymentEvidence") == _evidence.get("deploymentEvidence"),
                "final deployment evidence differs from immutable CAPTURE_REVIEW")
        expected_live_safety = {
            "mode": interaction.get("mode"),
            "submissionEligible": interaction.get("submissionEligible"),
            "reviewerCredentialRendered": interaction.get("reviewerCredentialRendered"),
            "reviewerCredentialUsed": interaction.get("reviewerCredentialUsed"),
            "durableReviewerWritesCreated": interaction.get("durableReviewerWritesCreated"),
            "canonicalQuestionSource": interaction.get("canonicalQuestionSource"),
            "recallProof": interaction.get("recallProof"),
        }
        require({key: live_record.get(key) for key in expected_live_safety} == expected_live_safety,
                "final live-safety binding differs from immutable interaction evidence")
        require(live_record.get("actions") == interaction.get("actions"),
                "final action sequence differs from immutable interaction evidence")

        base_evidence, _narration_evidence, source_audio_stats, base_audio_stats = validate_base_and_narration(
            expected_sha=expected_sha,
            base_video=inventory["baseVideo"].staged_path,
            base_manifest_path=inventory["baseManifest"].staged_path,
            srt=inventory["canonicalSrt"].staged_path,
            narration_audio=inventory["narrationAudio"].staged_path,
            narration_manifest_path=inventory["narrationManifest"].staged_path,
            evidence_path=inventory["captureReview"].staged_path,
            base_video_source=inventory["baseVideo"].source_path,
            base_manifest_source=inventory["baseManifest"].source_path,
            srt_source=inventory["canonicalSrt"].source_path,
            narration_audio_source=inventory["narrationAudio"].source_path,
            narration_manifest_source=inventory["narrationManifest"].source_path,
            evidence_source=inventory["captureReview"].source_path,
            timeline_input=inventory["captionTimeline"],
            release_inputs=release_inputs,
            expected_url=expected_url,
            allow_fixture=allow_fixture,
        )
        require(inputs.get("releaseEvidence") == base_evidence.get("releaseEvidence"),
                "final release evidence differs from immutable caption-base evidence")
        validate_final_narration_evidence_bindings(
            narration_record, base_evidence, source_audio_stats, base_audio_stats,
        )

        video_record = outputs.get("video")
        subtitle_record = require_exact_keys(
            outputs.get("subtitles"), {"path", "sha256", "size", "cues", "firstStart", "lastEnd"},
            "final subtitle output",
        )
        thumbnail_record = require_exact_keys(
            outputs.get("thumbnail"), {"path", "sha256", "size"}, "final thumbnail output",
        )
        qa_record = require_exact_keys(outputs.get("qa"), {"path", "sha256", "size"}, "final QA output")
        require(isinstance(video_record, dict), "final video output record is missing")
        final_video = _verification_output(
            video_record, "final video", session, "output-final-video" + Path(str(video_record.get("path"))).suffix,
        )
        final_subtitles = _verification_output(
            subtitle_record, "final subtitles", session, "output-final-subtitles.srt",
        )
        final_thumbnail = _verification_output(
            thumbnail_record, "final thumbnail", session, "output-final-thumbnail" + Path(str(thumbnail_record.get("path"))).suffix,
        )
        require(qa_record.get("path") == qa_input.source_relative
                and qa_record.get("sha256") == qa_input.sha256
                and qa_record.get("size") == qa_input.size,
                "final QA record differs from the read-once QA bytes")
        require(thumbnail_record == {
            "path": inventory["thumbnail"].source_relative,
            "sha256": inventory["thumbnail"].sha256,
            "size": inventory["thumbnail"].size,
        } and final_thumbnail.sha256 == inventory["thumbnail"].sha256,
                "final thumbnail differs from immutable thumbnail input")
        base_measured = media_summary(inventory["baseVideo"].staged_path)
        measured = media_summary(final_video.staged_path)
        expected_video_record = {
            "path": final_video.source_relative,
            "sha256": final_video.sha256,
            "size": final_video.size,
            **measured,
        }
        require(video_record == expected_video_record,
                "final video record differs from immutable re-measurement")
        base_timeline = base_evidence.get("timeline")
        require(isinstance(base_timeline, dict), "caption-base manifest has no timeline record")
        expected_frame_count = base_timeline.get("totalFrames")
        expected_duration = validate_final_media_contract(
            base_measured, measured, expected_frame_count, allow_fixture=allow_fixture,
        )
        final_audio_stats = decoded_audio_stats(final_video.staged_path)
        require_narration_quality(final_audio_stats, "final AAC narration")
        final_audio_stats["ebuR128"] = ebur128_stats(final_video.staged_path)
        require_audio_preserved(base_audio_stats, final_audio_stats)
        srt_qa = validate_srt(final_subtitles.staged_path, expected_duration)
        validate_srt_output_binding(
            subtitle_record, final_subtitles, inventory["canonicalSrt"], srt_qa,
        )
        start = float(live_record.get("overlayStartSeconds"))
        end = float(live_record.get("overlayEndSeconds"))
        require(0 <= start < end <= expected_duration, "final overlay window is invalid")
        live_summary = media_summary(inventory["liveVideo"].staged_path)
        live_motion = diversity(
            inventory["liveVideo"].staged_path,
            duration=min(end - start, float(live_summary["durationSeconds"])),
        )
        shipped_motion = diversity(final_video.staged_path, start=start, duration=end - start)
        require(live_motion["uniqueFrames"] >= 8 and live_motion["uniqueRatio"] >= 0.25,
                "immutable live input no longer proves genuine motion")
        require(shipped_motion["uniqueFrames"] >= 8 and shipped_motion["uniqueRatio"] >= 0.25,
                "shipped overlay no longer retains genuine motion")
        expected_qa = {
            "schemaVersion": 2,
            "status": "passed",
            "duration": {
                "expectedSeconds": expected_duration,
                "baseSeconds": base_measured["durationSeconds"],
                "finalSeconds": measured["durationSeconds"],
                "exactFrames": expected_frame_count,
                "fps": FPS,
                "limitSeconds": 175,
            },
            "video": measured,
            "audio": {
                "policy": CANONICAL_AUDIO_POLICY,
                "generator": base_evidence["narration"]["generator"],
                "voice": base_evidence["narration"]["voice"],
                "rights": base_evidence["narration"]["rights"],
                "generationEvidence": base_evidence["narration"].get("generationEvidence"),
                "syntheticVoiceDisclosure": True,
                "tts": True,
                "music": False,
                "sourceNarration": source_audio_stats,
                "baseDecoded": base_audio_stats,
                "finalDecoded": final_audio_stats,
                "preservedFromBaseAac": True,
            },
            "subtitles": {
                **srt_qa,
                "canonicalInputSha256": inventory["canonicalSrt"].sha256,
                "outputSha256": inventory["canonicalSrt"].sha256,
                "byteIdentical": True,
            },
            "liveInputFrameDiversity": live_motion,
            "shippedOverlayFrameDiversity": shipped_motion,
            "overlayWindow": {"startSeconds": start, "endSeconds": end},
            "liveSafety": expected_live_safety,
        }
        validate_exact_final_qa(qa, expected_qa)
        return {
            "exactRuntimeSource": expected_sha,
            "durationSeconds": measured["durationSeconds"],
            "audio": final_audio_stats,
            "subtitleCues": srt_qa["cues"],
            "liveFrameDiversity": live_motion,
            "shippedFrameDiversity": shipped_motion,
        }
    finally:
        _remove_tree(session)


def self_test() -> int:
    trusted_toolchain_records(allow_discovery=True)
    root = safe_reset_artifact_directory(
        ".artifacts/final-video/compositor-selftest",
        "compositor self-test root",
    )
    root.mkdir(parents=True)
    sha = "1" * 40
    base = root / "base.mp4"
    base_manifest = root / "base.manifest.json"
    live = root / "live.mp4"
    thumbnail = root / "thumbnail.png"
    srt = root / "captions.srt"
    narration_audio = root / "narration.wav"
    narration_manifest = root / "narration.manifest.json"
    timeline_contract = root / "caption-timeline.json"
    evidence = root / "CAPTURE_REVIEW.json"
    interaction = root / "interaction.json"
    timeline_contract.write_text(json.dumps({
        "schemaVersion": 1,
        "beats": [
            {"number": 1, "seconds": 6, "caption": "Synthetic compositor test."},
            {"number": 2, "seconds": 6, "caption": "Not submission evidence."},
        ],
    }) + "\n", encoding="utf-8")
    run_tool("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i",
         "sine=frequency=440:sample_rate=48000:duration=12", "-af", "volume=0.80",
         "-ac", "1", "-c:a", "pcm_s16le", str(narration_audio)], "make self-test narration")
    source_stats = decoded_audio_stats(narration_audio)
    require_narration_quality(source_stats, "self-test narration")
    timeline_record = {
        "path": relative(timeline_contract), "sha256": sha256_file(timeline_contract),
        "size": timeline_contract.stat().st_size, "durationSeconds": 12, "beatCount": 2,
    }
    voice = {
        "engine": "fixture", "name": "Synthetic Fixture Tone", "culture": "en-US",
        "gender": "Neutral", "age": "Adult", "rate": 0, "volume": 100,
        "explicitlySelected": True,
    }
    rights = {
        "syntheticVoiceDisclosure": True,
        "disclosure": "Synthetic fixture audio; not submission media.",
        "networkUsed": False, "musicUsed": False, "thirdPartyMusic": False,
        "thirdPartyAudio": False, "generatedLocally": True,
        "humanVoiceRightsReviewRequired": True,
        "automatedProvenanceIsAuthoritativeRightsProof": False,
    }
    audio_record = {
        "path": relative(narration_audio), "sha256": sha256_file(narration_audio),
        "size": narration_audio.stat().st_size, "sampleRate": 48000, "channels": 1,
        "bitsPerSample": 16, "sampleFrames": 12 * 48000, "durationSeconds": 12.0,
        "peakS16": source_stats["peakS16"], "rmsS16": source_stats["rmsS16"],
        "activeSampleRatio": source_stats["activeSampleRatio"], "clippedSamples": 0,
        "nonSilentBeatCount": 2,
    }
    narration_payload = {
        "schemaVersion": 1, "status": "passed", "generator": "fixture-local-narration-v1",
        "generatedAt": "2000-01-01T00:00:00Z", "fixtureOnly": True,
        "timelineContract": timeline_record, "voice": voice, "rights": rights,
        "segments": [
            {"beatNumber": 1, "startSeconds": 0, "endSeconds": 6, "textSha256": "1" * 64,
             "sourceFrames": 1, "sourceDurationSeconds": 6, "placedStartFrame": 0,
             "placedEndFrame": 6 * 48000, "truncated": False, "peakS16": source_stats["peakS16"]},
            {"beatNumber": 2, "startSeconds": 6, "endSeconds": 12, "textSha256": "2" * 64,
             "sourceFrames": 1, "sourceDurationSeconds": 6, "placedStartFrame": 6 * 48000,
             "placedEndFrame": 12 * 48000, "truncated": False, "peakS16": source_stats["peakS16"]},
        ],
        "audio": audio_record,
    }
    narration_manifest.write_text(json.dumps(narration_payload) + "\n", encoding="utf-8")
    run_tool("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x071b16:s=1920x1080:r=30:d=12",
         "-i", str(narration_audio), "-t", "12", "-c:v", "libx264", "-preset", "ultrafast",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
         "-shortest", str(base)], "make self-test narrated base")
    run_tool("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=5",
         "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(live)], "make self-test live motion")
    run_tool("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x0b211a:s=1280x720", "-frames:v", "1", str(thumbnail)], "make self-test thumbnail")
    srt.write_text("1\n00:00:00,000 --> 00:00:06,000\nSynthetic compositor test.\n\n2\n00:00:06,000 --> 00:00:12,000\nNot submission evidence.\n", encoding="utf-8")
    base_stats = decoded_audio_stats(base)
    require_narration_quality(base_stats, "self-test base narration")
    base_payload = {
        "schemaVersion": BASE_SCHEMA_VERSION,
        "status": "passed",
        "builder": BASE_BUILDER_ID,
        "exactRuntimeSource": sha,
        "builderSource": tracked_source_record(
            "demo/tools/build_caption_video.py",
            "caption video builder source",
            require_head=False,
        ),
        "narrationValidatorSource": tracked_source_record(
            "demo/tools/build_local_narration.py",
            "local narration builder and validator source",
            require_head=False,
        ),
        "timeline": {
            "canonicalContract": {key: timeline_record[key] for key in ("path", "sha256", "size")},
            "totalFrames": 12 * int(FPS),
        },
        "narration": {
            "manifestPath": relative(narration_manifest), "manifestSha256": sha256_file(narration_manifest),
            "audioPath": relative(narration_audio), "audioSha256": sha256_file(narration_audio),
            "generator": narration_payload["generator"],
            "voice": {key: voice[key] for key in ("name", "culture", "gender")},
            "timelineContract": {key: timeline_record[key] for key in ("path", "sha256", "size")},
            "rights": {key: rights[key] for key in (
                "syntheticVoiceDisclosure", "disclosure", "thirdPartyMusic",
                "humanVoiceRightsReviewRequired", "automatedProvenanceIsAuthoritativeRightsProof",
            )},
            "measuredAudio": {key: audio_record[key] for key in (
                "sampleRate", "channels", "bitsPerSample", "sampleFrames", "durationSeconds",
                "peakS16", "rmsS16", "activeSampleRatio", "clippedSamples", "nonSilentBeatCount",
            )},
        },
        "rightsSafeAudio": {
            "voiceUsed": True, "ttsUsed": True, "musicUsed": False,
            "mode": "fixture-local-narration", "decodedPeakS16": base_stats["peakS16"],
        },
        "outputs": {
            "video": {"path": relative(base), "sha256": sha256_file(base)},
            "subtitles": {"path": relative(srt), "sha256": sha256_file(srt)},
        },
    }
    base_manifest.write_text(json.dumps(base_payload) + "\n", encoding="utf-8")
    evidence.write_text(json.dumps({"status": "passed", "exactRuntimeSource": sha}) + "\n", encoding="utf-8")
    live_summary = media_summary(live)
    live_frame_diversity = diversity(live, duration=min(float(live_summary["durationSeconds"]), 30.0))
    interaction.write_text(json.dumps({
        "schemaVersion": 1, "status": "passed", "mode": "fixture", "submissionEligible": False,
        "expectedRuntimeSha": sha, "publicUrl": DEFAULT_URL,
        "reviewerCredentialRendered": False, "reviewerCredentialUsed": False,
        "durableReviewerWritesCreated": False,
        "canonicalQuestionSource": None, "recallProof": {"fixture": True},
        "recorderSource": tracked_source_record(
            "demo/tools/record_live_motion.py",
            "live motion recorder source",
            require_head=False,
        ),
        "evidenceManifestPath": relative(evidence),
        "evidenceManifestSha256": sha256_file(evidence),
        "rawVideo": {
            "path": relative(live), "sha256": sha256_file(live), "bytes": live.stat().st_size,
            **live_summary,
        },
        "frameDiversity": live_frame_diversity,
        "actions": ["synthetic motion fixture"],
    }) + "\n", encoding="utf-8")
    compose(
        base_video=base, base_manifest=base_manifest,
        narration_audio=narration_audio, narration_manifest=narration_manifest,
        live_video=live, interaction_manifest=interaction,
        evidence_manifest=evidence, srt=srt, output_srt=root / "final.srt",
        thumbnail=thumbnail, output=root / "final.mp4", manifest_path=root / "final.manifest.json",
        qa_path=root / "final.qa.json", scratch=root / "scratch", expected_sha=sha,
        expected_url=DEFAULT_URL, overlay_start=1, overlay_end=7, replace=False,
        allow_fixture=True,
    )
    verify_existing(root / "final.manifest.json", root / "final.qa.json", allow_fixture=True)
    silent = root / "silent.wav"
    run_tool("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i",
         "anullsrc=channel_layout=mono:sample_rate=48000", "-t", "1", "-c:a", "pcm_s16le", str(silent)],
        "make self-test digital silence")
    try:
        require_narration_quality(decoded_audio_stats(silent), "self-test digital silence")
    except GateError:
        pass
    else:
        raise GateError("self-test accepted digital silence as narration")
    print("real-motion compositor self-test: PASS · 1080p/30fps · genuine frame diversity · preserved narrated AAC · silence/clipping gates · SRT sync")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--base-video")
    parser.add_argument("--base-manifest")
    parser.add_argument("--narration-audio", default=DEFAULT_NARRATION_AUDIO)
    parser.add_argument("--narration-manifest", default=DEFAULT_NARRATION_MANIFEST)
    parser.add_argument("--live-video")
    parser.add_argument("--interaction-manifest")
    parser.add_argument("--evidence-manifest", default="demo/gallery/CAPTURE_REVIEW.json")
    parser.add_argument("--srt", default=DEFAULT_SRT_OUTPUT)
    parser.add_argument("--output-srt", default=DEFAULT_SRT_OUTPUT)
    parser.add_argument("--thumbnail", default=DEFAULT_THUMBNAIL)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--qa", default=DEFAULT_QA)
    parser.add_argument("--scratch", default=".artifacts/final-video/compose")
    parser.add_argument("--expected-sha")
    parser.add_argument("--expected-url", default=DEFAULT_URL)
    parser.add_argument("--overlay-start", type=float, default=51.0)
    parser.add_argument("--overlay-end", type=float, default=73.0)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            return self_test()
        if args.verify_only:
            verified = verify_existing(
                project_path(args.manifest, "manifest", exists=True),
                project_path(args.qa, "QA", exists=True),
            )
            print(
                f"real-motion verify: PASS · {verified['durationSeconds']:.3f}s · "
                f"narrated peak {verified['audio']['peakS16']} · RMS {verified['audio']['rmsS16']:.1f} · "
                f"{verified['subtitleCues']} SRT cues · "
                f"exact SHA {verified['exactRuntimeSource'][:12]}"
            )
            return 0
        for name in ("base_video", "base_manifest", "live_video", "interaction_manifest", "expected_sha"):
            require(getattr(args, name) is not None, f"--{name.replace('_', '-')} is required")
        output = project_path(args.output, "output")
        manifest = project_path(args.manifest, "manifest")
        qa = project_path(args.qa, "QA")
        output_srt = project_path(args.output_srt, "output SRT")
        require(output.parent == ROOT / "demo" / "final-media", "final MP4 must be directly under demo/final-media")
        require(manifest.parent == output.parent and qa.parent == output.parent and output_srt.parent == output.parent,
                "final sidecars must be directly under demo/final-media")
        compose(
            base_video=project_path(args.base_video, "base video", exists=True),
            base_manifest=project_path(args.base_manifest, "base manifest", exists=True),
            narration_audio=project_path(args.narration_audio, "narration audio", exists=True),
            narration_manifest=project_path(args.narration_manifest, "narration manifest", exists=True),
            live_video=project_path(args.live_video, "live video", exists=True),
            interaction_manifest=project_path(args.interaction_manifest, "interaction manifest", exists=True),
            evidence_manifest=project_path(args.evidence_manifest, "CAPTURE_REVIEW", exists=True),
            srt=project_path(args.srt, "SRT", exists=True), output_srt=output_srt,
            thumbnail=project_path(args.thumbnail, "thumbnail", exists=True), output=output,
            manifest_path=manifest, qa_path=qa, scratch=project_path(args.scratch, "scratch"),
            expected_sha=str(args.expected_sha), expected_url=str(args.expected_url),
            overlay_start=args.overlay_start, overlay_end=args.overlay_end, replace=args.replace,
        )
        print(f"real-motion video: PASS · {relative(output)} · exact SHA {args.expected_sha[:12]} · live window {args.overlay_start:.1f}-{args.overlay_end:.1f}s")
        return 0
    except (GateError, OSError, UnicodeError, ValueError) as exc:
        print(f"real-motion video: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
