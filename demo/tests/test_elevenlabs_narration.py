from __future__ import annotations

from array import array
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "demo" / "tools"
sys.path.insert(0, str(TOOLS))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


eleven = load_module("memoryagent_elevenlabs_narration_tests", TOOLS / "build_elevenlabs_narration.py")
core = eleven.core


class FakeResponse:
    def __init__(self, content: bytes, content_type: str = "audio/pcm") -> None:
        self.status = 200
        self.headers = {"Content-Type": content_type}
        self._content = content

    def getcode(self) -> int:
        return self.status

    def read(self, limit: int) -> bytes:
        return self._content[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


class ElevenLabsNarrationTests(unittest.TestCase):
    def test_canonical_configuration_and_rights_are_exact(self) -> None:
        eleven.require_exact_configuration(
            core.CANONICAL_ELEVENLABS_VOICE_ID,
            core.CANONICAL_ELEVENLABS_MODEL_ID,
            True,
        )
        for voice, model, approved in (
            ("wrong", core.CANONICAL_ELEVENLABS_MODEL_ID, True),
            (core.CANONICAL_ELEVENLABS_VOICE_ID, "wrong", True),
            (core.CANONICAL_ELEVENLABS_VOICE_ID, core.CANONICAL_ELEVENLABS_MODEL_ID, False),
        ):
            with self.assertRaises(core.NarrationError):
                eleven.require_exact_configuration(voice, model, approved)
        rights = core._elevenlabs_rights()
        self.assertTrue(rights["networkUsed"])
        self.assertTrue(rights["thirdPartyAudio"])
        self.assertTrue(rights["commercialUseRightsApproved"])
        self.assertFalse(rights["generatedLocally"])
        self.assertFalse(rights["musicUsed"])

    def test_request_contract_is_ten_beats_no_retry_no_fallback(self) -> None:
        _timeline, windows = core.load_caption_timeline()
        contract = core.elevenlabs_request_contract(windows)
        self.assertEqual(contract["requestCount"], 10)
        self.assertEqual(contract["retryCount"], 0)
        self.assertIsNone(contract["fallback"])
        self.assertEqual(contract["executionPlan"]["historyRecoveredBeats"], [1, 2, 3, 4, 5])
        self.assertEqual(contract["executionPlan"]["liveSynthesisBeats"], [6, 7, 8, 9, 10])
        self.assertEqual(contract["executionPlan"]["liveRequestCount"], 5)
        self.assertFalse(contract["timingPolicy"]["truncationAllowed"])
        self.assertEqual(contract["timingPolicy"]["maxCompressionRatio"], 1.35)
        self.assertEqual(contract["voiceId"], "pNInz6obpgDQGcFmaJgB")
        self.assertEqual(contract["modelId"], "eleven_multilingual_v2")
        self.assertEqual(sum(row["characters"] for row in contract["segments"]), 2004)
        first = eleven._request_payload(windows, 1)
        middle = eleven._request_payload(windows, 5)
        last = eleven._request_payload(windows, 10)
        self.assertNotIn("previous_text", first)
        self.assertIn("next_text", first)
        self.assertIn("previous_text", middle)
        self.assertIn("next_text", middle)
        self.assertIn("previous_text", last)
        self.assertNotIn("next_text", last)

    def test_api_key_is_header_only_and_one_urlopen_call(self) -> None:
        pcm = array("h", [1000, -1000] * eleven.PROVIDER_SAMPLE_RATE).tobytes()
        captured = []

        def fake_urlopen(request, timeout):
            captured.append((request, timeout))
            return FakeResponse(pcm)

        secret = "sk_" + "x" * 40
        with mock.patch.dict(os.environ, {"ELEVEN_LABS_KEY": secret}, clear=False):
            with mock.patch.object(eleven, "_open_no_redirect", side_effect=fake_urlopen):
                result = eleven._request_audio({"text": "safe", "model_id": "eleven_multilingual_v2"})
        self.assertEqual(result, pcm)
        self.assertEqual(len(captured), 1)
        request, timeout = captured[0]
        self.assertEqual(timeout, eleven.REQUEST_TIMEOUT_SECONDS)
        self.assertEqual(request.get_header("Xi-api-key"), secret)
        self.assertNotIn(secret.encode(), request.data)

    def test_api_failure_is_secret_safe_and_has_no_retry(self) -> None:
        calls = []

        def fail_once(*_args, **_kwargs):
            calls.append(1)
            raise eleven.urllib.error.URLError("provider detail must stay hidden")

        secret = "sk_" + "y" * 40
        with mock.patch.dict(os.environ, {"ELEVEN_LABS_KEY": secret}, clear=False):
            with mock.patch.object(eleven, "_open_no_redirect", side_effect=fail_once):
                with self.assertRaises(core.NarrationError) as caught:
                    eleven._request_audio({"text": "safe"})
        self.assertEqual(len(calls), 1)
        self.assertNotIn(secret, str(caught.exception))
        self.assertNotIn("provider detail", str(caught.exception))

    def test_pcm_resample_is_exact_2x_and_nonclipping(self) -> None:
        source = array("h", [2500, -2500] * eleven.PROVIDER_SAMPLE_RATE)
        target, stats = eleven._decode_and_resample_pcm(source.tobytes())
        self.assertEqual(len(target), len(source) * 2)
        self.assertEqual(target[0], source[0])
        self.assertEqual(target[1], 0)
        self.assertEqual(stats["clippedSamples"], 0)

    def test_time_fit_is_deterministic_bounded_and_never_truncates(self) -> None:
        maximum = core.SAMPLE_RATE * 2
        source = array("h", [2500, -2500] * (maximum * 11 // 20))
        first, ratio, applied = eleven._fit_pcm_to_window(source, maximum)
        second, second_ratio, second_applied = eleven._fit_pcm_to_window(source, maximum)
        self.assertTrue(applied)
        self.assertTrue(second_applied)
        self.assertEqual(len(first), maximum)
        self.assertEqual(first, second)
        self.assertEqual(ratio, second_ratio)
        self.assertLessEqual(ratio, core.MAX_ELEVENLABS_TIME_FIT_RATIO)
        too_long = array("h", [2500, -2500] * maximum)
        with self.assertRaisesRegex(core.NarrationError, "maximum deterministic time-fit ratio"):
            eleven._fit_pcm_to_window(too_long, maximum)

    def _history_payload(self):
        _timeline, windows = core.load_caption_timeline()
        settings = core.elevenlabs_request_contract(windows)["voiceSettings"]
        return {
            "history": [
                {
                    "history_item_id": f"history_item_{number:02d}",
                    "date_unix": core.CANONICAL_ELEVENLABS_RECOVERY_AFTER_UNIX + number,
                    "voice_id": core.CANONICAL_ELEVENLABS_VOICE_ID,
                    "model_id": core.CANONICAL_ELEVENLABS_MODEL_ID,
                    "source": "TTS",
                    "output_format": core.CANONICAL_ELEVENLABS_OUTPUT_FORMAT,
                    "content_type": "audio/pcm",
                    "text": windows[number - 1][2],
                    "settings": dict(settings),
                }
                for number in core.CANONICAL_ELEVENLABS_RECOVERED_BEATS
            ]
        }

    def test_history_recovery_matches_exact_failed_run_inventory(self) -> None:
        _timeline, windows = core.load_caption_timeline()
        selected = eleven._select_recovery_items(self._history_payload(), windows)
        self.assertEqual(set(selected), {1, 2, 3, 4, 5})
        tampered = self._history_payload()
        tampered["history"][0]["text"] = "wrong"
        with self.assertRaisesRegex(core.NarrationError, "beat 1 is absent or ambiguous"):
            eleven._select_recovery_items(tampered, windows)
        ambiguous = self._history_payload()
        ambiguous["history"].append(dict(ambiguous["history"][0], history_item_id="history_item_duplicate"))
        with self.assertRaisesRegex(core.NarrationError, "beat 1 is absent or ambiguous"):
            eleven._select_recovery_items(ambiguous, windows)

    def test_history_query_is_secret_safe_exact_and_read_only(self) -> None:
        captured = []
        response = FakeResponse(json.dumps(self._history_payload()).encode(), "application/json")

        def fake_open(request, timeout):
            captured.append((request, timeout))
            return response

        secret = "sk_" + "z" * 40
        with mock.patch.dict(os.environ, {"ELEVEN_LABS_KEY": secret}, clear=False):
            with mock.patch.object(eleven, "_open_no_redirect", side_effect=fake_open):
                payload = eleven._request_history_json()
        self.assertIn("history", payload)
        self.assertEqual(len(captured), 1)
        request, _timeout = captured[0]
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.get_header("Xi-api-key"), secret)
        self.assertNotIn(secret, request.full_url)
        self.assertIn("date_after_unix=1784539947", request.full_url)
        self.assertIn("date_before_unix=1784539964", request.full_url)

    def test_history_audio_is_secret_safe_and_pcm_only(self) -> None:
        pcm = array("h", [2500, -2500] * eleven.PROVIDER_SAMPLE_RATE).tobytes()
        captured = []

        def fake_open(request, timeout):
            captured.append((request, timeout))
            return FakeResponse(pcm)

        secret = "sk_" + "h" * 40
        with mock.patch.dict(os.environ, {"ELEVEN_LABS_KEY": secret}, clear=False):
            with mock.patch.object(eleven, "_open_no_redirect", side_effect=fake_open):
                result = eleven._request_history_audio("history_item_01")
        self.assertEqual(result, pcm)
        self.assertEqual(len(captured), 1)
        request, _timeout = captured[0]
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.get_header("Xi-api-key"), secret)
        self.assertNotIn(secret, request.full_url)
        self.assertTrue(request.full_url.endswith("/v1/history/history_item_01/audio"))


if __name__ == "__main__":
    unittest.main()
