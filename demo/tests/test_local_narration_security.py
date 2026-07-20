from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "demo" / "tools"
sys.path.insert(0, str(TOOLS))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


narration = load_module("memoryagent_local_narration_security_tests", TOOLS / "build_local_narration.py")
caption = load_module("memoryagent_caption_video_security_tests", TOOLS / "build_caption_video.py")


class RepoArtifactTestCase(unittest.TestCase):
    def setUp(self) -> None:
        artifact_root = ROOT / ".artifacts"
        artifact_root.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="narration-security-test-", dir=artifact_root))

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class TrustedPowerShellTests(RepoArtifactTestCase):
    @unittest.skipUnless(os.name == "nt", "canonical Windows PowerShell test")
    def test_cwd_and_path_shims_never_influence_resolution(self) -> None:
        cwd_shim = self.root / "powershell.exe"
        path_dir = self.root / "early-path"
        path_dir.mkdir()
        path_shim = path_dir / "powershell.exe"
        cwd_shim.write_bytes(b"inert current-directory marker")
        path_shim.write_bytes(b"inert PATH marker")

        original_cwd = Path.cwd()
        original_path = os.environ.get("PATH")
        try:
            os.chdir(self.root)
            os.environ["PATH"] = str(path_dir) + os.pathsep + (original_path or "")
            resolved = narration.trusted_powershell()
        finally:
            os.chdir(original_cwd)
            if original_path is None:
                os.environ.pop("PATH", None)
            else:
                os.environ["PATH"] = original_path

        expected = (
            narration._windows_system_directory()
            / "WindowsPowerShell"
            / "v1.0"
            / "powershell.exe"
        ).resolve(strict=True)
        self.assertEqual(os.path.normcase(str(resolved.path)), os.path.normcase(str(expected)))
        self.assertNotEqual(resolved.path, cwd_shim)
        self.assertNotEqual(resolved.path, path_shim)
        self.assertRegex(resolved.sha256, r"^[0-9a-f]{64}$")
        self.assertGreater(resolved.size, 0)

    @unittest.skipUnless(os.name == "nt", "canonical Windows PowerShell test")
    def test_missing_canonical_system_powershell_fails_closed(self) -> None:
        fake_system = self.root / "system32"
        fake_system.mkdir()
        with mock.patch.object(narration, "_windows_system_directory", return_value=fake_system):
            with self.assertRaisesRegex(narration.NarrationError, "missing or unsafe"):
                narration.trusted_powershell()


class CanonicalProductionVoiceTests(RepoArtifactTestCase):
    def test_exact_zira_is_the_only_canonical_production_voice(self) -> None:
        expected = "Microsoft Zira Desktop"
        self.assertEqual(narration.CANONICAL_PRODUCTION_VOICE_NAME, expected)
        self.assertEqual(narration.require_canonical_production_voice_name(expected), expected)

        for candidate in ("Microsoft David Desktop", "Microsoft Zira Desktop ", "", None):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(
                narration.NarrationError,
                "Microsoft Zira Desktop",
            ):
                narration.require_canonical_production_voice_name(candidate)

    def test_non_zira_generation_fails_before_powershell_or_filesystem_writes(self) -> None:
        with mock.patch.object(narration, "trusted_powershell") as trusted_powershell:
            with self.assertRaisesRegex(narration.NarrationError, "Microsoft Zira Desktop"):
                narration.build_production_bundle(
                    voice_name="Microsoft David Desktop",
                    rate=2,
                    audio_path=self.root / "narration.wav",
                    manifest_path=self.root / "narration.manifest.json",
                    replace_existing=False,
                )

        trusted_powershell.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_rate_one_is_the_only_canonical_production_rate(self) -> None:
        self.assertEqual(narration.CANONICAL_PRODUCTION_RATE, 1)
        self.assertEqual(narration.parse_args([]).rate, 1)
        with mock.patch.object(narration, "trusted_powershell") as trusted_powershell:
            with self.assertRaisesRegex(narration.NarrationError, "exactly 1"):
                narration.build_production_bundle(
                    voice_name=narration.CANONICAL_PRODUCTION_VOICE_NAME,
                    rate=2,
                    audio_path=self.root / "narration.wav",
                    manifest_path=self.root / "narration.manifest.json",
                    replace_existing=False,
                )
        trusted_powershell.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_noncanonical_production_manifest_rate_is_rejected_before_audio_is_trusted(self) -> None:
        timeline, windows = narration.load_caption_timeline()
        audio = self.root / "untrusted.wav"
        manifest = self.root / "untrusted.manifest.json"
        audio.write_bytes(b"not-a-wave")
        manifest.write_text(
            json.dumps({
                "schemaVersion": 1,
                "status": "passed",
                "generator": narration.SYSTEM_SPEECH_GENERATOR_ID,
                "generatedAt": "2026-07-19T00:00:00Z",
                "fixtureOnly": False,
                "bundleOutputs": {
                    "audioPath": narration.DEFAULT_AUDIO_REL,
                    "manifestPath": narration.DEFAULT_MANIFEST_REL,
                },
                "timelineContract": {
                    "path": timeline.relative_path,
                    "sha256": timeline.sha256,
                    "size": timeline.size,
                    "durationSeconds": windows[-1][1],
                    "beatCount": len(windows),
                },
                "voice": {
                    "engine": "Microsoft System.Speech",
                    "name": narration.CANONICAL_PRODUCTION_VOICE_NAME,
                    "culture": "en-US",
                    "gender": "Female",
                    "age": "Adult",
                    "rate": 2,
                    "volume": 100,
                    "explicitlySelected": True,
                },
                "rights": {},
                "generationEvidence": {},
                "segments": [],
                "audio": {},
            }) + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(narration.NarrationError, "rate must be exactly 1"):
            narration.validate_narration_bundle(
                audio,
                manifest,
                production_mode=True,
                expected_generator=narration.SYSTEM_SPEECH_GENERATOR_ID,
                expected_audio_path=narration.DEFAULT_AUDIO_REL,
                expected_manifest_path=narration.DEFAULT_MANIFEST_REL,
            )

    def test_non_zira_production_manifest_fails_before_audio_claims_are_trusted(self) -> None:
        timeline, windows = narration.load_caption_timeline()
        audio = self.root / "untrusted.wav"
        manifest = self.root / "untrusted.manifest.json"
        audio.write_bytes(b"not-a-wave")
        manifest.write_text(
            json.dumps({
                "schemaVersion": 1,
                "status": "passed",
                "generator": narration.SYSTEM_SPEECH_GENERATOR_ID,
                "generatedAt": "2026-07-19T00:00:00Z",
                "fixtureOnly": False,
                "bundleOutputs": {
                    "audioPath": narration.DEFAULT_AUDIO_REL,
                    "manifestPath": narration.DEFAULT_MANIFEST_REL,
                },
                "timelineContract": {
                    "path": timeline.relative_path,
                    "sha256": timeline.sha256,
                    "size": timeline.size,
                    "durationSeconds": windows[-1][1],
                    "beatCount": len(windows),
                },
                "voice": {
                    "engine": "Microsoft System.Speech",
                    "name": "Microsoft David Desktop",
                    "culture": "en-US",
                    "gender": "Male",
                    "age": "Adult",
                    "rate": 2,
                    "volume": 100,
                    "explicitlySelected": True,
                },
                "rights": {},
                "generationEvidence": {},
                "segments": [],
                "audio": {},
            }) + "\n",
            encoding="utf-8",
        )

        with self.assertRaisesRegex(narration.NarrationError, "Microsoft Zira Desktop"):
            narration.validate_narration_bundle(
                audio,
                manifest,
                production_mode=True,
                expected_generator=narration.SYSTEM_SPEECH_GENERATOR_ID,
                expected_audio_path=narration.DEFAULT_AUDIO_REL,
                expected_manifest_path=narration.DEFAULT_MANIFEST_REL,
            )

    def test_release_docs_pin_elevenlabs_and_the_actual_selftest_location(self) -> None:
        for relative in (
            "demo/BUILD_RECORDING.md",
            "demo/CAPTION_VIDEO_BUILD.md",
            "demo/REAL_MOTION_VIDEO.md",
            "demo/RIGHTS_RELEASE_CHECKLIST.md",
            "demo/VIDEO_PUBLICATION_PACKET.md",
        ):
            with self.subTest(relative=relative):
                self.assertIn(
                    narration.CANONICAL_ELEVENLABS_VOICE_ID,
                    (ROOT / relative).read_text(encoding="utf-8"),
                )

        real_motion = (ROOT / "demo" / "REAL_MOTION_VIDEO.md").read_text(encoding="utf-8")
        self.assertIn(".artifacts/local-narration-selftest/", real_motion)


class TransactionTests(RepoArtifactTestCase):
    def _pair(self) -> tuple[Path, Path, Path, Path, Path]:
        scratch = self.root / "scratch"
        scratch.mkdir()
        audio = self.root / "bundle.wav"
        manifest = self.root / "bundle.json"
        staged_audio = scratch / "candidate.wav"
        staged_manifest = scratch / "candidate.json"
        return scratch, audio, manifest, staged_audio, staged_manifest

    def test_pair_replacement_promotes_both_validated_files(self) -> None:
        scratch, audio, manifest, staged_audio, staged_manifest = self._pair()
        audio.write_bytes(b"old audio")
        manifest.write_bytes(b"old manifest")
        staged_audio.write_bytes(b"new audio")
        staged_manifest.write_bytes(b"new manifest")

        observed: list[tuple[bytes, bytes]] = []
        result = narration._promote_narration_pair(
            staged_audio=staged_audio,
            staged_manifest=staged_manifest,
            audio_path=audio,
            manifest_path=manifest,
            scratch=scratch,
            replace_existing=True,
            validate_promoted=lambda: observed.append((audio.read_bytes(), manifest.read_bytes())) or "validated",
        )

        self.assertEqual(result, "validated")
        self.assertEqual(observed, [(b"new audio", b"new manifest")])
        self.assertEqual(audio.read_bytes(), b"new audio")
        self.assertEqual(manifest.read_bytes(), b"new manifest")

    def test_second_file_promotion_failure_restores_original_pair(self) -> None:
        scratch, audio, manifest, staged_audio, staged_manifest = self._pair()
        audio.write_bytes(b"old audio")
        manifest.write_bytes(b"old manifest")
        staged_audio.write_bytes(b"new audio")
        staged_manifest.write_bytes(b"new manifest")
        real_move = narration._move_no_overwrite
        failed = False

        def fail_manifest_once(source: Path, destination: Path) -> None:
            nonlocal failed
            if Path(source) == staged_manifest and Path(destination) == manifest and not failed:
                failed = True
                raise OSError("injected manifest promotion failure")
            real_move(Path(source), Path(destination))

        with mock.patch.object(narration, "_move_no_overwrite", side_effect=fail_manifest_once):
            with self.assertRaisesRegex(narration.NarrationError, "could not be promoted safely"):
                narration._promote_narration_pair(
                    staged_audio=staged_audio,
                    staged_manifest=staged_manifest,
                    audio_path=audio,
                    manifest_path=manifest,
                    scratch=scratch,
                    replace_existing=True,
                    validate_promoted=lambda: "unreachable",
                )

        self.assertEqual(audio.read_bytes(), b"old audio")
        self.assertEqual(manifest.read_bytes(), b"old manifest")

    def test_post_promotion_validation_failure_restores_original_pair(self) -> None:
        scratch, audio, manifest, staged_audio, staged_manifest = self._pair()
        audio.write_bytes(b"old audio")
        manifest.write_bytes(b"old manifest")
        staged_audio.write_bytes(b"new audio")
        staged_manifest.write_bytes(b"new manifest")

        def reject() -> narration.NarrationBundle:
            raise narration.NarrationError("injected post-promotion validation failure")

        with self.assertRaisesRegex(narration.NarrationError, "post-promotion validation failure"):
            narration._promote_narration_pair(
                staged_audio=staged_audio,
                staged_manifest=staged_manifest,
                audio_path=audio,
                manifest_path=manifest,
                scratch=scratch,
                replace_existing=True,
                validate_promoted=reject,
            )

        self.assertEqual(audio.read_bytes(), b"old audio")
        self.assertEqual(manifest.read_bytes(), b"old manifest")

    def test_concurrent_public_replacement_is_preserved_and_original_backup_retained(self) -> None:
        scratch, audio, manifest, staged_audio, staged_manifest = self._pair()
        audio.write_bytes(b"old audio")
        manifest.write_bytes(b"old manifest")
        staged_audio.write_bytes(b"new audio")
        staged_manifest.write_bytes(b"new manifest")
        racer = self.root / "concurrent-audio.bin"
        racer.write_bytes(b"concurrent audio")

        def replace_then_reject() -> narration.NarrationBundle:
            os.replace(racer, audio)
            raise narration.NarrationError("injected post-promotion failure after concurrent replacement")

        with self.assertRaises(narration.NarrationRecoveryRequired) as caught:
            narration._promote_narration_pair(
                staged_audio=staged_audio,
                staged_manifest=staged_manifest,
                audio_path=audio,
                manifest_path=manifest,
                scratch=scratch,
                replace_existing=True,
                validate_promoted=replace_then_reject,
            )

        self.assertEqual(audio.read_bytes(), b"concurrent audio")
        self.assertEqual(manifest.read_bytes(), b"old manifest")
        inventory_path = caught.exception.inventory_path
        self.assertIsNotNone(inventory_path)
        assert inventory_path is not None
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
        concurrent = inventory["retainedConcurrentEntries"]
        self.assertTrue(any(record["path"] == narration.relative_repo_path(audio) for record in concurrent))
        original = next(
            record
            for record in inventory["recoverableOriginals"]
            if record["intendedTarget"] == narration.relative_repo_path(audio)
        )
        self.assertEqual((ROOT / original["path"]).read_bytes(), b"old audio")

    def test_staged_promotion_identity_swap_never_deletes_concurrent_bytes(self) -> None:
        scratch, audio, manifest, staged_audio, staged_manifest = self._pair()
        audio.write_bytes(b"old audio")
        manifest.write_bytes(b"old manifest")
        staged_audio.write_bytes(b"new audio")
        staged_manifest.write_bytes(b"new manifest")
        concurrent = self.root / "concurrent-staged.bin"
        concurrent.write_bytes(b"concurrent staged bytes")
        real_move = narration._move_no_overwrite
        injected = False

        def swap_at_staged_move_boundary(source: Path, destination: Path) -> None:
            nonlocal injected
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path == staged_audio and destination_path == audio and not injected:
                injected = True
                os.replace(concurrent, staged_audio)
            real_move(source_path, destination_path)

        with (
            mock.patch.object(narration, "_move_no_overwrite", side_effect=swap_at_staged_move_boundary),
            self.assertRaises(narration.NarrationRecoveryRequired) as caught,
        ):
            narration._promote_narration_pair(
                staged_audio=staged_audio,
                staged_manifest=staged_manifest,
                audio_path=audio,
                manifest_path=manifest,
                scratch=scratch,
                replace_existing=True,
                validate_promoted=lambda: "unreachable",
            )

        self.assertTrue(injected)
        self.assertEqual(audio.read_bytes(), b"old audio")
        self.assertEqual(manifest.read_bytes(), b"old manifest")
        inventory_path = caught.exception.inventory_path
        self.assertIsNotNone(inventory_path)
        assert inventory_path is not None
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
        retained = inventory["retainedConcurrentEntries"]
        concurrent_record = next(
            record for record in retained if record.get("stableRegularFile") is True
        )
        retained_path = ROOT / concurrent_record["path"]
        self.assertEqual(retained_path.read_bytes(), b"concurrent staged bytes")
        self.assertEqual(
            concurrent_record["sha256"],
            hashlib.sha256(b"concurrent staged bytes").hexdigest(),
        )

    def test_restore_failure_retains_recoverable_original_and_exact_inventory(self) -> None:
        audio = self.root / "fixture.wav"
        manifest = self.root / "fixture.json"
        audio.write_bytes(b"old audio requiring recovery")
        manifest.write_bytes(b"old manifest restored normally")
        windows = ((0, 1, "Bounded synthetic fixture."),)
        real_move = narration._move_no_overwrite
        validation_calls = 0

        def fail_post_promotion_validation(*_args, **_kwargs):
            nonlocal validation_calls
            validation_calls += 1
            if validation_calls == 1:
                return mock.sentinel.staged_bundle
            raise narration.NarrationError("injected post-promotion validation failure")

        def fail_audio_restore(source: Path, destination: Path) -> None:
            source_path = Path(source)
            if source_path.name.endswith(".rollback") and Path(destination) == audio:
                raise OSError("injected original-audio restore failure")
            real_move(source_path, Path(destination))

        with (
            mock.patch.object(narration, "validate_narration_bundle", side_effect=fail_post_promotion_validation),
            mock.patch.object(narration, "_move_no_overwrite", side_effect=fail_audio_restore),
        ):
            with self.assertRaises(narration.NarrationRecoveryRequired) as caught:
                narration.create_synthetic_fixture(
                    audio,
                    manifest,
                    windows=windows,
                    replace_existing=True,
                )

        recovery = caught.exception
        self.assertTrue(recovery.recovery_directory.is_dir())
        self.assertIsNotNone(recovery.inventory_path)
        assert recovery.inventory_path is not None
        self.assertTrue(recovery.inventory_path.is_file())
        inventory = json.loads(recovery.inventory_path.read_text(encoding="utf-8"))
        self.assertEqual(inventory["status"], "manual-recovery-required")
        self.assertEqual(inventory["recoveryDirectory"], narration.relative_repo_path(recovery.recovery_directory))
        audio_records = [
            record
            for record in inventory["recoverableOriginals"]
            if record["intendedTarget"] == narration.relative_repo_path(audio)
        ]
        self.assertEqual(len(audio_records), 1)
        audio_record = audio_records[0]
        self.assertTrue(audio_record["stableRegularFile"])
        retained_audio = ROOT / audio_record["path"]
        self.assertEqual(retained_audio.read_bytes(), b"old audio requiring recovery")
        self.assertEqual(
            audio_record["sha256"],
            hashlib.sha256(b"old audio requiring recovery").hexdigest(),
        )
        self.assertIn(retained_audio.resolve(), recovery.recoverable_paths)
        self.assertFalse(audio.exists())
        self.assertEqual(manifest.read_bytes(), b"old manifest restored normally")
        self.assertIn(narration.relative_repo_path(recovery.recovery_directory), str(recovery))
        self.assertIn(narration.relative_repo_path(recovery.inventory_path), str(recovery))

    def test_generation_failure_before_promotion_leaves_original_pair_untouched(self) -> None:
        audio = self.root / "fixture.wav"
        manifest = self.root / "fixture.json"
        audio.write_bytes(b"old audio")
        manifest.write_bytes(b"old manifest")
        windows = ((0, 1, "Bounded synthetic fixture."),)

        with mock.patch.object(
            narration,
            "_atomic_manifest",
            side_effect=narration.NarrationError("injected staged-manifest failure"),
        ):
            with self.assertRaisesRegex(narration.NarrationError, "staged-manifest failure"):
                narration.create_synthetic_fixture(
                    audio,
                    manifest,
                    windows=windows,
                    replace_existing=True,
                )

        self.assertEqual(audio.read_bytes(), b"old audio")
        self.assertEqual(manifest.read_bytes(), b"old manifest")


class ProvenanceBindingTests(RepoArtifactTestCase):
    def test_fixture_pcm_source_and_generator_evidence_are_exactly_bound(self) -> None:
        audio = self.root / "fixture.wav"
        manifest = self.root / "fixture.json"
        windows = ((0, 1, "Bounded synthetic fixture."),)
        bundle = narration.create_synthetic_fixture(audio, manifest, windows=windows)
        self.assertEqual(list(self.root.glob("memoryagent-narration-fixture-*")), [])

        segment = bundle.payload["segments"][0]
        self.assertRegex(segment["sourcePcmSha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(segment["sourcePcmBytes"], segment["sourceFrames"] * narration.SAMPLE_WIDTH)
        evidence = bundle.payload["generationEvidence"]
        self.assertEqual(evidence["fixtureAlgorithm"], narration.FIXTURE_ALGORITHM)
        self.assertEqual(
            evidence["synthesisRequestSha256"],
            narration.canonical_json_sha256(evidence["synthesisRequest"]),
        )
        self.assertFalse(bundle.payload["rights"]["automatedProvenanceIsAuthoritativeRightsProof"])
        self.assertTrue(bundle.payload["rights"]["humanVoiceRightsReviewRequired"])

        tampered = json.loads(manifest.read_text(encoding="utf-8"))
        tampered["generationEvidence"]["generatorSource"]["sha256"] = "0" * 64
        manifest.write_text(json.dumps(tampered) + "\n", encoding="utf-8", newline="\n")
        with self.assertRaisesRegex(narration.NarrationError, "generation evidence"):
            narration.validate_narration_bundle(audio, manifest, windows=windows, production_mode=False)


class CanonicalSrtReadOnlyTests(RepoArtifactTestCase):
    @staticmethod
    def _snapshot(path: Path, relative_path: str, data: bytes) -> object:
        return narration.ProjectFileSnapshot(
            path=path.resolve(),
            relative_path=relative_path,
            data=data,
            sha256=hashlib.sha256(data).hexdigest(),
            size=len(data),
        )

    def test_caption_build_preserves_canonical_srt_bytes_and_file_identity(self) -> None:
        beat = caption.Beat(1, "Read-only SRT", 1, "Bounded synthetic fixture.", ())
        beats = (beat,)
        srt = self.root / "canonical.en.srt"
        srt_data = caption.expected_srt(beats).encode("utf-8")
        srt.write_bytes(srt_data)
        srt_snapshot = self._snapshot(srt, caption.SRT_REL, srt_data)
        evidence = self.root / "evidence.json"
        evidence.write_bytes(b"{}\n")
        generic = self._snapshot(evidence, ".artifacts/test/evidence.json", evidence.read_bytes())
        architecture = self.root / "architecture.jpg"
        architecture.write_bytes(b"fixture architecture")
        architecture_snapshot = self._snapshot(
            architecture,
            caption.ARCHITECTURE_REL,
            architecture.read_bytes(),
        )
        inputs = caption.ValidatedInputs(
            exact_runtime_sha="1" * 40,
            capture_head="2" * 40,
            current_head="3" * 40,
            captured_at="2026-07-19T00:00:00Z",
            live_base_url="https://example.invalid",
            exact_deploy_evidence_mode="fixture",
            deployment_producer={"invocationId": "fixture", "commandId": "fixture", "outputSha256": "0" * 64, "outputBytes": 0},
            builder_source=generic,
            narration_source=generic,
            capture_review=generic,
            deploy_state=generic,
            claim_matrix=generic,
            deployment_output=generic,
            deployment_status=generic,
            architecture_source=generic,
            caption_contract=generic,
            artifact_files={caption.SRT_REL: srt_snapshot, caption.ARCHITECTURE_REL: architecture_snapshot},
        )
        narration_audio = self.root / "fixture.wav"
        narration_manifest = self.root / "fixture.manifest.json"
        narration.create_synthetic_fixture(
            narration_audio,
            narration_manifest,
            windows=((0, 1, beat.caption),),
        )
        before = srt.lstat()

        technical = {
            "durationSeconds": 1.0,
            "frameCount": 30,
            "fps": 30,
            "width": 1920,
            "height": 1080,
            "videoCodec": "h264",
            "pixelFormat": "yuv420p",
            "audioCodec": "aac",
            "audioSampleRate": 48_000,
            "audioChannels": 2,
            "decodedAudioPeakS16": 4_000,
            "decodedAudioRmsS16": 100.0,
            "decodedAudioActiveSampleRatio": 0.1,
            "decodedAudioClippedSamples": 0,
            "decodedAudioSampleCount": 96_000,
            "decodedAudioPcmSha256": "4" * 64,
        }

        def fake_render(_beat, _inputs, output, **_kwargs):
            caption.exclusive_write_bytes(output, b"fixture frame")

        def fake_encode(_frames, _beats, _audio, output, _scratch):
            output.write_bytes(b"fixture video")

        with (
            mock.patch.object(caption, "render_beat_frame", side_effect=fake_render),
            mock.patch.object(caption, "encode_video", side_effect=fake_encode),
            mock.patch.object(caption, "probe_video", return_value=technical),
            mock.patch.object(caption, "binary_version", return_value="fixture"),
        ):
            manifest_payload = caption.build_video(
                inputs,
                output=self.root / "caption-base.mp4",
                srt_path=srt,
                manifest_path=self.root / "caption-base.manifest.json",
                scratch=self.root / "scratch",
                narration_audio=narration_audio,
                narration_manifest=narration_manifest,
                beats=beats,
                self_test_label=True,
            )

        after = srt.lstat()
        self.assertEqual(
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns),
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
        )
        self.assertEqual(srt.read_bytes(), srt_data)
        self.assertEqual(manifest_payload["outputs"]["subtitles"]["sha256"], srt_snapshot.sha256)
        self.assertEqual(manifest_payload["outputs"]["subtitles"]["role"], "validated-read-only-canonical-input")


if __name__ == "__main__":
    unittest.main()
