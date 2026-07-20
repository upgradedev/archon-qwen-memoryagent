#!/usr/bin/env python3
"""Generate the canonical MemoryAgent narration with one bounded ElevenLabs run.

The API key is accepted only through ``ELEVEN_LABS_KEY`` and is used only in the
``xi-api-key`` request header.  Ten caption-bound requests are made exactly once:
there is no retry, regeneration, alternate voice, or fallback service.  Provider
PCM is decoded, resampled deterministically to the existing 48 kHz stereo timeline,
and promoted only after the shared narration validator passes.
"""

from __future__ import annotations

import argparse
from array import array
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Callable, Sequence
import urllib.error
import urllib.request


REPO_HINT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_HINT / "demo" / "tools"))
import build_local_narration as core  # noqa: E402


PROVIDER_SAMPLE_RATE = 24_000
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 120
API_URL = (
    "https://api.elevenlabs.io/v1/text-to-speech/"
    f"{core.CANONICAL_ELEVENLABS_VOICE_ID}"
    f"?output_format={core.CANONICAL_ELEVENLABS_OUTPUT_FORMAT}"
)


AudioRequester = Callable[[dict[str, object]], bytes]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, "redirect rejected", headers, fp)


def _open_no_redirect(request: urllib.request.Request, timeout: int):
    return urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout)


def require_exact_configuration(voice_id: str, model_id: str, rights_approved: bool) -> None:
    core.require(
        voice_id == core.CANONICAL_ELEVENLABS_VOICE_ID,
        "canonical ElevenLabs voice id is not exact",
    )
    core.require(
        model_id == core.CANONICAL_ELEVENLABS_MODEL_ID,
        "canonical ElevenLabs model id is not exact",
    )
    core.require(rights_approved, "commercial/publication rights approval is required")


def _api_key() -> str:
    key = os.environ.get("ELEVEN_LABS_KEY", "")
    core.require(len(key) >= 20 and not key.isspace(), "ELEVEN_LABS_KEY is missing or invalid")
    core.require("\r" not in key and "\n" not in key, "ELEVEN_LABS_KEY contains invalid characters")
    return key


def _request_audio(payload: dict[str, object]) -> bytes:
    key = _api_key()
    body = core.canonical_json_bytes(payload)
    request = urllib.request.Request(
        API_URL,
        data=body,
        method="POST",
        headers={
            "Accept": "audio/pcm",
            "Content-Type": "application/json",
            "xi-api-key": key,
        },
    )
    try:
        with _open_no_redirect(request, REQUEST_TIMEOUT_SECONDS) as response:
            status = int(getattr(response, "status", response.getcode()))
            core.require(status == 200, "ElevenLabs returned a non-success status")
            content_type = str(response.headers.get("Content-Type") or "").lower()
            core.require(
                content_type.split(";", 1)[0].strip()
                in {"audio/pcm", "audio/x-pcm", "application/octet-stream"},
                "ElevenLabs returned an unexpected content type",
            )
            content = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
        raise core.NarrationError(
            "ElevenLabs synthesis failed; no retry, fallback, or narration promotion was attempted"
        ) from exc
    core.require(0 < len(content) <= MAX_RESPONSE_BYTES, "ElevenLabs audio response size is invalid")
    core.require(len(content) % core.SAMPLE_WIDTH == 0, "ElevenLabs PCM response has an odd byte count")
    return content


def _decode_and_resample_pcm(content: bytes) -> tuple[array, dict[str, int | float]]:
    source = array("h")
    source.frombytes(content)
    if sys.byteorder != "little":
        source.byteswap()
    core.require(len(source) >= PROVIDER_SAMPLE_RATE, "ElevenLabs PCM segment is shorter than one second")
    source_stats = core._signal_stats(source)
    core.require(int(source_stats["peakS16"]) >= core.MIN_PEAK_S16, "ElevenLabs produced a silent segment")
    core.require(int(source_stats["clippedSamples"]) == 0, "ElevenLabs produced a clipped segment")

    # Exact 2x linear interpolation: deterministic 24 kHz S16LE mono -> 48 kHz.
    target = array("h")
    for index, sample in enumerate(source):
        following = source[index + 1] if index + 1 < len(source) else sample
        target.append(sample)
        target.append(int((int(sample) + int(following)) / 2))
    stats = core._signal_stats(target)
    core.require(int(stats["clippedSamples"]) == 0, "resampled ElevenLabs segment is clipped")
    return target, stats


def _request_payload(
    windows: Sequence[tuple[int, int, str]],
    number: int,
) -> dict[str, object]:
    _start, _end, text = windows[number - 1]
    contract = core.elevenlabs_request_contract(windows)
    segment = contract["segments"][number - 1]
    payload: dict[str, object] = {
        "text": text,
        "model_id": core.CANONICAL_ELEVENLABS_MODEL_ID,
        "seed": segment["seed"],
        "voice_settings": contract["voiceSettings"],
    }
    if number > 1:
        payload["previous_text"] = windows[number - 2][2]
    if number < len(windows):
        payload["next_text"] = windows[number][2]
    return payload


def build_production_bundle(
    *,
    audio_path: Path,
    manifest_path: Path,
    replace_existing: bool,
    rights_approved: bool,
    request_audio: AudioRequester = _request_audio,
) -> core.NarrationBundle:
    require_exact_configuration(
        core.CANONICAL_ELEVENLABS_VOICE_ID,
        core.CANONICAL_ELEVENLABS_MODEL_ID,
        rights_approved,
    )
    core.require(audio_path.suffix.lower() == ".wav", "narration audio output must end in .wav")
    core.require(manifest_path.suffix.lower() == ".json", "narration manifest output must end in .json")
    core.require(audio_path != manifest_path, "narration audio and manifest paths must differ")
    if not replace_existing:
        core.require(not audio_path.exists() and not manifest_path.exists(), "narration output already exists; pass --replace intentionally")
    timeline, windows = core.load_caption_timeline()
    core.require(audio_path.parent == manifest_path.parent, "narration WAV and manifest must share one directory")
    core.require(core.relative_repo_path(audio_path) == core.DEFAULT_AUDIO_REL, "narration WAV path is not canonical")
    core.require(core.relative_repo_path(manifest_path) == core.DEFAULT_MANIFEST_REL, "narration manifest path is not canonical")
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="memoryagent-elevenlabs-narration-", dir=audio_path.parent))
    retain_scratch_for_recovery = False
    try:
        stereo = array("h", [0]) * core.EXPECTED_SAMPLE_FRAMES * core.CHANNELS
        segments: list[dict[str, object]] = []
        for number, (start, end, text) in enumerate(windows, start=1):
            # Deliberately one call: request_audio has no retry loop and exceptions abort the run.
            mono, stats = _decode_and_resample_pcm(request_audio(_request_payload(windows, number)))
            capacity = (end - start) * core.SAMPLE_RATE
            core.require(
                len(mono) + 2 * core.SPEECH_MARGIN_FRAMES <= capacity,
                f"ElevenLabs narration beat {number} does not fit its canonical window",
            )
            placed_start = start * core.SAMPLE_RATE + core.SPEECH_MARGIN_FRAMES
            placed_end = placed_start + len(mono)
            core.require(placed_end <= end * core.SAMPLE_RATE - core.SPEECH_MARGIN_FRAMES, f"ElevenLabs narration beat {number} would be truncated")
            for offset, sample in enumerate(mono):
                frame = placed_start + offset
                stereo[frame * 2] = sample
                stereo[frame * 2 + 1] = sample
            segments.append(
                {
                    "beatNumber": number,
                    "startSeconds": start,
                    "endSeconds": end,
                    "textSha256": core.sha256_bytes(text.encode("utf-8")),
                    "sourceFrames": len(mono),
                    "sourceDurationSeconds": len(mono) / core.SAMPLE_RATE,
                    "placedStartFrame": placed_start,
                    "placedEndFrame": placed_end,
                    "truncated": False,
                    "peakS16": stats["peakS16"],
                    "sourcePcmSha256": core.sha256_bytes(core._little_endian_pcm(mono)),
                    "sourcePcmBytes": len(mono) * core.SAMPLE_WIDTH,
                }
            )

        staged_audio = scratch / "narration.candidate.wav"
        core._write_wave(staged_audio, stereo, core.EXPECTED_SAMPLE_FRAMES)
        audio_snapshot = core.read_project_file_once(staged_audio, "staged ElevenLabs narration WAV")
        measured = core.inspect_audio(audio_snapshot.data, windows)
        voice_record = {
            "engine": "ElevenLabs API",
            "name": core.CANONICAL_ELEVENLABS_VOICE_NAME,
            "culture": "en-US",
            "gender": "Unspecified",
            "age": "NotSet",
            "rate": 0,
            "volume": 100,
            "explicitlySelected": True,
        }
        manifest_payload = core._base_manifest(
            generator=core.GENERATOR_ID,
            fixture_only=False,
            timeline=timeline,
            windows=windows,
            voice=voice_record,
            segments=segments,
            audio_snapshot=audio_snapshot,
            measured=measured,
            logical_audio_path=audio_path,
            logical_manifest_path=manifest_path,
            generation_evidence=core.elevenlabs_generation_evidence(windows=windows, segments=segments),
            rights=core._elevenlabs_rights(),
        )
        staged_manifest = scratch / "narration.candidate.manifest.json"
        core._atomic_manifest(staged_manifest, manifest_payload, scratch)
        core.validate_narration_bundle(
            staged_audio,
            staged_manifest,
            production_mode=True,
            expected_audio_path=audio_path,
            expected_manifest_path=manifest_path,
        )
        return core._promote_narration_pair(
            staged_audio=staged_audio,
            staged_manifest=staged_manifest,
            audio_path=audio_path,
            manifest_path=manifest_path,
            scratch=scratch,
            replace_existing=replace_existing,
            validate_promoted=lambda: core.validate_narration_bundle(audio_path, manifest_path, production_mode=True),
        )
    except core.NarrationRecoveryRequired:
        retain_scratch_for_recovery = True
        raise
    finally:
        if not retain_scratch_for_recovery:
            shutil.rmtree(scratch, ignore_errors=True)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice-id", default=core.CANONICAL_ELEVENLABS_VOICE_ID)
    parser.add_argument("--model-id", default=core.CANONICAL_ELEVENLABS_MODEL_ID)
    parser.add_argument("--commercial-rights-approved", action="store_true")
    parser.add_argument("--audio", default=core.DEFAULT_AUDIO_REL)
    parser.add_argument("--manifest", default=core.DEFAULT_MANIFEST_REL)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        require_exact_configuration(args.voice_id, args.model_id, bool(args.commercial_rights_approved))
        bundle = build_production_bundle(
            audio_path=core.project_path(args.audio, "ElevenLabs narration WAV output"),
            manifest_path=core.project_path(args.manifest, "ElevenLabs narration manifest output"),
            replace_existing=bool(args.replace),
            rights_approved=True,
        )
        characters = sum(len(text) for _start, _end, text in core.load_caption_timeline()[1])
        print(
            "ElevenLabs narration build: PASS | 172.000s | 48 kHz stereo PCM | "
            f"{characters} characters | 10 requests | no retry or fallback | "
            f"audio {bundle.audio.sha256[:12]}"
        )
        return 0
    except (core.NarrationError, OSError, UnicodeError) as exc:
        print(f"ElevenLabs narration build: FAIL | {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
