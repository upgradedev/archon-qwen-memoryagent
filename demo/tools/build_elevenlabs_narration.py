#!/usr/bin/env python3
"""Generate the canonical MemoryAgent narration with one bounded ElevenLabs run.

The API key is accepted only through ``ELEVEN_LABS_KEY`` and is used only in the
``xi-api-key`` request header.  The five exact successful items from failed run
29731821217 are recovered before five new caption-bound requests are made exactly
once. There is no per-beat retry, alternate voice, or fallback service. Provider PCM
is decoded, duration-fitted without truncation when necessary, resampled to the
existing 48 kHz stereo timeline, and promoted only after the shared validator passes.
"""

from __future__ import annotations

import argparse
from array import array
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from typing import Callable, Sequence
import urllib.error
import urllib.parse
import urllib.request


REPO_HINT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_HINT / "demo" / "tools"))
import build_local_narration as core  # noqa: E402


PROVIDER_SAMPLE_RATE = 24_000
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_HISTORY_JSON_BYTES = 2 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 120
API_URL = (
    "https://api.elevenlabs.io/v1/text-to-speech/"
    f"{core.CANONICAL_ELEVENLABS_VOICE_ID}"
    f"?output_format={core.CANONICAL_ELEVENLABS_OUTPUT_FORMAT}"
)


AudioRequester = Callable[[dict[str, object]], bytes]
RecoveredAudio = tuple[bytes, str]
HistoryRecoverer = Callable[[Sequence[tuple[int, int, str]]], dict[int, RecoveredAudio]]


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


def _history_list_url() -> str:
    query = urllib.parse.urlencode(
        {
            "page_size": 100,
            "voice_id": core.CANONICAL_ELEVENLABS_VOICE_ID,
            "model_id": core.CANONICAL_ELEVENLABS_MODEL_ID,
            "source": "TTS",
            "date_after_unix": core.CANONICAL_ELEVENLABS_RECOVERY_AFTER_UNIX,
            "date_before_unix": core.CANONICAL_ELEVENLABS_RECOVERY_BEFORE_UNIX,
            "sort_direction": "asc",
        }
    )
    return f"https://api.elevenlabs.io/v1/history?{query}"


def _request_history_json() -> dict[str, object]:
    request = urllib.request.Request(
        _history_list_url(),
        method="GET",
        headers={"Accept": "application/json", "xi-api-key": _api_key()},
    )
    try:
        with _open_no_redirect(request, REQUEST_TIMEOUT_SECONDS) as response:
            status = int(getattr(response, "status", response.getcode()))
            core.require(status == 200, "ElevenLabs history returned a non-success status")
            content_type = str(response.headers.get("Content-Type") or "").lower()
            core.require(content_type.split(";", 1)[0].strip() == "application/json", "ElevenLabs history returned an unexpected content type")
            content = response.read(MAX_HISTORY_JSON_BYTES + 1)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
        raise core.NarrationError("ElevenLabs history recovery failed before live synthesis") from exc
    core.require(0 < len(content) <= MAX_HISTORY_JSON_BYTES, "ElevenLabs history response size is invalid")
    try:
        payload = json.loads(content.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise core.NarrationError("ElevenLabs history response is invalid") from exc
    core.require(isinstance(payload, dict), "ElevenLabs history response is not an object")
    return payload


def _history_settings_match(settings: object) -> bool:
    if not isinstance(settings, dict):
        return False
    expected = core.elevenlabs_request_contract(core.load_caption_timeline()[1])["voiceSettings"]
    return all(settings.get(key) == value for key, value in expected.items())


def _select_recovery_items(
    payload: dict[str, object],
    windows: Sequence[tuple[int, int, str]],
) -> dict[int, str]:
    history = payload.get("history")
    core.require(isinstance(history, list), "ElevenLabs history inventory is absent")
    selected: dict[int, str] = {}
    for number in core.CANONICAL_ELEVENLABS_RECOVERED_BEATS:
        text = windows[number - 1][2]
        matches = []
        for item in history:
            if not isinstance(item, dict):
                continue
            created = item.get("date_unix")
            if not (
                item.get("text") == text
                and item.get("voice_id") == core.CANONICAL_ELEVENLABS_VOICE_ID
                and item.get("model_id") == core.CANONICAL_ELEVENLABS_MODEL_ID
                and item.get("source") == "TTS"
                and item.get("output_format") == core.CANONICAL_ELEVENLABS_OUTPUT_FORMAT
                and str(item.get("content_type") or "").split(";", 1)[0].strip().lower()
                in {"audio/pcm", "audio/x-pcm", "application/octet-stream"}
                and type(created) is int
                and core.CANONICAL_ELEVENLABS_RECOVERY_AFTER_UNIX <= created < core.CANONICAL_ELEVENLABS_RECOVERY_BEFORE_UNIX
                and _history_settings_match(item.get("settings"))
            ):
                continue
            item_id = item.get("history_item_id")
            if isinstance(item_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{10,128}", item_id):
                matches.append(item_id)
        core.require(len(matches) == 1, f"ElevenLabs history beat {number} is absent or ambiguous")
        selected[number] = matches[0]
    return selected


def _request_history_audio(history_item_id: str) -> bytes:
    core.require(bool(re.fullmatch(r"[A-Za-z0-9_-]{10,128}", history_item_id)), "ElevenLabs history item id is invalid")
    request = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/history/{history_item_id}/audio",
        method="GET",
        headers={"Accept": "audio/pcm", "xi-api-key": _api_key()},
    )
    try:
        with _open_no_redirect(request, REQUEST_TIMEOUT_SECONDS) as response:
            status = int(getattr(response, "status", response.getcode()))
            core.require(status == 200, "ElevenLabs history audio returned a non-success status")
            content_type = str(response.headers.get("Content-Type") or "").lower()
            core.require(
                content_type.split(";", 1)[0].strip() in {"audio/pcm", "audio/x-pcm", "application/octet-stream"},
                "ElevenLabs history audio returned an unexpected content type",
            )
            content = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
        raise core.NarrationError("ElevenLabs history audio recovery failed before live synthesis") from exc
    core.require(0 < len(content) <= MAX_RESPONSE_BYTES and len(content) % core.SAMPLE_WIDTH == 0, "ElevenLabs history PCM size is invalid")
    return content


def _recover_history_audio(windows: Sequence[tuple[int, int, str]]) -> dict[int, RecoveredAudio]:
    selected = _select_recovery_items(_request_history_json(), windows)
    recovered: dict[int, RecoveredAudio] = {}
    for number in core.CANONICAL_ELEVENLABS_RECOVERED_BEATS:
        item_id = selected[number]
        recovered[number] = (_request_history_audio(item_id), core.sha256_bytes(item_id.encode("ascii")))
    return recovered


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


def _truncating_divide(numerator: int, denominator: int) -> int:
    core.require(denominator > 0, "time-fit denominator is invalid")
    return numerator // denominator if numerator >= 0 else -((-numerator) // denominator)


def _fit_pcm_to_window(source: array, maximum_frames: int) -> tuple[array, float, bool]:
    core.require(maximum_frames >= int(core.MIN_PRODUCTION_SEGMENT_SECONDS * core.SAMPLE_RATE), "time-fit window is too short")
    if len(source) <= maximum_frames:
        return array("h", source), 1.0, False
    ratio = len(source) / maximum_frames
    core.require(ratio <= core.MAX_ELEVENLABS_TIME_FIT_RATIO, "ElevenLabs segment exceeds the maximum deterministic time-fit ratio")
    denominator = maximum_frames - 1
    source_span = len(source) - 1
    fitted = array("h")
    for target_index in range(maximum_frames):
        position_numerator = target_index * source_span
        lower = position_numerator // denominator
        remainder = position_numerator % denominator
        upper = min(lower + 1, len(source) - 1)
        weighted = int(source[lower]) * (denominator - remainder) + int(source[upper]) * remainder
        fitted.append(_truncating_divide(weighted, denominator))
    stats = core._signal_stats(fitted)
    core.require(int(stats["clippedSamples"]) == 0 and int(stats["peakS16"]) >= core.MIN_PEAK_S16, "time-fitted ElevenLabs segment is invalid")
    return fitted, ratio, True


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
    recover_history: HistoryRecoverer = _recover_history_audio,
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
        # Complete all read-only recovery before any new credit-consuming request.
        recovered = recover_history(windows)
        core.require(
            set(recovered) == set(core.CANONICAL_ELEVENLABS_RECOVERED_BEATS),
            "ElevenLabs history recovery inventory is incomplete",
        )
        for number, (start, end, text) in enumerate(windows, start=1):
            if number in core.CANONICAL_ELEVENLABS_RECOVERED_BEATS:
                content, history_hash = recovered[number]
                acquisition = "history-recovery"
            else:
                # Deliberately one call: request_audio has no retry loop and exceptions abort the run.
                content = request_audio(_request_payload(windows, number))
                history_hash = None
                acquisition = "live-synthesis"
            provider_mono, _provider_stats = _decode_and_resample_pcm(content)
            capacity = (end - start) * core.SAMPLE_RATE
            maximum_frames = capacity - 2 * core.SPEECH_MARGIN_FRAMES
            mono, fit_ratio, fit_applied = _fit_pcm_to_window(provider_mono, maximum_frames)
            stats = core._signal_stats(mono)
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
                    "acquisition": acquisition,
                    "providerFrames": len(provider_mono),
                    "providerDurationSeconds": len(provider_mono) / core.SAMPLE_RATE,
                    "providerPcmSha256": core.sha256_bytes(core._little_endian_pcm(provider_mono)),
                    "providerPcmBytes": len(provider_mono) * core.SAMPLE_WIDTH,
                    "timeFitApplied": fit_applied,
                    "timeFitRatio": fit_ratio,
                    "historyItemIdSha256": history_hash,
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
        windows = core.load_caption_timeline()[1]
        live_characters = sum(len(windows[number - 1][2]) for number in core.CANONICAL_ELEVENLABS_LIVE_BEATS)
        print(
            "ElevenLabs narration build: PASS | 172.000s | 48 kHz stereo PCM | "
            f"5 history-recovered beats | {live_characters} live characters | "
            "5 live requests | deterministic time-fit | no retry or fallback | "
            f"audio {bundle.audio.sha256[:12]}"
        )
        return 0
    except (core.NarrationError, OSError, UnicodeError) as exc:
        print(f"ElevenLabs narration build: FAIL | {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
