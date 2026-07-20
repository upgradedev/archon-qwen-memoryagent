from __future__ import annotations

from array import array
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
