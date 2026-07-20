#!/usr/bin/env python3
"""Shared generation and verification core for MemoryAgent narration bundles.

Canonical production uses the bounded ElevenLabs generator in
``build_elevenlabs_narration.py``. This module owns the exact 172-second PCM,
manifest, rights, promotion and validation contracts and retains the older local
Windows ``System.Speech`` builder only as a separately identified compatibility
path. A SHA-bound JSON manifest records the provider/voice disclosure, timeline,
segment placement, request evidence, rights approval and measured signal properties.

The cross-platform self-test uses generated sine tones. Those fixtures are marked
unmistakably and can never satisfy the production validator.
"""

from __future__ import annotations

import argparse
from array import array
from dataclasses import dataclass
import datetime as dt
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Callable, Sequence
import wave


REPO_HINT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_HINT / "scripts"))
from repo_paths import ProjectFileSnapshot, REPO_ROOT, inside_repo, read_project_file_once  # noqa: E402


REPO = Path(REPO_ROOT)
CAPTION_CONTRACT_REL = "demo/caption-timeline.json"
DEFAULT_AUDIO_REL = ".artifacts/final-narration/memoryagent-narration.wav"
DEFAULT_MANIFEST_REL = ".artifacts/final-narration/memoryagent-narration.manifest.json"
GENERATOR_ID = "elevenlabs-multilingual-v2-narration-v1"
SYSTEM_SPEECH_GENERATOR_ID = "windows-system-speech-local-narration-v1"
FIXTURE_GENERATOR_ID = "synthetic-self-test-tone-v1"
CANONICAL_PRODUCTION_VOICE_NAME = "Microsoft Zira Desktop"
CANONICAL_PRODUCTION_RATE = 1
CANONICAL_ELEVENLABS_VOICE_ID = "pNInz6obpgDQGcFmaJgB"
CANONICAL_ELEVENLABS_VOICE_NAME = "Adam (pNInz6obpgDQGcFmaJgB)"
CANONICAL_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2"
CANONICAL_ELEVENLABS_OUTPUT_FORMAT = "pcm_24000"
CANONICAL_ELEVENLABS_SEED_BASE = 20260720
CANONICAL_ELEVENLABS_RECOVERY_RUN_ID = 29731821217
CANONICAL_ELEVENLABS_RECOVERY_AFTER_UNIX = 1784539947
CANONICAL_ELEVENLABS_RECOVERY_BEFORE_UNIX = 1784539964
CANONICAL_ELEVENLABS_RECOVERED_BEATS = (1, 2, 3, 4, 5)
CANONICAL_ELEVENLABS_LIVE_BEATS = (6, 7, 8, 9, 10)
MAX_ELEVENLABS_TIME_FIT_RATIO = 1.35
SAMPLE_RATE = 48_000
CHANNELS = 2
SAMPLE_WIDTH = 2
EXPECTED_SECONDS = 172
EXPECTED_SAMPLE_FRAMES = SAMPLE_RATE * EXPECTED_SECONDS
ACTIVE_SAMPLE_THRESHOLD = 64
MIN_PEAK_S16 = 1_024
MIN_RMS_S16 = 64.0
MIN_ACTIVE_SAMPLE_RATIO = 0.01
MIN_PRODUCTION_SEGMENT_SECONDS = 2.0
SPEECH_MARGIN_FRAMES = SAMPLE_RATE // 10
DISCLOSURE = (
    "Narration is locally generated with the Microsoft Zira Desktop synthetic voice "
    "through Windows System.Speech. No music, downloaded voice model, "
    "or third-party audio is used."
)
ELEVENLABS_DISCLOSURE = (
    "Narration is generated with the explicitly selected ElevenLabs synthetic voice "
    "pNInz6obpgDQGcFmaJgB using eleven_multilingual_v2. The paid-plan commercial-use "
    "rights were explicitly approved by the entrant. No human voice, music, fallback "
    "voice, or other third-party audio is used."
)
PROVENANCE_ASSURANCE = (
    "Hash-bound local generation evidence, not an authenticated rights attestation. "
    "Human review of the selected synthetic voice and publication rights remains required."
)
ELEVENLABS_PROVENANCE_ASSURANCE = (
    "Hash-bound provider request and decoded-response evidence, not an independent legal "
    "opinion. The entrant explicitly approved credit use and public competition publication."
)
FIXTURE_ALGORITHM = "python-stdlib-sine-fixture-v1"


class NarrationError(RuntimeError):
    """A fail-closed narration input, synthesis, or verification error."""


class NarrationRecoveryRequired(NarrationError):
    """Rollback was incomplete and project-contained recovery bytes were retained."""

    def __init__(
        self,
        message: str,
        *,
        recovery_directory: Path,
        inventory_path: Path | None,
        recoverable_paths: Sequence[Path],
    ) -> None:
        super().__init__(message)
        self.recovery_directory = recovery_directory
        self.inventory_path = inventory_path
        self.recoverable_paths = tuple(recoverable_paths)


class NarrationOwnershipConflict(NarrationError):
    """A concurrent path replacement was preserved instead of being overwritten."""

    def __init__(
        self,
        message: str,
        *,
        retained_entries: Sequence[tuple[Path, Path]] = (),
    ) -> None:
        super().__init__(message)
        self.retained_entries = tuple(retained_entries)


@dataclass(frozen=True)
class NarrationBundle:
    audio: ProjectFileSnapshot
    manifest: ProjectFileSnapshot
    payload: dict[str, Any]
    measured_audio: dict[str, int | float]


@dataclass(frozen=True)
class TrustedExecutable:
    """Read-once identity for the canonical Windows PowerShell executable."""

    path: Path
    sha256: str
    size: int


@dataclass(frozen=True)
class OwnedPath:
    """One exact filesystem identity owned by the active narration transaction."""

    path: Path
    device: int
    inode: int
    mode_type: int

    @classmethod
    def capture(cls, path: Path, label: str) -> "OwnedPath":
        try:
            metadata = path.lstat()
        except OSError as exc:
            raise NarrationError(f"{label} disappeared while its identity was captured") from exc
        require(
            stat.S_ISREG(metadata.st_mode) and not _is_reparse(metadata),
            f"{label} must be a non-reparse regular file",
        )
        return cls(path, metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode))

    def still_owned(self) -> bool:
        try:
            metadata = self.path.lstat()
        except OSError:
            return False
        return (
            metadata.st_dev,
            metadata.st_ino,
            stat.S_IFMT(metadata.st_mode),
        ) == (self.device, self.inode, self.mode_type)

    def same_identity(self, other: "OwnedPath") -> bool:
        return (
            self.device,
            self.inode,
            self.mode_type,
        ) == (
            other.device,
            other.inode,
            other.mode_type,
        )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise NarrationError(message)


def require_canonical_production_voice_name(value: Any) -> str:
    require(
        value == CANONICAL_PRODUCTION_VOICE_NAME,
        f"production narration voice must be exactly {CANONICAL_PRODUCTION_VOICE_NAME!r}",
    )
    return CANONICAL_PRODUCTION_VOICE_NAME


def project_path(value: str | Path, label: str, *, must_exist: bool = False) -> Path:
    try:
        return Path(inside_repo(value, label, must_exist=must_exist))
    except ValueError as exc:
        raise NarrationError(str(exc)) from exc


def relative_repo_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO).as_posix()
    except ValueError as exc:
        raise NarrationError("narration path escaped the repository") from exc


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def canonical_json_bytes(payload: Any) -> bytes:
    """Serialize one evidence value deterministically for a SHA-256 binding."""

    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def canonical_json_sha256(payload: Any) -> str:
    return sha256_bytes(canonical_json_bytes(payload))


def _is_reparse(metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    file_attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(reparse_flag and file_attributes & reparse_flag)


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino, stat.S_IFMT(left.st_mode)) == (
        right.st_dev,
        right.st_ino,
        stat.S_IFMT(right.st_mode),
    )


def _windows_system_directory() -> Path:
    """Ask Windows for its system directory without consulting PATH or environment variables."""

    if os.name != "nt":
        raise NarrationError("production narration requires Windows System.Speech")
    import ctypes

    buffer = ctypes.create_unicode_buffer(32_768)
    length = ctypes.windll.kernel32.GetSystemDirectoryW(buffer, len(buffer))
    require(0 < length < len(buffer), "Windows did not return its canonical system directory")
    candidate = Path(os.path.abspath(buffer.value))
    require(candidate.is_absolute(), "Windows returned a non-absolute system directory")
    return candidate


def _read_trusted_executable_once(path: Path, *, trusted_root: Path) -> TrustedExecutable:
    """Hash one regular executable while proving it stayed under a non-reparse system root."""

    try:
        lexical_root = Path(os.path.abspath(trusted_root))
        resolved_root = lexical_root.resolve(strict=True)
        require(
            os.path.normcase(str(resolved_root)) == os.path.normcase(str(lexical_root)),
            "Windows system directory must not resolve through an alias or reparse point",
        )
        root_metadata = lexical_root.lstat()
        require(stat.S_ISDIR(root_metadata.st_mode) and not _is_reparse(root_metadata), "Windows system directory is not a real directory")

        lexical = Path(os.path.abspath(path))
        relative = lexical.relative_to(lexical_root)
        require(
            relative.parts == ("WindowsPowerShell", "v1.0", "powershell.exe"),
            "Windows PowerShell path is not the canonical system location",
        )
        current = lexical_root
        for part in relative.parts:
            current /= part
            metadata = current.lstat()
            require(not _is_reparse(metadata), "Windows PowerShell path traverses a symlink or reparse point")
        resolved = lexical.resolve(strict=True)
        require(
            os.path.normcase(str(resolved)) == os.path.normcase(str(lexical)),
            "Windows PowerShell resolved away from its canonical system path",
        )
        before_path = resolved.lstat()
        require(
            stat.S_ISREG(before_path.st_mode) and not _is_reparse(before_path),
            "canonical Windows PowerShell must be a regular non-reparse file",
        )
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        raise NarrationError("canonical Windows PowerShell is missing or unsafe") from exc

    descriptor = -1
    try:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(resolved, flags)
        before_fd = os.fstat(descriptor)
        require(
            stat.S_ISREG(before_fd.st_mode)
            and _same_identity(before_path, before_fd),
            "canonical Windows PowerShell changed identity before it could be read",
        )
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
        after_fd = os.fstat(descriptor)
    except OSError as exc:
        raise NarrationError("canonical Windows PowerShell could not be read safely") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    try:
        after_path = resolved.lstat()
        still_resolved = lexical.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise NarrationError("canonical Windows PowerShell disappeared while it was read") from exc
    require(
        os.path.normcase(str(still_resolved)) == os.path.normcase(str(resolved))
        and not _is_reparse(after_path)
        and all(
            _same_identity(left, right)
            for left, right in ((before_path, before_fd), (before_fd, after_fd), (after_fd, after_path))
        ),
        "canonical Windows PowerShell changed identity while it was read",
    )
    require(
        before_fd.st_size == after_fd.st_size == after_path.st_size == size
        and before_fd.st_mtime_ns == after_fd.st_mtime_ns
        and before_fd.st_ctime_ns == after_fd.st_ctime_ns,
        "canonical Windows PowerShell changed bytes while it was read",
    )
    return TrustedExecutable(path=resolved, sha256=digest.hexdigest(), size=size)


def trusted_powershell() -> TrustedExecutable:
    """Resolve Windows PowerShell only below the OS-reported system directory."""

    system_directory = _windows_system_directory()
    return _read_trusted_executable_once(
        system_directory / "WindowsPowerShell" / "v1.0" / "powershell.exe",
        trusted_root=system_directory,
    )


def _executable_record(executable: TrustedExecutable) -> dict[str, Any]:
    return {
        "path": str(executable.path),
        "sha256": executable.sha256,
        "size": executable.size,
        "systemDirectorySource": "GetSystemDirectoryW",
        "regularFile": True,
        "reparsePoint": False,
    }


def _generator_source_record() -> dict[str, Any]:
    try:
        source = read_project_file_once(Path(__file__).resolve(), "local narration generator source")
    except ValueError as exc:
        raise NarrationError(str(exc)) from exc
    return {"path": source.relative_path, "sha256": source.sha256, "size": source.size}


def load_caption_timeline() -> tuple[ProjectFileSnapshot, tuple[tuple[int, int, str], ...]]:
    try:
        snapshot = read_project_file_once(CAPTION_CONTRACT_REL, "caption timeline contract")
        raw = json.loads(snapshot.text())
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise NarrationError("caption timeline contract is not stable valid UTF-8 JSON") from exc
    require(isinstance(raw, list) and len(raw) == 10, "caption timeline must contain exactly ten beats")
    rows: list[tuple[int, int, str]] = []
    previous_end = 0
    for number, row in enumerate(raw, start=1):
        require(isinstance(row, list) and len(row) == 3, f"caption timeline row {number} has the wrong shape")
        start, end, text = row
        require(type(start) is int and type(end) is int, f"caption timeline row {number} boundaries are not integers")
        require(isinstance(text, str) and text == text.strip() and bool(text), f"caption timeline row {number} text is invalid")
        require(start == previous_end and end > start, f"caption timeline row {number} is not contiguous")
        rows.append((start, end, text))
        previous_end = end
    require(rows[0][0] == 0 and rows[-1][1] == EXPECTED_SECONDS, "caption timeline is not exactly 172 seconds")
    return snapshot, tuple(rows)


def _samples_from_wave(content: bytes) -> tuple[array, dict[str, int]]:
    try:
        with wave.open(io.BytesIO(content), "rb") as handle:
            params = {
                "sampleRate": handle.getframerate(),
                "channels": handle.getnchannels(),
                "bitsPerSample": handle.getsampwidth() * 8,
                "sampleFrames": handle.getnframes(),
            }
            require(handle.getcomptype() == "NONE", "narration WAV must use uncompressed PCM")
            pcm = handle.readframes(handle.getnframes())
    except (EOFError, wave.Error) as exc:
        raise NarrationError("narration audio is not a valid PCM WAV") from exc
    require(params["sampleRate"] == SAMPLE_RATE, "narration WAV is not 48 kHz")
    require(params["channels"] == CHANNELS, "narration WAV is not stereo")
    require(params["bitsPerSample"] == SAMPLE_WIDTH * 8, "narration WAV is not signed 16-bit PCM")
    require(len(pcm) == params["sampleFrames"] * CHANNELS * SAMPLE_WIDTH, "narration WAV PCM length is inconsistent")
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples, params


def _signal_stats(samples: Sequence[int]) -> dict[str, int | float]:
    require(bool(samples), "narration WAV contains no PCM samples")
    peak = max(abs(min(samples)), abs(max(samples)))
    square_sum = sum(int(sample) * int(sample) for sample in samples)
    active = sum(1 for sample in samples if abs(sample) >= ACTIVE_SAMPLE_THRESHOLD)
    clipped = sum(1 for sample in samples if abs(sample) >= 32_767)
    return {
        "peakS16": peak,
        "rmsS16": round(math.sqrt(square_sum / len(samples)), 6),
        "activeSampleRatio": round(active / len(samples), 9),
        "clippedSamples": clipped,
    }


def inspect_audio(content: bytes, windows: Sequence[tuple[int, int, str]]) -> dict[str, int | float]:
    samples, params = _samples_from_wave(content)
    expected_frames = int(windows[-1][1]) * SAMPLE_RATE
    require(params["sampleFrames"] == expected_frames, "narration WAV duration differs from the requested timeline")
    overall = _signal_stats(samples)
    require(int(overall["peakS16"]) >= MIN_PEAK_S16, "narration WAV is silent or too close to silence")
    require(float(overall["rmsS16"]) >= MIN_RMS_S16, "narration WAV has no meaningful speech-level signal")
    require(float(overall["activeSampleRatio"]) >= MIN_ACTIVE_SAMPLE_RATIO, "narration WAV contains too little non-silent audio")
    require(int(overall["clippedSamples"]) == 0 and int(overall["peakS16"]) < 32_767, "narration WAV contains clipped samples")

    non_silent_beats = 0
    for number, (start, end, _text) in enumerate(windows, start=1):
        first = start * SAMPLE_RATE * CHANNELS
        last = end * SAMPLE_RATE * CHANNELS
        beat_stats = _signal_stats(samples[first:last])
        require(int(beat_stats["peakS16"]) >= MIN_PEAK_S16, f"narration beat {number} is silent")
        require(float(beat_stats["rmsS16"]) >= MIN_RMS_S16, f"narration beat {number} has no meaningful signal")
        require(
            float(beat_stats["activeSampleRatio"]) >= MIN_ACTIVE_SAMPLE_RATIO,
            f"narration beat {number} contains too little non-silent audio",
        )
        require(int(beat_stats["clippedSamples"]) == 0, f"narration beat {number} contains clipped samples")
        non_silent_beats += 1

    return {
        **params,
        "durationSeconds": params["sampleFrames"] / SAMPLE_RATE,
        **overall,
        "nonSilentBeatCount": non_silent_beats,
    }


def _little_endian_pcm(samples: Sequence[int]) -> bytes:
    payload = array("h", samples)
    if sys.byteorder != "little":
        payload.byteswap()
    return payload.tobytes()


def _segment_pcm_binding(stereo_samples: Sequence[int], placed_start: int, placed_end: int) -> dict[str, int | str]:
    left = array("h", stereo_samples[placed_start * CHANNELS : placed_end * CHANNELS : CHANNELS])
    right = array("h", stereo_samples[placed_start * CHANNELS + 1 : placed_end * CHANNELS : CHANNELS])
    require(left == right, "narration segment stereo channels are not identical mono-source placement")
    pcm = _little_endian_pcm(left)
    return {"sourcePcmSha256": sha256_bytes(pcm), "sourcePcmBytes": len(pcm)}


def _synthesis_request_contract(
    voice_name: str,
    rate: int,
    windows: Sequence[tuple[int, int, str]],
) -> dict[str, Any]:
    return {
        "voice": voice_name,
        "rate": rate,
        "segments": [
            {
                "beatNumber": number,
                "textSha256": sha256_bytes(text.encode("utf-8")),
            }
            for number, (_start, _end, text) in enumerate(windows, start=1)
        ],
    }


def _voice_metadata_record(voice: dict[str, Any]) -> dict[str, str]:
    return {
        "name": str(voice["name"]),
        "culture": str(voice["culture"]),
        "gender": str(voice["gender"]),
        "age": str(voice["age"]),
    }


def _production_generation_evidence(
    *,
    executable: TrustedExecutable,
    voice: dict[str, Any],
    rate: int,
    windows: Sequence[tuple[int, int, str]],
) -> dict[str, Any]:
    request = _synthesis_request_contract(str(voice["name"]), rate, windows)
    return {
        "evidenceType": "local-system-speech-generation-record-v1",
        "assurance": PROVENANCE_ASSURANCE,
        "generatorSource": _generator_source_record(),
        "powershellExecutable": _executable_record(executable),
        "synthesizerScriptSha256": sha256_bytes(POWERSHELL_SYNTHESIZER.encode("utf-8")),
        "synthesisRequest": request,
        "synthesisRequestSha256": canonical_json_sha256(request),
        "voiceMetadataSha256": canonical_json_sha256(_voice_metadata_record(voice)),
    }


def _elevenlabs_generator_source_record() -> dict[str, Any]:
    try:
        source = read_project_file_once(
            REPO / "demo" / "tools" / "build_elevenlabs_narration.py",
            "ElevenLabs narration generator source",
        )
    except ValueError as exc:
        raise NarrationError(str(exc)) from exc
    return {"path": source.relative_path, "sha256": source.sha256, "size": source.size}


def elevenlabs_request_contract(
    windows: Sequence[tuple[int, int, str]],
) -> dict[str, Any]:
    return {
        "apiOrigin": "https://api.elevenlabs.io",
        "endpointTemplate": "/v1/text-to-speech/{voiceId}",
        "voiceId": CANONICAL_ELEVENLABS_VOICE_ID,
        "modelId": CANONICAL_ELEVENLABS_MODEL_ID,
        "outputFormat": CANONICAL_ELEVENLABS_OUTPUT_FORMAT,
        "seedBase": CANONICAL_ELEVENLABS_SEED_BASE,
        "requestCount": len(windows),
        "retryCount": 0,
        "fallback": None,
        "executionPlan": {
            "recoveryRunId": CANONICAL_ELEVENLABS_RECOVERY_RUN_ID,
            "recoveryAfterUnixInclusive": CANONICAL_ELEVENLABS_RECOVERY_AFTER_UNIX,
            "recoveryBeforeUnixExclusive": CANONICAL_ELEVENLABS_RECOVERY_BEFORE_UNIX,
            "historyRecoveredBeats": list(CANONICAL_ELEVENLABS_RECOVERED_BEATS),
            "liveSynthesisBeats": list(CANONICAL_ELEVENLABS_LIVE_BEATS),
            "liveRequestCount": len(CANONICAL_ELEVENLABS_LIVE_BEATS),
        },
        "timingPolicy": {
            "algorithm": "linear-pcm-duration-fit-v1",
            "providerSpeed": 1.0,
            "maxCompressionRatio": MAX_ELEVENLABS_TIME_FIT_RATIO,
            "truncationAllowed": False,
        },
        "voiceSettings": {
            "stability": 0.55,
            "similarity_boost": 0.75,
            "style": 0.0,
            "use_speaker_boost": True,
        },
        "segments": [
            {
                "beatNumber": number,
                "textSha256": sha256_bytes(text.encode("utf-8")),
                "characters": len(text),
                "seed": CANONICAL_ELEVENLABS_SEED_BASE + number,
                "previousTextSha256": (
                    sha256_bytes(windows[number - 2][2].encode("utf-8")) if number > 1 else None
                ),
                "nextTextSha256": (
                    sha256_bytes(windows[number][2].encode("utf-8")) if number < len(windows) else None
                ),
            }
            for number, (_start, _end, text) in enumerate(windows, start=1)
        ],
    }


def elevenlabs_generation_evidence(
    *,
    windows: Sequence[tuple[int, int, str]],
    segments: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    request = elevenlabs_request_contract(windows)
    decoded = [
        {
            "beatNumber": segment["beatNumber"],
            "acquisition": segment["acquisition"],
            "providerPcmSha256": segment["providerPcmSha256"],
            "providerPcmBytes": segment["providerPcmBytes"],
            "canonicalPcmSha256": segment["sourcePcmSha256"],
            "canonicalPcmBytes": segment["sourcePcmBytes"],
            "timeFitApplied": segment["timeFitApplied"],
            "timeFitRatio": segment["timeFitRatio"],
            "historyItemIdSha256": segment["historyItemIdSha256"],
        }
        for segment in segments
    ]
    return {
        "evidenceType": "elevenlabs-api-generation-record-v2",
        "assurance": ELEVENLABS_PROVENANCE_ASSURANCE,
        "generatorSource": _elevenlabs_generator_source_record(),
        "synthesisRequest": request,
        "synthesisRequestSha256": canonical_json_sha256(request),
        "decodedResponses": decoded,
        "decodedResponsesSha256": canonical_json_sha256(decoded),
        "secretSerialized": False,
        "commercialUseApproved": True,
    }


def _fixture_generation_evidence(*, windows: Sequence[tuple[int, int, str]]) -> dict[str, Any]:
    request = {
        "algorithm": FIXTURE_ALGORITHM,
        "segments": [
            {"beatNumber": number, "textSha256": sha256_bytes(text.encode("utf-8"))}
            for number, (_start, _end, text) in enumerate(windows, start=1)
        ],
    }
    return {
        "evidenceType": "synthetic-test-fixture-record-v1",
        "assurance": "Fixture-only deterministic signal evidence; never publication narration.",
        "generatorSource": _generator_source_record(),
        "fixtureAlgorithm": FIXTURE_ALGORITHM,
        "synthesisRequest": request,
        "synthesisRequestSha256": canonical_json_sha256(request),
    }


def _same_number(actual: Any, expected: int | float, label: str, *, tolerance: float = 0.000001) -> None:
    require(type(actual) in {int, float}, f"narration manifest {label} is not numeric")
    require(abs(float(actual) - float(expected)) <= tolerance, f"narration manifest {label} differs from measured audio")


def validate_narration_bundle(
    audio_path: str | Path,
    manifest_path: str | Path,
    *,
    windows: Sequence[tuple[int, int, str]] | None = None,
    production_mode: bool = True,
    expected_generator: str | None = None,
    expected_audio_path: str | Path | None = None,
    expected_manifest_path: str | Path | None = None,
) -> NarrationBundle:
    timeline_snapshot, canonical_windows = load_caption_timeline()
    active_windows = tuple(windows) if windows is not None else canonical_windows
    require(bool(active_windows), "narration validation requires at least one beat")
    if production_mode:
        require(active_windows == canonical_windows, "production narration must use the exact tracked caption timeline")
    try:
        audio_snapshot = read_project_file_once(audio_path, "local narration WAV")
        manifest_snapshot = read_project_file_once(manifest_path, "local narration manifest")
        payload = json.loads(manifest_snapshot.text())
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise NarrationError("local narration bundle is missing, unstable, or invalid") from exc
    require(isinstance(payload, dict), "local narration manifest must be a JSON object")
    require(payload.get("schemaVersion") == 1 and payload.get("status") == "passed", "local narration manifest is not schema-v1 passed")
    require(
        set(payload)
        == {
            "schemaVersion",
            "status",
            "generator",
            "generatedAt",
            "fixtureOnly",
            "bundleOutputs",
            "timelineContract",
            "voice",
            "rights",
            "generationEvidence",
            "segments",
            "audio",
        },
        "local narration manifest has missing or unrecognized top-level claims",
    )
    active_generator = expected_generator or (GENERATOR_ID if production_mode else FIXTURE_GENERATOR_ID)
    require(
        active_generator in {GENERATOR_ID, SYSTEM_SPEECH_GENERATOR_ID, FIXTURE_GENERATOR_ID},
        "narration validation requested an unknown generator",
    )
    require(payload.get("generator") == active_generator, "local narration manifest has the wrong generator")
    require(payload.get("fixtureOnly") is (not production_mode), "local narration fixture/production boundary is invalid")

    logical_audio = project_path(expected_audio_path or audio_snapshot.path, "logical narration WAV path")
    logical_manifest = project_path(expected_manifest_path or manifest_snapshot.path, "logical narration manifest path")
    logical_audio_rel = relative_repo_path(logical_audio)
    logical_manifest_rel = relative_repo_path(logical_manifest)
    if production_mode:
        require(logical_audio_rel == DEFAULT_AUDIO_REL, "production narration WAV path is not canonical")
        require(logical_manifest_rel == DEFAULT_MANIFEST_REL, "production narration manifest path is not canonical")
    bundle_outputs = payload.get("bundleOutputs")
    require(isinstance(bundle_outputs, dict), "local narration manifest has no logical output binding")
    require(bundle_outputs == {"audioPath": logical_audio_rel, "manifestPath": logical_manifest_rel}, "local narration logical output binding is stale")

    timeline = payload.get("timelineContract")
    require(isinstance(timeline, dict), "local narration manifest has no timeline binding")
    require(
        timeline
        == {
            "path": timeline_snapshot.relative_path,
            "sha256": timeline_snapshot.sha256,
            "size": timeline_snapshot.size,
            "durationSeconds": active_windows[-1][1],
            "beatCount": len(active_windows),
        },
        "local narration timeline binding is stale or has unrecognized claims",
    )

    voice = payload.get("voice")
    require(isinstance(voice, dict), "local narration manifest has no voice disclosure")
    require(
        set(voice) == {"engine", "name", "culture", "gender", "age", "rate", "volume", "explicitlySelected"},
        "local narration voice disclosure is incomplete or has unrecognized claims",
    )
    require(isinstance(voice.get("name"), str) and bool(voice["name"].strip()), "local narration voice name is absent")
    require(voice.get("culture") == "en-US", "local narration voice is not en-US")
    require(isinstance(voice.get("gender"), str) and bool(voice["gender"].strip()), "local narration voice gender is absent")
    require(isinstance(voice.get("age"), str) and bool(voice["age"].strip()), "local narration voice age is absent")
    require(type(voice.get("rate")) is int and -2 <= voice["rate"] <= 4, "local narration voice rate is invalid")
    require(voice.get("volume") == 100, "local narration voice volume is not canonical")
    require(voice.get("explicitlySelected") is True, "local narration voice was not explicitly selected")
    if production_mode:
        if active_generator == GENERATOR_ID:
            require(voice.get("engine") == "ElevenLabs API", "canonical production narration is not from ElevenLabs")
            require(voice.get("name") == CANONICAL_ELEVENLABS_VOICE_NAME, "canonical ElevenLabs voice is not exact")
            require(voice.get("rate") == 0, "canonical ElevenLabs narration rate must be provider default")
        else:
            require(voice.get("engine") == "Microsoft System.Speech", "production narration is not from Windows System.Speech")
            require_canonical_production_voice_name(voice.get("name"))
            require(
                voice.get("rate") == CANONICAL_PRODUCTION_RATE,
                f"production narration rate must be exactly {CANONICAL_PRODUCTION_RATE}",
            )

    rights = payload.get("rights")
    require(isinstance(rights, dict), "local narration manifest has no rights disclosure")
    expected_rights = _elevenlabs_rights() if active_generator == GENERATOR_ID else _rights()
    require(rights == expected_rights, "local narration rights disclosure is stale or has unrecognized claims")
    require(rights.get("syntheticVoiceDisclosure") is True, "synthetic voice disclosure is absent")
    expected_disclosure = ELEVENLABS_DISCLOSURE if active_generator == GENERATOR_ID else DISCLOSURE
    require(rights.get("disclosure") == expected_disclosure, "synthetic voice disclosure text is not canonical")
    require(rights.get("musicUsed") is False and rights.get("thirdPartyMusic") is False, "local narration manifest reports music")
    if active_generator == GENERATOR_ID:
        require(rights.get("networkUsed") is True, "ElevenLabs narration does not disclose provider network use")
        require(rights.get("thirdPartyAudio") is True, "ElevenLabs narration does not disclose provider audio")
        require(rights.get("generatedLocally") is False, "ElevenLabs narration incorrectly claims local generation")
        require(rights.get("commercialUseRightsApproved") is True, "ElevenLabs commercial-use approval is absent")
    else:
        require(rights.get("networkUsed") is False, "local narration manifest reports network use")
        require(rights.get("thirdPartyAudio") is False, "local narration manifest reports third-party audio")
        require(rights.get("generatedLocally") is True, "local narration manifest does not attest local generation")
    require(rights.get("humanVoiceRightsReviewRequired") is True, "local narration lost the mandatory human rights-review gate")
    require(rights.get("automatedProvenanceIsAuthoritativeRightsProof") is False, "local narration overstates automated provenance evidence")

    audio_record = payload.get("audio")
    require(isinstance(audio_record, dict), "local narration manifest has no audio binding")
    require(
        set(audio_record)
        == {
            "path",
            "sha256",
            "size",
            "sampleRate",
            "channels",
            "bitsPerSample",
            "sampleFrames",
            "durationSeconds",
            "peakS16",
            "rmsS16",
            "activeSampleRatio",
            "clippedSamples",
            "nonSilentBeatCount",
        },
        "local narration audio binding is incomplete or has unrecognized claims",
    )
    require(audio_record.get("path") == logical_audio_rel, "local narration audio path is stale")
    require(audio_record.get("sha256") == audio_snapshot.sha256, "local narration audio SHA-256 is stale")
    require(audio_record.get("size") == audio_snapshot.size, "local narration audio size is stale")
    measured = inspect_audio(audio_snapshot.data, active_windows)
    for field in (
        "sampleRate",
        "channels",
        "bitsPerSample",
        "sampleFrames",
        "durationSeconds",
        "peakS16",
        "rmsS16",
        "activeSampleRatio",
        "clippedSamples",
        "nonSilentBeatCount",
    ):
        _same_number(audio_record.get(field), measured[field], f"audio.{field}")

    segments = payload.get("segments")
    require(isinstance(segments, list) and len(segments) == len(active_windows), "local narration segment inventory is incomplete")
    stereo_samples, _audio_params = _samples_from_wave(audio_snapshot.data)
    for number, ((start, end, text), segment) in enumerate(zip(active_windows, segments), start=1):
        require(isinstance(segment, dict), f"local narration segment {number} is invalid")
        expected_segment_fields = {
            "beatNumber",
            "startSeconds",
            "endSeconds",
            "textSha256",
            "sourceFrames",
            "sourceDurationSeconds",
            "placedStartFrame",
            "placedEndFrame",
            "truncated",
            "peakS16",
            "sourcePcmSha256",
            "sourcePcmBytes",
        }
        if active_generator == GENERATOR_ID:
            expected_segment_fields.update(
                {
                    "acquisition",
                    "providerFrames",
                    "providerDurationSeconds",
                    "providerPcmSha256",
                    "providerPcmBytes",
                    "timeFitApplied",
                    "timeFitRatio",
                    "historyItemIdSha256",
                }
            )
        require(
            set(segment) == expected_segment_fields,
            f"local narration segment {number} is incomplete or has unrecognized claims",
        )
        require(segment.get("beatNumber") == number, f"local narration segment {number} number is stale")
        require(segment.get("startSeconds") == start and segment.get("endSeconds") == end, f"local narration segment {number} window is stale")
        require(segment.get("textSha256") == sha256_bytes(text.encode("utf-8")), f"local narration segment {number} text is stale")
        require(segment.get("truncated") is False, f"local narration segment {number} was truncated")
        source_frames = segment.get("sourceFrames")
        placed_start = segment.get("placedStartFrame")
        placed_end = segment.get("placedEndFrame")
        require(type(source_frames) is int and source_frames > 0, f"local narration segment {number} has no source frames")
        if production_mode:
            require(
                source_frames >= int(MIN_PRODUCTION_SEGMENT_SECONDS * SAMPLE_RATE),
                f"local narration segment {number} is too short to prove meaningful speech",
            )
        require(type(placed_start) is int and type(placed_end) is int, f"local narration segment {number} placement is invalid")
        require(placed_end - placed_start == source_frames, f"local narration segment {number} placement implies truncation")
        require(start * SAMPLE_RATE <= placed_start < placed_end <= end * SAMPLE_RATE, f"local narration segment {number} escaped its beat")
        _same_number(segment.get("sourceDurationSeconds"), source_frames / SAMPLE_RATE, f"segment {number} duration")
        require(type(segment.get("peakS16")) is int and segment["peakS16"] >= MIN_PEAK_S16, f"local narration segment {number} is silent")
        expected_pcm_binding = _segment_pcm_binding(stereo_samples, placed_start, placed_end)
        require(
            segment.get("sourcePcmSha256") == expected_pcm_binding["sourcePcmSha256"]
            and segment.get("sourcePcmBytes") == expected_pcm_binding["sourcePcmBytes"],
            f"local narration segment {number} source PCM binding is stale",
        )
        if active_generator == GENERATOR_ID:
            provider_frames = segment.get("providerFrames")
            require(type(provider_frames) is int and provider_frames >= source_frames, f"ElevenLabs segment {number} provider frame count is invalid")
            _same_number(segment.get("providerDurationSeconds"), provider_frames / SAMPLE_RATE, f"segment {number} provider duration")
            require(segment.get("providerPcmBytes") == provider_frames * SAMPLE_WIDTH, f"ElevenLabs segment {number} provider PCM size is invalid")
            require(
                isinstance(segment.get("providerPcmSha256"), str)
                and len(segment["providerPcmSha256"]) == 64
                and all(char in "0123456789abcdef" for char in segment["providerPcmSha256"]),
                f"ElevenLabs segment {number} provider PCM hash is invalid",
            )
            expected_fit = provider_frames > source_frames
            require(segment.get("timeFitApplied") is expected_fit, f"ElevenLabs segment {number} time-fit disclosure is stale")
            fit_ratio = provider_frames / source_frames
            _same_number(segment.get("timeFitRatio"), fit_ratio, f"segment {number} time-fit ratio")
            require(fit_ratio <= MAX_ELEVENLABS_TIME_FIT_RATIO, f"ElevenLabs segment {number} exceeds the maximum time-fit ratio")
            expected_acquisition = "history-recovery" if number in CANONICAL_ELEVENLABS_RECOVERED_BEATS else "live-synthesis"
            require(segment.get("acquisition") == expected_acquisition, f"ElevenLabs segment {number} acquisition is stale")
            history_hash = segment.get("historyItemIdSha256")
            if expected_acquisition == "history-recovery":
                require(
                    isinstance(history_hash, str)
                    and len(history_hash) == 64
                    and all(char in "0123456789abcdef" for char in history_hash),
                    f"ElevenLabs segment {number} history binding is invalid",
                )
            else:
                require(history_hash is None, f"ElevenLabs segment {number} has an unexpected history binding")

    generation_evidence = payload.get("generationEvidence")
    require(isinstance(generation_evidence, dict), "local narration manifest has no generation evidence")
    if production_mode:
        if active_generator == GENERATOR_ID:
            expected_evidence = elevenlabs_generation_evidence(windows=active_windows, segments=segments)
        else:
            rate = voice.get("rate")
            require(type(rate) is int and -2 <= rate <= 4, "production narration voice rate is invalid")
            current_executable = trusted_powershell()
            expected_evidence = _production_generation_evidence(
                executable=current_executable,
                voice=voice,
                rate=rate,
                windows=active_windows,
            )
        require(generation_evidence == expected_evidence, "production narration generation evidence is stale or incomplete")
    else:
        require(
            generation_evidence == _fixture_generation_evidence(windows=active_windows),
            "synthetic narration fixture generation evidence is stale or incomplete",
        )

    return NarrationBundle(audio_snapshot, manifest_snapshot, payload, measured)


def _write_wave(path: Path, stereo_samples: array, sample_frames: int) -> None:
    require(len(stereo_samples) == sample_frames * CHANNELS, "narration PCM inventory is incomplete")
    payload = array("h", stereo_samples)
    if sys.byteorder != "little":
        payload.byteswap()
    with path.open("xb") as raw:
        with wave.open(raw, "wb") as handle:
            handle.setnchannels(CHANNELS)
            handle.setsampwidth(SAMPLE_WIDTH)
            handle.setframerate(SAMPLE_RATE)
            handle.writeframes(payload.tobytes())


def _atomic_manifest(path: Path, payload: dict[str, Any], scratch: Path) -> None:
    temporary = scratch / "narration.manifest.writing.json"
    content = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with temporary.open("xb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _rights() -> dict[str, Any]:
    return {
        "syntheticVoiceDisclosure": True,
        "disclosure": DISCLOSURE,
        "networkUsed": False,
        "musicUsed": False,
        "thirdPartyMusic": False,
        "thirdPartyAudio": False,
        "generatedLocally": True,
        "humanVoiceRightsReviewRequired": True,
        "automatedProvenanceIsAuthoritativeRightsProof": False,
    }


def _elevenlabs_rights() -> dict[str, Any]:
    return {
        "syntheticVoiceDisclosure": True,
        "disclosure": ELEVENLABS_DISCLOSURE,
        "networkUsed": True,
        "musicUsed": False,
        "thirdPartyMusic": False,
        "thirdPartyAudio": True,
        "generatedLocally": False,
        "commercialUseRightsApproved": True,
        "humanVoiceRightsReviewRequired": True,
        "automatedProvenanceIsAuthoritativeRightsProof": False,
    }


def _base_manifest(
    *,
    generator: str,
    fixture_only: bool,
    timeline: ProjectFileSnapshot,
    windows: Sequence[tuple[int, int, str]],
    voice: dict[str, Any],
    segments: list[dict[str, Any]],
    audio_snapshot: ProjectFileSnapshot,
    measured: dict[str, int | float],
    logical_audio_path: Path,
    logical_manifest_path: Path,
    generation_evidence: dict[str, Any],
    rights: dict[str, Any] | None = None,
) -> dict[str, Any]:
    logical_audio_rel = relative_repo_path(logical_audio_path)
    logical_manifest_rel = relative_repo_path(logical_manifest_path)
    return {
        "schemaVersion": 1,
        "status": "passed",
        "generator": generator,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "fixtureOnly": fixture_only,
        "bundleOutputs": {"audioPath": logical_audio_rel, "manifestPath": logical_manifest_rel},
        "timelineContract": {
            "path": timeline.relative_path,
            "sha256": timeline.sha256,
            "size": timeline.size,
            "durationSeconds": windows[-1][1],
            "beatCount": len(windows),
        },
        "voice": voice,
        "rights": dict(rights if rights is not None else _rights()),
        "generationEvidence": generation_evidence,
        "segments": segments,
        "audio": {
            "path": logical_audio_rel,
            "sha256": audio_snapshot.sha256,
            "size": audio_snapshot.size,
            **measured,
        },
    }


POWERSHELL_SYNTHESIZER = r'''param([Parameter(Mandatory=$true)][string]$InputJson)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$config = Get-Content -LiteralPath $InputJson -Raw | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $matches = @($synth.GetInstalledVoices() | Where-Object {
    $_.Enabled -and $_.VoiceInfo.Name -ceq [string]$config.voice
  })
  if ($matches.Count -ne 1) { throw "the explicitly named installed voice was not found exactly once" }
  $info = $matches[0].VoiceInfo
  if ($info.Culture.Name -ne "en-US") { throw "the explicitly named installed voice is not en-US" }
  $synth.SelectVoice([string]$config.voice)
  $synth.Rate = [int]$config.rate
  $synth.Volume = 100
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    48000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
  )
  foreach ($segment in $config.segments) {
    $synth.SetOutputToWaveFile([string]$segment.output, $format)
    $synth.Speak([string]$segment.text)
    $synth.SetOutputToNull()
  }
  [ordered]@{
    name = $info.Name
    culture = $info.Culture.Name
    gender = $info.Gender.ToString()
    age = $info.Age.ToString()
  } | ConvertTo-Json -Compress
} finally {
  $synth.Dispose()
}
'''


def _powershell() -> str:
    return str(trusted_powershell().path)


def list_voices() -> int:
    executable = _powershell()
    command = (
        "Add-Type -AssemblyName System.Speech; "
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "try {$s.GetInstalledVoices() | Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'en-US'} | "
        "ForEach-Object {$_.VoiceInfo.Name}} finally {$s.Dispose()}"
    )
    result = subprocess.run(
        [executable, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    require(result.returncode == 0, "could not enumerate installed en-US System.Speech voices")
    voices = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    require(bool(voices), "no enabled en-US System.Speech voice is installed")
    for voice in voices:
        print(voice)
    return 0


def _read_mono_segment(path: Path) -> tuple[array, dict[str, int | float]]:
    try:
        with wave.open(str(path), "rb") as handle:
            require(handle.getnchannels() == 1, "System.Speech segment is not mono")
            require(handle.getsampwidth() == SAMPLE_WIDTH, "System.Speech segment is not 16-bit PCM")
            require(handle.getframerate() == SAMPLE_RATE, "System.Speech segment is not 48 kHz")
            require(handle.getcomptype() == "NONE", "System.Speech segment is not uncompressed PCM")
            pcm = handle.readframes(handle.getnframes())
    except (EOFError, wave.Error) as exc:
        raise NarrationError("System.Speech produced an invalid WAV segment") from exc
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    stats = _signal_stats(samples)
    require(int(stats["peakS16"]) >= MIN_PEAK_S16, "System.Speech produced a silent segment")
    require(int(stats["clippedSamples"]) == 0, "System.Speech produced a clipped segment")
    return samples, stats


def _require_safe_existing_output(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise NarrationError(f"{label} could not be inspected safely") from exc
    require(
        stat.S_ISREG(metadata.st_mode) and not _is_reparse(metadata) and metadata.st_nlink == 1,
        f"{label} must be one singly-linked regular file",
    )


def _move_no_overwrite(source: Path, destination: Path) -> None:
    """Atomically move one path entry only when the destination is absent."""

    if os.name == "nt":
        os.rename(source, destination)
        return
    if sys.platform.startswith("linux"):
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2", None)
        require(renameat2 is not None, "atomic no-overwrite rename is unavailable")
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
        if result != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(destination))
        return
    if sys.platform == "darwin":
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        renamex_np = getattr(libc, "renamex_np", None)
        require(renamex_np is not None, "atomic no-overwrite rename is unavailable")
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        result = renamex_np(os.fsencode(source), os.fsencode(destination), 0x00000004)
        if result != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(destination))
        return
    raise NarrationError("atomic no-overwrite rename is unavailable on this platform")


def _unique_recovery_path(source: Path, scratch: Path, kind: str) -> Path:
    require(source.parent in {scratch, scratch.parent}, "narration recovery source escaped its transaction directories")
    for _attempt in range(64):
        candidate = scratch / f".{source.name}.{os.urandom(12).hex()}.{kind}"
        if not candidate.exists() and not candidate.is_symlink():
            return candidate
    raise NarrationError(f"could not reserve a unique narration {kind} path")


def _move_expected_to_recovery(
    owner: OwnedPath,
    scratch: Path,
    kind: str,
    label: str,
    *,
    missing_ok: bool,
) -> OwnedPath | None:
    """Move the current entry aside and prove it is still the expected identity."""

    if not owner.path.exists() and not owner.path.is_symlink():
        if missing_ok:
            return None
        raise NarrationOwnershipConflict(f"{label} disappeared before it could be preserved")
    recovery = _unique_recovery_path(owner.path, scratch, kind)
    try:
        _move_no_overwrite(owner.path, recovery)
    except FileNotFoundError:
        if missing_ok:
            return None
        raise NarrationOwnershipConflict(f"{label} disappeared before it could be preserved")
    except OSError as exc:
        raise NarrationError(f"{label} could not be moved to private recovery") from exc
    try:
        moved = OwnedPath.capture(recovery, f"{label} recovery entry")
    except NarrationError as exc:
        raise NarrationOwnershipConflict(
            f"{label} changed to an unsupported path entry; it was retained at {relative_repo_path(recovery)}",
            retained_entries=((recovery, owner.path),),
        ) from exc
    if not moved.same_identity(owner):
        raise NarrationOwnershipConflict(
            f"{label} changed ownership; the concurrent bytes were retained at {relative_repo_path(recovery)}",
            retained_entries=((recovery, owner.path),),
        )
    return moved


def _quarantine_owned_publication(
    owner: OwnedPath,
    scratch: Path,
    label: str,
) -> OwnedPath | None:
    """Withdraw only transaction-owned public bytes and preserve a racing entry."""

    try:
        return _move_expected_to_recovery(
            owner,
            scratch,
            "failed-promotion",
            label,
            missing_ok=True,
        )
    except NarrationOwnershipConflict as conflict:
        if not conflict.retained_entries:
            raise
        recovery, intended = conflict.retained_entries[0]
        try:
            _move_no_overwrite(recovery, intended)
        except OSError as restore_exc:
            raise NarrationOwnershipConflict(
                f"{label} changed ownership; concurrent bytes remain at {relative_repo_path(recovery)}",
                retained_entries=((recovery, intended),),
            ) from restore_exc
        raise NarrationOwnershipConflict(
            f"{label} changed ownership; the concurrent destination was restored without overwrite",
            retained_entries=((intended, intended),),
        ) from conflict


def _publish_noreplace(
    source_owner: OwnedPath,
    target: Path,
    scratch: Path,
    label: str,
) -> OwnedPath:
    """Atomically move one owned source into an absent destination and bind it."""

    if not source_owner.still_owned():
        raise NarrationOwnershipConflict(
            f"{label} source changed before publication and was retained for review",
            retained_entries=((source_owner.path, source_owner.path),),
        )
    try:
        _move_no_overwrite(source_owner.path, target)
    except FileExistsError as exc:
        raise NarrationError(f"narration destination appeared and was not overwritten: {target.name}") from exc
    except FileNotFoundError as exc:
        raise NarrationOwnershipConflict(f"{label} source disappeared during publication") from exc
    except OSError as exc:
        raise NarrationError(f"narration destination could not be promoted safely: {target.name}") from exc
    expected = OwnedPath(target, source_owner.device, source_owner.inode, source_owner.mode_type)
    try:
        published = OwnedPath.capture(target, f"{label} destination")
    except NarrationError as publication_exc:
        if not target.exists() and not target.is_symlink():
            raise NarrationOwnershipConflict(f"{label} destination disappeared during publication") from publication_exc
        recovery = _unique_recovery_path(target, scratch, "untrusted-publication")
        try:
            _move_no_overwrite(target, recovery)
        except OSError as recovery_exc:
            raise NarrationOwnershipConflict(
                f"{label} destination could not be identity-checked and was preserved in place",
                retained_entries=((target, target),),
            ) from recovery_exc
        raise NarrationOwnershipConflict(
            f"{label} destination could not be identity-checked and was retained for review",
            retained_entries=((recovery, target),),
        ) from publication_exc
    if not published.same_identity(expected):
        moved = _move_expected_to_recovery(
            published,
            scratch,
            "concurrent-publication",
            f"concurrent replacement during {label}",
            missing_ok=True,
        )
        retained = ((moved.path, target),) if moved is not None else ()
        raise NarrationOwnershipConflict(
            f"{label} destination changed ownership during publication",
            retained_entries=retained,
        )
    return published


def _recovery_file_record(path: Path, intended_target: Path, role: str) -> tuple[dict[str, Any] | None, Path | None]:
    if not path.exists() and not path.is_symlink():
        return None, None
    try:
        snapshot = read_project_file_once(path, f"retained narration {role}")
    except ValueError:
        return {
            "path": relative_repo_path(path),
            "intendedTarget": relative_repo_path(intended_target),
            "role": role,
            "stableRegularFile": False,
        }, None
    return (
        {
            "path": snapshot.relative_path,
            "intendedTarget": relative_repo_path(intended_target),
            "role": role,
            "stableRegularFile": True,
            "sha256": snapshot.sha256,
            "size": snapshot.size,
        },
        snapshot.path,
    )


def _retain_failed_transaction(
    *,
    scratch: Path,
    backups: dict[Path, OwnedPath],
    quarantines: Sequence[tuple[Path, Path, str]],
    concurrent_entries: Sequence[tuple[Path, Path]],
    targets: Sequence[tuple[Path, str]],
    rollback_failures: list[str],
    cause: BaseException,
) -> NarrationRecoveryRequired:
    """Record exact retained paths and signal callers not to clean this scratch."""

    original_records: list[dict[str, Any]] = []
    quarantine_records: list[dict[str, Any]] = []
    concurrent_records: list[dict[str, Any]] = []
    destination_records: list[dict[str, Any]] = []
    recoverable_paths: list[Path] = []
    for target, backup in backups.items():
        record, recoverable = _recovery_file_record(backup.path, target, "original-output-backup")
        if record is not None:
            original_records.append(record)
        if recoverable is not None:
            recoverable_paths.append(recoverable)
    for target, quarantine, role in quarantines:
        record, recoverable = _recovery_file_record(quarantine, target, role)
        if record is not None:
            quarantine_records.append(record)
        if recoverable is not None:
            recoverable_paths.append(recoverable)
    for retained, intended in concurrent_entries:
        record, recoverable = _recovery_file_record(retained, intended, "preserved-concurrent-entry")
        if record is not None:
            concurrent_records.append(record)
        if recoverable is not None:
            recoverable_paths.append(recoverable)
    for target, _label in targets:
        record, recoverable = _recovery_file_record(target, target, "unrecovered-destination")
        if record is not None:
            destination_records.append(record)
        if recoverable is not None:
            recoverable_paths.append(recoverable)

    inventory_path = scratch / f"RECOVERY_REQUIRED-{os.urandom(12).hex()}.json"
    inventory = {
        "schemaVersion": 1,
        "status": "manual-recovery-required",
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "recoveryDirectory": relative_repo_path(scratch),
        "recoverableOriginals": original_records,
        "quarantinedNewOutputs": quarantine_records,
        "retainedConcurrentEntries": concurrent_records,
        "unrecoveredDestinations": destination_records,
        "rollbackFailures": list(rollback_failures),
        "originalFailure": {"type": type(cause).__name__, "message": str(cause)},
        "instruction": "Do not publish these files. Restore only a SHA-reviewed original-output-backup to its intendedTarget.",
    }
    try:
        with inventory_path.open("xb") as handle:
            handle.write((json.dumps(inventory, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as inventory_exc:
        rollback_failures.append(f"could not write recovery inventory: {inventory_exc}")
        inventory_path = None

    recovery_rel = relative_repo_path(scratch)
    inventory_rel = relative_repo_path(inventory_path) if inventory_path is not None else "unavailable"
    recoverable_rel = ", ".join(relative_repo_path(path) for path in recoverable_paths) or "none verified"
    detail = "; ".join(rollback_failures)
    return NarrationRecoveryRequired(
        "narration promotion failed and rollback was incomplete; "
        f"recovery directory retained at {recovery_rel}; inventory {inventory_rel}; "
        f"recoverable paths: {recoverable_rel}; rollback errors: {detail}",
        recovery_directory=scratch,
        inventory_path=inventory_path,
        recoverable_paths=recoverable_paths,
    )


def _promote_narration_pair(
    *,
    staged_audio: Path,
    staged_manifest: Path,
    audio_path: Path,
    manifest_path: Path,
    scratch: Path,
    replace_existing: bool,
    validate_promoted: Callable[[], NarrationBundle],
) -> NarrationBundle:
    """Promote both bundle files as one rollback-protected logical transaction."""

    require(staged_audio.parent == scratch and staged_manifest.parent == scratch, "staged narration pair escaped private scratch")
    require(staged_audio.is_file() and staged_manifest.is_file(), "staged narration pair is incomplete")
    require(audio_path.parent == manifest_path.parent == scratch.parent, "narration transaction crossed directories")

    targets = ((audio_path, "narration WAV"), (manifest_path, "narration manifest"))
    for target, label in targets:
        _require_safe_existing_output(target, label)
        if not replace_existing:
            require(not target.exists(), "narration output already exists; pass --replace intentionally")

    staged_pairs = ((staged_audio, audio_path), (staged_manifest, manifest_path))
    staged_owners: dict[Path, OwnedPath] = {}
    for staged, target in staged_pairs:
        metadata = staged.lstat()
        require(metadata.st_nlink == 1, f"staged narration output for {target.name} must have exactly one link")
        staged_owners[staged] = OwnedPath.capture(staged, f"staged narration output for {target.name}")

    backups: dict[Path, OwnedPath] = {}
    quarantines: list[tuple[Path, Path, str]] = []
    concurrent_entries: list[tuple[Path, Path]] = []
    promoted: dict[Path, OwnedPath] = {}
    rollback_failures: list[str] = []
    try:
        if replace_existing:
            for target, label in targets:
                if target.exists():
                    existing_owner = OwnedPath.capture(target, label)
                    backup = _move_expected_to_recovery(
                        existing_owner,
                        scratch,
                        "rollback",
                        f"backup of {label}",
                        missing_ok=False,
                    )
                    require(backup is not None, f"backup of {label} disappeared")
                    backups[target] = backup

        for staged, target in staged_pairs:
            owner = staged_owners[staged]
            published = _publish_noreplace(
                owner,
                target,
                scratch,
                f"narration publication for {target.name}",
            )
            promoted[target] = published
        return validate_promoted()
    except BaseException as exc:
        if isinstance(exc, NarrationOwnershipConflict):
            rollback_failures.append(str(exc))
            concurrent_entries.extend(exc.retained_entries)
        for target, owner in reversed(tuple(promoted.items())):
            try:
                quarantine = _quarantine_owned_publication(
                    owner,
                    scratch,
                    f"rollback withdrawal for {target.name}",
                )
                if quarantine is not None:
                    quarantines.append((target, quarantine.path, "failed-new-output"))
            except NarrationOwnershipConflict as rollback_exc:
                rollback_failures.append(str(rollback_exc))
                concurrent_entries.extend(rollback_exc.retained_entries)
            except (OSError, NarrationError) as rollback_exc:
                rollback_failures.append(f"could not quarantine {target.name}: {rollback_exc}")
        for target, backup in tuple(backups.items()):
            try:
                if not backup.still_owned():
                    rollback_failures.append(f"original backup for {target.name} changed identity")
                    continue
                _publish_noreplace(
                    backup,
                    target,
                    scratch,
                    f"rollback restoration for {target.name}",
                )
            except NarrationOwnershipConflict as rollback_exc:
                rollback_failures.append(str(rollback_exc))
                concurrent_entries.extend(rollback_exc.retained_entries)
            except (OSError, NarrationError) as rollback_exc:
                rollback_failures.append(f"could not restore {target.name}: {rollback_exc}")
        if rollback_failures:
            raise _retain_failed_transaction(
                scratch=scratch,
                backups=backups,
                quarantines=quarantines,
                concurrent_entries=concurrent_entries,
                targets=targets,
                rollback_failures=rollback_failures,
                cause=exc,
            ) from exc
        raise


def build_production_bundle(
    *,
    voice_name: str,
    rate: int,
    audio_path: Path,
    manifest_path: Path,
    replace_existing: bool,
) -> NarrationBundle:
    voice_name = require_canonical_production_voice_name(voice_name)
    require(
        rate == CANONICAL_PRODUCTION_RATE,
        f"--rate must be exactly {CANONICAL_PRODUCTION_RATE} for canonical production narration",
    )
    require(audio_path.suffix.lower() == ".wav", "narration audio output must end in .wav")
    require(manifest_path.suffix.lower() == ".json", "narration manifest output must end in .json")
    require(audio_path != manifest_path, "narration audio and manifest paths must differ")
    if not replace_existing:
        require(not audio_path.exists() and not manifest_path.exists(), "narration output already exists; pass --replace intentionally")
    timeline, windows = load_caption_timeline()
    output_parent = audio_path.parent
    require(output_parent == manifest_path.parent, "narration WAV and manifest must share one project-contained directory")
    require(relative_repo_path(audio_path) == DEFAULT_AUDIO_REL, "production narration WAV must use the canonical ignored output path")
    require(relative_repo_path(manifest_path) == DEFAULT_MANIFEST_REL, "production narration manifest must use the canonical ignored output path")
    output_parent.mkdir(parents=True, exist_ok=True)
    executable = trusted_powershell()
    scratch = Path(tempfile.mkdtemp(prefix="memoryagent-local-narration-", dir=output_parent))
    retain_scratch_for_recovery = False
    try:
        runner = scratch / "synthesize.ps1"
        with runner.open("xb") as handle:
            handle.write(POWERSHELL_SYNTHESIZER.encode("utf-8"))
        segment_specs = []
        for number, (_start, _end, text) in enumerate(windows, start=1):
            segment_specs.append({"text": text, "output": str((scratch / f"segment-{number:02d}.wav").resolve())})
        config = scratch / "synthesis.json"
        with config.open("xb") as handle:
            handle.write(canonical_json_bytes({"voice": voice_name, "rate": rate, "segments": segment_specs}))
        result = subprocess.run(
            [
                str(executable.path),
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(runner),
                "-InputJson",
                str(config),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        require(result.returncode == 0, "System.Speech synthesis failed; no narration bundle was promoted")
        try:
            voice_info = json.loads(result.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as exc:
            raise NarrationError("System.Speech did not return stable voice metadata") from exc
        require(voice_info.get("name") == voice_name, "System.Speech used a different voice than requested")
        require(voice_info.get("culture") == "en-US", "System.Speech voice metadata is not en-US")

        stereo = array("h", [0]) * EXPECTED_SAMPLE_FRAMES * CHANNELS
        segments: list[dict[str, Any]] = []
        for number, ((start, end, text), spec) in enumerate(zip(windows, segment_specs), start=1):
            mono, stats = _read_mono_segment(Path(spec["output"]))
            capacity = (end - start) * SAMPLE_RATE
            require(
                len(mono) + 2 * SPEECH_MARGIN_FRAMES <= capacity,
                f"narration beat {number} does not fit its canonical window at the required production rate",
            )
            placed_start = start * SAMPLE_RATE + SPEECH_MARGIN_FRAMES
            placed_end = placed_start + len(mono)
            require(placed_end <= end * SAMPLE_RATE - SPEECH_MARGIN_FRAMES, f"narration beat {number} would be truncated")
            for offset, sample in enumerate(mono):
                frame = placed_start + offset
                stereo[frame * 2] = sample
                stereo[frame * 2 + 1] = sample
            segments.append(
                {
                    "beatNumber": number,
                    "startSeconds": start,
                    "endSeconds": end,
                    "textSha256": sha256_bytes(text.encode("utf-8")),
                    "sourceFrames": len(mono),
                    "sourceDurationSeconds": len(mono) / SAMPLE_RATE,
                    "placedStartFrame": placed_start,
                    "placedEndFrame": placed_end,
                    "truncated": False,
                    "peakS16": stats["peakS16"],
                    **{
                        "sourcePcmSha256": sha256_bytes(_little_endian_pcm(mono)),
                        "sourcePcmBytes": len(mono) * SAMPLE_WIDTH,
                    },
                }
            )

        staged_audio = scratch / "narration.candidate.wav"
        _write_wave(staged_audio, stereo, EXPECTED_SAMPLE_FRAMES)
        audio_snapshot = read_project_file_once(staged_audio, "staged local narration WAV")
        measured = inspect_audio(audio_snapshot.data, windows)
        voice_record = {
            "engine": "Microsoft System.Speech",
            "name": voice_info["name"],
            "culture": voice_info["culture"],
            "gender": str(voice_info.get("gender") or "Unspecified"),
            "age": str(voice_info.get("age") or "NotSet"),
            "rate": rate,
            "volume": 100,
            "explicitlySelected": True,
        }
        manifest_payload = _base_manifest(
            generator=SYSTEM_SPEECH_GENERATOR_ID,
            fixture_only=False,
            timeline=timeline,
            windows=windows,
            voice=voice_record,
            segments=segments,
            audio_snapshot=audio_snapshot,
            measured=measured,
            logical_audio_path=audio_path,
            logical_manifest_path=manifest_path,
            generation_evidence=_production_generation_evidence(
                executable=executable,
                voice=voice_record,
                rate=rate,
                windows=windows,
            ),
        )
        staged_manifest = scratch / "narration.candidate.manifest.json"
        _atomic_manifest(staged_manifest, manifest_payload, scratch)
        validate_narration_bundle(
            staged_audio,
            staged_manifest,
            production_mode=True,
            expected_generator=SYSTEM_SPEECH_GENERATOR_ID,
            expected_audio_path=audio_path,
            expected_manifest_path=manifest_path,
        )
        return _promote_narration_pair(
            staged_audio=staged_audio,
            staged_manifest=staged_manifest,
            audio_path=audio_path,
            manifest_path=manifest_path,
            scratch=scratch,
            replace_existing=replace_existing,
            validate_promoted=lambda: validate_narration_bundle(
                audio_path,
                manifest_path,
                production_mode=True,
                expected_generator=SYSTEM_SPEECH_GENERATOR_ID,
            ),
        )
    except NarrationRecoveryRequired:
        retain_scratch_for_recovery = True
        raise
    finally:
        if not retain_scratch_for_recovery:
            shutil.rmtree(scratch, ignore_errors=True)


def create_synthetic_fixture(
    audio_path: Path,
    manifest_path: Path,
    *,
    windows: Sequence[tuple[int, int, str]],
    replace_existing: bool = False,
) -> NarrationBundle:
    """Create a cross-platform non-silent fixture without System.Speech."""

    timeline, _canonical = load_caption_timeline()
    total_frames = windows[-1][1] * SAMPLE_RATE
    stereo = array("h", [0]) * total_frames * CHANNELS
    segments: list[dict[str, Any]] = []
    for number, (start, end, text) in enumerate(windows, start=1):
        source_frames = min(SAMPLE_RATE // 3, (end - start) * SAMPLE_RATE - 2 * SPEECH_MARGIN_FRAMES)
        require(source_frames > 0, "synthetic narration beat is too short")
        placed_start = start * SAMPLE_RATE + SPEECH_MARGIN_FRAMES
        frequency = 360 + number * 28
        peak = 0
        for offset in range(source_frames):
            sample = int(6_000 * math.sin(2 * math.pi * frequency * offset / SAMPLE_RATE))
            peak = max(peak, abs(sample))
            frame = placed_start + offset
            stereo[frame * 2] = sample
            stereo[frame * 2 + 1] = sample
        pcm_binding = _segment_pcm_binding(stereo, placed_start, placed_start + source_frames)
        segments.append(
            {
                "beatNumber": number,
                "startSeconds": start,
                "endSeconds": end,
                "textSha256": sha256_bytes(text.encode("utf-8")),
                "sourceFrames": source_frames,
                "sourceDurationSeconds": source_frames / SAMPLE_RATE,
                "placedStartFrame": placed_start,
                "placedEndFrame": placed_start + source_frames,
                "truncated": False,
                "peakS16": peak,
                **pcm_binding,
            }
        )
    require(audio_path.parent == manifest_path.parent, "synthetic narration WAV and manifest must share one directory")
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="memoryagent-narration-fixture-", dir=audio_path.parent))
    retain_scratch_for_recovery = False
    try:
        staged_audio = scratch / "fixture.candidate.wav"
        staged_manifest = scratch / "fixture.candidate.manifest.json"
        _write_wave(staged_audio, stereo, total_frames)
        audio_snapshot = read_project_file_once(staged_audio, "staged synthetic local narration WAV")
        measured = inspect_audio(audio_snapshot.data, windows)
        payload = _base_manifest(
            generator=FIXTURE_GENERATOR_ID,
            fixture_only=True,
            timeline=timeline,
            windows=windows,
            voice={
                "engine": "Python stdlib synthetic test fixture",
                "name": "Synthetic sine fixture",
                "culture": "en-US",
                "gender": "Neutral",
                "age": "NotSet",
                "rate": 0,
                "volume": 100,
                "explicitlySelected": True,
            },
            segments=segments,
            audio_snapshot=audio_snapshot,
            measured=measured,
            logical_audio_path=audio_path,
            logical_manifest_path=manifest_path,
            generation_evidence=_fixture_generation_evidence(windows=windows),
        )
        _atomic_manifest(staged_manifest, payload, scratch)
        validate_narration_bundle(
            staged_audio,
            staged_manifest,
            windows=windows,
            production_mode=False,
            expected_audio_path=audio_path,
            expected_manifest_path=manifest_path,
        )
        return _promote_narration_pair(
            staged_audio=staged_audio,
            staged_manifest=staged_manifest,
            audio_path=audio_path,
            manifest_path=manifest_path,
            scratch=scratch,
            replace_existing=replace_existing,
            validate_promoted=lambda: validate_narration_bundle(
                audio_path,
                manifest_path,
                windows=windows,
                production_mode=False,
            ),
        )
    except NarrationRecoveryRequired:
        retain_scratch_for_recovery = True
        raise
    finally:
        if not retain_scratch_for_recovery:
            shutil.rmtree(scratch, ignore_errors=True)


def safe_reset_selftest_root() -> Path:
    """Remove only the exact lexical self-test directory, never a reparse target."""

    root = Path(os.path.abspath(REPO / ".artifacts" / "local-narration-selftest"))
    expected = (".artifacts", "local-narration-selftest")
    try:
        relative = root.relative_to(REPO.resolve(strict=True))
    except (OSError, RuntimeError, ValueError) as exc:
        raise NarrationError("local narration self-test root escaped the repository") from exc
    require(relative.parts == expected, "local narration self-test cleanup target is not canonical")

    current = REPO.resolve(strict=True)
    for part in relative.parts:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            break
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        file_attributes = getattr(metadata, "st_file_attributes", 0)
        require(
            not stat.S_ISLNK(metadata.st_mode)
            and not bool(reparse_flag and file_attributes & reparse_flag),
            "local narration self-test path must not traverse a symlink or reparse point",
        )
    try:
        metadata = root.lstat()
    except FileNotFoundError:
        return root
    require(stat.S_ISDIR(metadata.st_mode), "local narration self-test root is not a directory")
    shutil.rmtree(root)
    return root


def self_test() -> int:
    root = safe_reset_selftest_root()
    _timeline, canonical = load_caption_timeline()
    fixture_windows = tuple((index - 1, index, text) for index, (_start, _end, text) in enumerate(canonical, start=1))
    bundle = create_synthetic_fixture(
        root / "SYNTHETIC-NOT-SUBMISSION-NARRATION.wav",
        root / "SYNTHETIC-NOT-SUBMISSION-NARRATION.manifest.json",
        windows=fixture_windows,
    )
    require(bundle.measured_audio["nonSilentBeatCount"] == 10, "synthetic narration self-test missed a beat")
    rejected = False
    try:
        validate_narration_bundle(bundle.audio.path, bundle.manifest.path, production_mode=True)
    except NarrationError:
        rejected = True
    require(rejected, "production narration gate accepted a synthetic fixture")
    print("local narration self-test: PASS | 10 non-silent beats | no System.Speech or network invoked")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--self-test", action="store_true", help="run the cross-platform synthetic fixture validator")
    action.add_argument("--list-voices", action="store_true", help="list enabled installed en-US Windows System.Speech voices")
    parser.add_argument(
        "--voice",
        help=f"required production voice; must be exactly {CANONICAL_PRODUCTION_VOICE_NAME!r}",
    )
    parser.add_argument(
        "--rate",
        type=int,
        default=CANONICAL_PRODUCTION_RATE,
        help=f"canonical System.Speech rate (must be exactly {CANONICAL_PRODUCTION_RATE})",
    )
    parser.add_argument("--audio", default=DEFAULT_AUDIO_REL, help="project-contained narration WAV output")
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST_REL, help="project-contained narration JSON manifest output")
    parser.add_argument("--replace", action="store_true", help="replace an existing canonical narration pair intentionally")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            return self_test()
        if args.list_voices:
            return list_voices()
        require(args.voice is not None, "--voice is required; run --list-voices and select one exact en-US voice")
        audio_path = project_path(args.audio, "local narration WAV output")
        manifest_path = project_path(args.manifest, "local narration manifest output")
        bundle = build_production_bundle(
            voice_name=str(args.voice),
            rate=int(args.rate),
            audio_path=audio_path,
            manifest_path=manifest_path,
            replace_existing=bool(args.replace),
        )
        print(
            "local narration build: PASS | 172.000s | 48 kHz stereo PCM | "
            f"voice {bundle.payload['voice']['name']} | no music or network"
        )
        return 0
    except (NarrationError, OSError, UnicodeError) as exc:
        print(f"local narration build: FAIL | {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
