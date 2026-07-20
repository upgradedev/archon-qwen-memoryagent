"""Focused offline regressions for immutable real-motion composition."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "demo" / "tools" / "compose_real_motion_video.py"
SPEC = importlib.util.spec_from_file_location("memoryagent_real_motion_compositor", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
motion = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = motion
SPEC.loader.exec_module(motion)

ORCHESTRATOR_PATH = ROOT / "demo" / "tools" / "build_real_motion_submission.py"
ORCHESTRATOR_SPEC = importlib.util.spec_from_file_location(
    "memoryagent_real_motion_orchestrator",
    ORCHESTRATOR_PATH,
)
assert ORCHESTRATOR_SPEC is not None and ORCHESTRATOR_SPEC.loader is not None
orchestrator = importlib.util.module_from_spec(ORCHESTRATOR_SPEC)
sys.modules[ORCHESTRATOR_SPEC.name] = orchestrator
ORCHESTRATOR_SPEC.loader.exec_module(orchestrator)


class RealMotionCompositorTests(unittest.TestCase):
    def setUp(self) -> None:
        motion.clear_trusted_executable_cache()
        self.root = ROOT / ".artifacts" / "final-video" / f"compositor-unit-{os.getpid()}-{id(self)}"
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        motion.clear_trusted_executable_cache()
        if self.root.exists():
            def writable(function: object, target: str, _error: object) -> None:
                Path(target).chmod(0o700)
                function(target)  # type: ignore[operator]

            shutil.rmtree(self.root, onerror=writable)

    def write(self, name: str, content: bytes) -> Path:
        path = self.root / name
        path.write_bytes(content)
        return path

    def immutable(self, path: Path) -> object:
        return motion.ImmutableInput(
            source_path=path,
            source_relative=motion.relative(path),
            staged_path=path,
            sha256=motion.sha256_file(path),
            size=path.stat().st_size,
        )

    def interaction_fixture(self) -> tuple[Path, Path, Path, object, object, object]:
        expected_sha = "1" * 40
        evidence = self.root / "CAPTURE_REVIEW.json"
        live = self.write("live.webm", b"immutable-live-fixture")
        poster_path = self.write("poster.png", b"immutable-poster-fixture")
        status_path = self.write("deploy-status.json", b'{"invocationId":"i","commandId":"c"}\n')
        output_path = self.write("deploy-output.txt", b"exact deploy output fixture\n")
        evidence.write_text(json.dumps({
            "schemaVersion": 3,
            "status": "passed",
            "exactRuntimeSource": expected_sha,
            "liveBaseUrl": motion.DEFAULT_URL,
            "submissionPackHeadAtCapture": "2" * 40,
        }) + "\n", encoding="utf-8")
        source_record = {
            "path": "demo/tools/record_live_motion.py",
            "sha256": "a" * 64,
            "size": 123,
        }
        summary = {
            "durationSeconds": 5.0,
            "width": 1920,
            "height": 1080,
            "videoCodec": "vp8",
            "pixelFormat": "yuv420p",
            "averageFrameRate": "30/1",
            "frameCount": 150,
            "audioCodec": None,
            "audioSampleRate": None,
            "audioChannels": None,
            "audioStreamCount": 0,
            "videoStreamCount": 1,
        }
        frame_diversity = {"sampledFrames": 10, "uniqueFrames": 10, "uniqueRatio": 1.0}
        recall = {
            "question": motion.EXPECTED_CAPTURE_QUESTION,
            "company": "Northwind Trading",
            "requestLimit": 3,
            "modelId": "qwen-plus",
            "grounding": {"status": "passed", "attempts": 1},
            "citationCount": 1,
            "answerSha256": "b" * 64,
        }
        payload = {
            "schemaVersion": 1,
            "status": "passed",
            "mode": "live",
            "submissionEligible": True,
            "expectedRuntimeSha": expected_sha,
            "publicUrl": motion.DEFAULT_URL,
            "recorderSource": source_record,
            "capturedAt": "2000-01-01T00:00:00Z",
            "finishedAt": "2000-01-01T00:00:01Z",
            "evidenceManifestPath": motion.relative(evidence),
            "evidenceManifestSha256": motion.sha256_file(evidence),
            "reviewerCredentialUsed": False,
            "reviewerCredentialRendered": False,
            "durableReviewerWritesCreated": False,
            "publicSeed": "idempotent canonical demo seed",
            "canonicalQuestionSource": {
                "path": "scripts/capture_submission_gallery.py",
                "sha256": "a" * 64,
                "question": motion.EXPECTED_CAPTURE_QUESTION,
            },
            "recallProof": recall,
            "actions": [{"atSeconds": 0.1, "action": "fixture action"}],
            "rawVideo": {
                "path": motion.relative(live),
                "sha256": motion.sha256_file(live),
                "bytes": live.stat().st_size,
                **summary,
            },
            "frameDiversity": frame_diversity,
            "poster": {
                "path": motion.relative(poster_path),
                "sha256": motion.sha256_file(poster_path),
                "bytes": poster_path.stat().st_size,
            },
        }
        interaction = self.root / "interaction.json"
        interaction.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        return (
            evidence,
            interaction,
            live,
            self.immutable(poster_path),
            self.immutable(status_path),
            self.immutable(output_path),
        )

    def validate_interaction(self, mutate: object | None = None) -> tuple[dict[str, object], dict[str, object]]:
        evidence, interaction, live, poster, status, output = self.interaction_fixture()
        payload = json.loads(interaction.read_text(encoding="utf-8"))
        if mutate is not None:
            mutate(payload)  # type: ignore[operator]
            interaction.write_text(json.dumps(payload) + "\n", encoding="utf-8")

        def source(relative_path: str, _label: str, *, require_head: bool) -> dict[str, object]:
            del require_head
            return {"path": relative_path, "sha256": "a" * 64, "size": 123}

        with (
            mock.patch.object(motion, "tracked_source_record", side_effect=source),
            mock.patch.object(motion, "validate_exact_deployment_binding", return_value={}),
            mock.patch.object(motion, "media_summary", return_value=payload["rawVideo"] | {
                "path": None, "sha256": None, "bytes": None,
            }),
            mock.patch.object(motion, "diversity", return_value=payload["frameDiversity"]),
        ):
            # media_summary must not contain the manifest binding fields.
            with mock.patch.object(
                motion,
                "media_summary",
                return_value={
                    key: value
                    for key, value in payload["rawVideo"].items()
                    if key not in {"path", "sha256", "bytes"}
                },
            ):
                return motion.validate_bindings(
                    expected_sha="1" * 40,
                    expected_url=motion.DEFAULT_URL,
                    evidence_path=evidence,
                    interaction_path=interaction,
                    live_video=live,
                    evidence_source=evidence,
                    interaction_source=interaction,
                    live_video_source=live,
                    poster_input=poster,
                    deployment_status_input=status,
                    deployment_output_input=output,
                    allow_fixture=False,
                )

    def test_exact_live_safety_and_recall_contract_accepts_canonical_fixture(self) -> None:
        _evidence, interaction = self.validate_interaction()
        self.assertEqual(interaction["mode"], "live")

    def test_each_omitted_or_unsafe_live_field_is_rejected(self) -> None:
        mutations = {
            "credential rendered": lambda row: row.__setitem__("reviewerCredentialRendered", True),
            "credential used": lambda row: row.__setitem__("reviewerCredentialUsed", True),
            "durable write": lambda row: row.__setitem__("durableReviewerWritesCreated", True),
            "wrong mode": lambda row: row.__setitem__("mode", "fixture"),
            "ineligible": lambda row: row.__setitem__("submissionEligible", False),
            "wrong question source": lambda row: row["canonicalQuestionSource"].__setitem__("path", "other.py"),
            "missing recall": lambda row: row.__setitem__("recallProof", None),
            "wrong model": lambda row: row["recallProof"].__setitem__("modelId", "fake"),
            "extra recall field": lambda row: row["recallProof"].__setitem__("unexpected", True),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), self.assertRaises(motion.GateError):
                self.validate_interaction(mutate)

    def test_read_once_stage_survives_source_replacement_and_digest_gate_rejects_reopen(self) -> None:
        source = self.write("source.srt", b"reviewed canonical bytes\n")
        session = motion.create_private_build_session(self.root / "scratch")
        staged = motion.stage_project_input(source, "fixture source", session, "source.srt")
        validated_hash = staged.sha256
        source.write_bytes(b"post-validation attacker replacement\n")
        self.assertEqual(staged.staged_path.read_bytes(), b"reviewed canonical bytes\n")
        with self.assertRaises(motion.GateError):
            motion.staged_copy(source, session, "reopened.srt", expected_sha256=validated_hash)
        copied = motion.staged_copy(
            staged.staged_path,
            session,
            "retained.srt",
            expected_sha256=validated_hash,
        )
        self.assertEqual(copied.read_bytes(), b"reviewed canonical bytes\n")

    def test_verification_output_consumes_retained_bytes_after_public_path_changes(self) -> None:
        public = self.write("public.mp4", b"published bytes")
        record = {
            "path": motion.relative(public),
            "sha256": motion.sha256_file(public),
            "size": public.stat().st_size,
        }
        session = motion.create_private_build_session(self.root / "verify")
        retained = motion._verification_output(record, "public fixture", session, "retained.mp4")
        public.write_bytes(b"later mutable replacement")
        self.assertEqual(retained.staged_path.read_bytes(), b"published bytes")

    def test_verification_output_rejects_manifest_hash_drift(self) -> None:
        public = self.write("output.mp4", b"published bytes")
        record = {
            "path": motion.relative(public),
            "sha256": "0" * 64,
            "size": public.stat().st_size,
        }
        session = motion.create_private_build_session(self.root / "output-drift")
        with self.assertRaises(motion.GateError):
            motion._verification_output(record, "public fixture", session, "retained.mp4")

    def test_private_session_and_recursive_cleanup_boundaries_are_narrow(self) -> None:
        with self.assertRaises(motion.GateError):
            motion.create_private_build_session(ROOT / ".artifacts" / "other-scratch")
        with self.assertRaises(motion.GateError):
            motion.create_private_build_session(ROOT / ".artifacts" / "final-video")
        with self.assertRaises(motion.GateError):
            motion._remove_tree(ROOT / ".artifacts" / "final-video")
        with self.assertRaises(motion.GateError):
            motion._remove_tree(ROOT / "demo")

    def test_stale_builder_source_head_is_rejected(self) -> None:
        head = "a" * 40
        self.assertEqual(
            motion.require_builder_source_head({"builderSourceHead": head}, expected_head=head),
            head,
        )
        with self.assertRaises(motion.GateError):
            motion.require_builder_source_head({"builderSourceHead": "b" * 40}, expected_head=head)

    def test_exact_rights_profiles_reject_nested_or_final_drift(self) -> None:
        generated = {
            "syntheticVoiceDisclosure": True,
            "disclosure": motion.DISCLOSURE,
            "networkUsed": True,
            "musicUsed": False,
            "thirdPartyMusic": False,
            "thirdPartyAudio": True,
            "generatedLocally": False,
            "commercialUseRightsApproved": True,
            "humanVoiceRightsReviewRequired": True,
            "automatedProvenanceIsAuthoritativeRightsProof": False,
        }
        base = {
            key: generated[key]
            for key in (
                "syntheticVoiceDisclosure", "disclosure", "thirdPartyMusic", "thirdPartyAudio",
                "commercialUseRightsApproved",
                "humanVoiceRightsReviewRequired", "automatedProvenanceIsAuthoritativeRightsProof",
            )
        }
        motion.validate_narration_rights(generated, base, allow_fixture=False)
        motion.validate_final_rights_profile(copy.deepcopy(motion.CANONICAL_RIGHTS_PROFILE))
        cases = {
            "narration manifest rights": (generated | {"networkUsed": False}, base),
            "caption-base rights projection": (generated, base | {"thirdPartyMusic": True}),
        }
        for label, (candidate_generated, candidate_base) in cases.items():
            with self.subTest(label=label), self.assertRaises(motion.GateError):
                motion.validate_narration_rights(candidate_generated, candidate_base, allow_fixture=False)
        final_rights = copy.deepcopy(motion.CANONICAL_RIGHTS_PROFILE)
        final_rights["humanVoiceRightsReviewRequired"] = False
        with self.assertRaises(motion.GateError):
            motion.validate_final_rights_profile(final_rights)

    def test_exact_qa_rejects_field_or_key_drift(self) -> None:
        expected = {"schemaVersion": 2, "status": "passed", "video": {"frameCount": 360}}
        motion.validate_exact_final_qa(copy.deepcopy(expected), expected)
        candidates = [
            expected | {"status": "failed"},
            expected | {"unexpected": True},
            expected | {"video": {"frameCount": 359}},
        ]
        for candidate in candidates:
            with self.subTest(candidate=candidate), self.assertRaises(motion.GateError):
                motion.validate_exact_final_qa(candidate, expected)

    def test_media_contract_rejects_frame_duration_codec_and_audio_drift(self) -> None:
        measured = {
            "durationSeconds": 12.0,
            "frameCount": 360,
            "width": 1920,
            "height": 1080,
            "videoCodec": "h264",
            "pixelFormat": "yuv420p",
            "averageFrameRate": "30/1",
            "audioStreamCount": 1,
            "audioCodec": "aac",
            "audioSampleRate": 48000,
            "audioChannels": 2,
        }
        base = {"durationSeconds": 12.0, "frameCount": 360}
        self.assertEqual(
            motion.validate_final_media_contract(base, measured, 360, allow_fixture=True),
            12.0,
        )
        mutations = {
            "frame count": {"frameCount": 359},
            "duration": {"durationSeconds": 11.9},
            "codec": {"videoCodec": "vp9"},
            "audio stream": {"audioStreamCount": 0},
            "audio codec": {"audioCodec": "opus"},
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label), self.assertRaises(motion.GateError):
                motion.validate_final_media_contract(
                    base, measured | mutation, 360, allow_fixture=True,
                )

    def final_binding_fixture(self) -> tuple[dict[str, object], dict[str, object], dict[str, object], dict[str, object]]:
        record = lambda name: {"path": name, "sha256": name * 64, "size": len(name)}
        inventory = {
            "captureReview": record("a"),
            "interactionManifest": record("b"),
            "liveVideo": record("c"),
            "livePoster": record("d"),
            "baseVideo": record("e"),
            "baseManifest": record("f"),
            "canonicalSrt": record("1"),
            "thumbnail": record("2"),
            "captionTimeline": record("3"),
            "narrationAudio": record("4"),
            "narrationManifest": record("5"),
        }
        evidence = {"captureReview": inventory["captureReview"]}
        live = {
            "manifest": inventory["interactionManifest"],
            "video": inventory["liveVideo"],
            "poster": inventory["livePoster"],
        }
        narration = {
            "audio": inventory["narrationAudio"],
            "manifest": inventory["narrationManifest"],
            "generator": "local",
            "voice": {"name": "fixture"},
            "timelineContract": {"sha256": "6" * 64},
            "rights": {"syntheticVoiceDisclosure": True},
            "generationEvidence": {"sha256": "7" * 64},
            "sourceDecoded": {"peakS16": 3000},
            "baseDecoded": {"peakS16": 2990},
        }
        inputs = {
            "baseVideo": inventory["baseVideo"],
            "baseManifest": inventory["baseManifest"],
            "subtitles": inventory["canonicalSrt"],
            "thumbnail": inventory["thumbnail"],
            "timeline": inventory["captionTimeline"],
            "narration": narration,
        }
        return evidence, live, inputs, inventory

    def test_final_input_and_narration_cross_binding_drift_is_rejected(self) -> None:
        evidence, live, inputs, inventory = self.final_binding_fixture()
        narration = motion.validate_final_input_cross_bindings(evidence, live, inputs, inventory)
        base_evidence = {"narration": {
            key: narration[key]
            for key in ("generator", "voice", "timelineContract", "rights", "generationEvidence")
        }}
        motion.validate_final_narration_evidence_bindings(
            narration, base_evidence, narration["sourceDecoded"], narration["baseDecoded"],
        )

        stale_inputs = copy.deepcopy(inputs)
        stale_inputs["baseVideo"]["sha256"] = "0" * 64
        with self.assertRaises(motion.GateError):
            motion.validate_final_input_cross_bindings(evidence, live, stale_inputs, inventory)

        stale_audio = copy.deepcopy(inputs)
        stale_audio["narration"]["audio"]["sha256"] = "0" * 64
        with self.assertRaises(motion.GateError):
            motion.validate_final_input_cross_bindings(evidence, live, stale_audio, inventory)

        stale_narration = copy.deepcopy(narration)
        stale_narration["rights"] = {"syntheticVoiceDisclosure": False}
        with self.assertRaises(motion.GateError):
            motion.validate_final_narration_evidence_bindings(
                stale_narration, base_evidence, narration["sourceDecoded"], narration["baseDecoded"],
            )

    def test_srt_hash_and_byte_identity_drift_is_rejected(self) -> None:
        canonical_path = self.write("canonical.srt", b"1\n00:00:00,000 --> 00:00:01,000\nHello.\n")
        output_path = self.write("output.srt", canonical_path.read_bytes())
        canonical = self.immutable(canonical_path)
        output = self.immutable(output_path)
        qa = {"cues": 1, "firstStart": 0.0, "lastEnd": 1.0}
        record = {
            "path": output.source_relative,
            "sha256": output.sha256,
            "size": output.size,
            **qa,
        }
        motion.validate_srt_output_binding(record, output, canonical, qa)
        with self.assertRaises(motion.GateError):
            motion.validate_srt_output_binding(record | {"sha256": "0" * 64}, output, canonical, qa)
        changed_path = self.write("changed.srt", b"different reviewed subtitle bytes\n")
        changed = self.immutable(changed_path)
        changed_record = {
            "path": changed.source_relative,
            "sha256": changed.sha256,
            "size": changed.size,
            **qa,
        }
        with self.assertRaises(motion.GateError):
            motion.validate_srt_output_binding(changed_record, changed, canonical, qa)

    def test_compose_path_alias_matrix_allows_only_canonical_srt_replacement(self) -> None:
        canonical_srt = (ROOT / motion.DEFAULT_SRT_OUTPUT).resolve()
        sources = tuple(self.root / f"source-{index}.bin" for index in range(8)) + (
            canonical_srt,
        )
        outputs = (
            self.root / "final.mp4",
            canonical_srt,
            self.root / "final.manifest.json",
            self.root / "final.qa.json",
        )
        motion.validate_compose_path_aliases(
            sources,
            outputs,
            srt=canonical_srt,
            output_srt=canonical_srt,
        )

        noncanonical_srt = self.root / "alternate.srt"
        with self.assertRaises(motion.GateError):
            motion.validate_compose_path_aliases(
                sources[:-1] + (noncanonical_srt,),
                (outputs[0], noncanonical_srt, outputs[2], outputs[3]),
                srt=noncanonical_srt,
                output_srt=noncanonical_srt,
            )
        with self.assertRaises(motion.GateError):
            motion.validate_compose_path_aliases(
                sources,
                (sources[0], canonical_srt, outputs[2], outputs[3]),
                srt=canonical_srt,
                output_srt=canonical_srt,
            )

    def test_orchestrator_passes_the_canonical_srt_to_both_build_stages(self) -> None:
        expected_sha = "1" * 40
        canonical_srt = (ROOT / orchestrator.caption.SRT_REL).resolve()

        def project_path(value: object, _label: str, *, exists: bool = False) -> Path:
            del exists
            candidate = Path(value)
            return candidate if candidate.is_absolute() else (ROOT / candidate).resolve()

        with (
            mock.patch.object(orchestrator.motion, "project_path", side_effect=project_path),
            mock.patch.object(orchestrator.caption, "validate_inputs", return_value=object()),
            mock.patch.object(orchestrator.caption, "build_video") as build_video,
            mock.patch.object(
                orchestrator.motion,
                "compose",
                return_value={"qa": {"duration": {"finalSeconds": 172.0}}},
            ) as compose,
        ):
            result = orchestrator.main([
                "--expected-sha", expected_sha,
                "--deployment-output", ".artifacts/deploy/output.txt",
                "--deployment-status", ".artifacts/deploy/status.json",
                "--replace",
            ])

        self.assertEqual(result, 0)
        self.assertEqual(build_video.call_args.kwargs["srt_path"], canonical_srt)
        self.assertEqual(compose.call_args.kwargs["srt"], canonical_srt)
        self.assertEqual(compose.call_args.kwargs["output_srt"], canonical_srt)

    def test_orchestrator_scratch_rejects_prefix_sibling(self) -> None:
        safe = (ROOT / ".artifacts" / "final-video" / "one-build").resolve()
        self.assertEqual(orchestrator.validate_scratch_root(safe), safe)
        sibling = (ROOT / ".artifacts" / "final-video-evil" / "one-build").resolve()
        with self.assertRaises(orchestrator.motion.GateError):
            orchestrator.validate_scratch_root(sibling)

    def test_orchestrator_retains_committed_session_when_stdout_fails(self) -> None:
        expected_sha = "1" * 40

        def project_path(value: object, _label: str, *, exists: bool = False) -> Path:
            del exists
            candidate = Path(value)
            return candidate if candidate.is_absolute() else (ROOT / candidate).resolve()

        def fail_only_stdout(*_args: object, **kwargs: object) -> None:
            if kwargs.get("file") is orchestrator.sys.stderr:
                return
            raise BrokenPipeError("synthetic closed stdout")

        with (
            mock.patch.object(orchestrator.motion, "project_path", side_effect=project_path),
            mock.patch.object(orchestrator.caption, "validate_inputs", return_value=object()),
            mock.patch.object(orchestrator.caption, "build_video"),
            mock.patch.object(
                orchestrator.motion,
                "compose",
                return_value={"qa": {"duration": {"finalSeconds": 172.0}}},
            ),
            mock.patch.object(orchestrator.motion, "_remove_tree") as remove_tree,
            mock.patch("builtins.print", side_effect=fail_only_stdout),
        ):
            result = orchestrator.main([
                "--expected-sha", expected_sha,
                "--deployment-output", ".artifacts/deploy/output.txt",
                "--deployment-status", ".artifacts/deploy/status.json",
                "--replace",
            ])

        self.assertEqual(result, 2)
        remove_tree.assert_not_called()

    def make_bundle(self) -> tuple[list[tuple[Path, Path]], list[Path], Path]:
        scratch = self.root / "promotion"
        scratch.mkdir()
        destinations: list[Path] = []
        staged: list[tuple[Path, Path]] = []
        for index in range(4):
            destination = self.write(f"final-{index}.bin", f"old-{index}".encode())
            candidate = self.write(f"staged-{index}.bin", f"new-{index}".encode())
            destinations.append(destination)
            staged.append((candidate, destination))
        return staged, destinations, scratch

    def test_intermediate_promotion_failure_restores_complete_old_bundle(self) -> None:
        staged, destinations, scratch = self.make_bundle()
        real_link = motion.os.link
        calls = 0

        def fail_second_promotion(
            source: object,
            destination: object,
            **kwargs: object,
        ) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic promotion failure")
            real_link(source, destination, **kwargs)

        with mock.patch.object(motion.os, "link", side_effect=fail_second_promotion):
            with self.assertRaisesRegex(motion.GateError, "hard-link publication"):
                motion.promote_output_bundle(staged, scratch, replace=True)
        self.assertEqual([path.read_bytes() for path in destinations], [
            b"old-0", b"old-1", b"old-2", b"old-3",
        ])

    def test_no_replace_race_preserves_concurrently_appeared_destination(self) -> None:
        scratch = self.root / "promotion-race"
        scratch.mkdir()
        candidate = self.write("race-staged.bin", b"new")
        destination = self.root / "race-final.bin"
        real_link = motion.os.link

        def race_link(source: object, target: object, **kwargs: object) -> None:
            Path(target).write_bytes(b"concurrent")
            real_link(source, target, **kwargs)

        with mock.patch.object(motion.os, "link", side_effect=race_link):
            with self.assertRaisesRegex(motion.GateError, "refused to overwrite"):
                motion.promote_output_bundle(
                    [(candidate, destination)],
                    scratch,
                    replace=False,
                )

        self.assertEqual(destination.read_bytes(), b"concurrent")
        self.assertEqual(candidate.read_bytes(), b"new")

    def test_post_link_capture_failure_withdraws_untracked_publication(self) -> None:
        scratch = self.root / "promotion-capture-failure"
        scratch.mkdir()
        candidate = self.write("capture-staged.bin", b"new")
        destination = self.root / "capture-final.bin"
        real_capture = motion.OwnedPath.capture
        failed = False

        def fail_destination_capture(path: Path, label: str) -> object:
            nonlocal failed
            if path == destination and not failed:
                failed = True
                raise motion.GateError("synthetic destination capture failure")
            return real_capture(path, label)

        with mock.patch.object(motion.OwnedPath, "capture", side_effect=fail_destination_capture):
            with self.assertRaisesRegex(motion.GateError, "synthetic destination capture failure"):
                motion.promote_output_bundle(
                    [(candidate, destination)],
                    scratch,
                    replace=False,
                )

        self.assertFalse(destination.exists())
        self.assertEqual(candidate.read_bytes(), b"new")

    def test_post_link_identity_swap_preserves_concurrent_destination(self) -> None:
        scratch = self.root / "promotion-identity-swap"
        scratch.mkdir()
        candidate = self.write("identity-staged.bin", b"new")
        racer = self.write("identity-racer.bin", b"concurrent")
        destination = self.root / "identity-final.bin"
        real_capture = motion.OwnedPath.capture
        real_replace = motion.os.replace
        swapped = False

        def swap_before_destination_capture(path: Path, label: str) -> object:
            nonlocal swapped
            if path == destination and not swapped:
                swapped = True
                real_replace(racer, destination)
            return real_capture(path, label)

        with mock.patch.object(motion.OwnedPath, "capture", side_effect=swap_before_destination_capture):
            with self.assertRaises(motion.RollbackError):
                motion.promote_output_bundle(
                    [(candidate, destination)],
                    scratch,
                    replace=False,
                )

        self.assertEqual(destination.read_bytes(), b"concurrent")
        self.assertEqual(candidate.read_bytes(), b"new")

    def test_rollback_preserves_concurrent_replacement_and_retains_old_backup(self) -> None:
        staged, destinations, scratch = self.make_bundle()
        racer = self.write("concurrent-replacement.bin", b"concurrent")
        real_link = motion.os.link
        real_replace = motion.os.replace
        calls = 0

        def replace_then_fail(source: object, target: object, **kwargs: object) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                real_replace(racer, destinations[0])
                raise OSError("synthetic promotion failure after concurrent replacement")
            real_link(source, target, **kwargs)

        with mock.patch.object(motion.os, "link", side_effect=replace_then_fail):
            with self.assertRaises(motion.RollbackError):
                motion.promote_output_bundle(staged, scratch, replace=True)

        self.assertEqual(destinations[0].read_bytes(), b"concurrent")
        self.assertEqual([path.read_bytes() for path in destinations[1:]], [
            b"old-1", b"old-2", b"old-3",
        ])
        retained = [path for path in scratch.glob("*.rollback") if path.read_bytes() == b"old-0"]
        self.assertEqual(len(retained), 1)

    def test_post_promotion_verification_failure_restores_complete_old_bundle(self) -> None:
        staged, destinations, scratch = self.make_bundle()

        def reject() -> None:
            raise motion.GateError("synthetic final verification failure")

        with self.assertRaises(motion.GateError):
            motion.promote_output_bundle(
                staged,
                scratch,
                replace=True,
                verify_promoted=reject,
            )
        self.assertEqual([path.read_bytes() for path in destinations], [
            b"old-0", b"old-1", b"old-2", b"old-3",
        ])

    def test_production_tool_resolution_ignores_external_path_shim(self) -> None:
        environment_name = motion.TRUSTED_EXECUTABLE_ENV["ffmpeg"]
        with tempfile.TemporaryDirectory(prefix="memoryagent-path-shim-") as temp_name:
            shim = Path(temp_name) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            shim.write_bytes(b"external path shim")
            shim.chmod(0o700)
            self.assertFalse(shim.resolve().is_relative_to(ROOT.resolve()))
            with (
                mock.patch.dict(os.environ, {environment_name: ""}, clear=False),
                mock.patch.object(motion.shutil, "which", return_value=str(shim)) as which,
            ):
                with self.assertRaisesRegex(motion.GateError, environment_name):
                    motion.resolve_trusted_executable("ffmpeg", allow_discovery=False)
            which.assert_not_called()

    def test_fixture_discovery_rejects_ambiguous_external_path_shims(self) -> None:
        environment_name = motion.TRUSTED_EXECUTABLE_ENV["git"]
        with (
            tempfile.TemporaryDirectory(prefix="memoryagent-path-shim-a-") as first_name,
            tempfile.TemporaryDirectory(prefix="memoryagent-path-shim-b-") as second_name,
        ):
            for directory in (Path(first_name), Path(second_name)):
                shim = directory / motion._trusted_executable_filename("git")
                shim.write_bytes(b"fixture-only git path shim")
                shim.chmod(0o700)
            with mock.patch.dict(
                os.environ,
                {environment_name: "", "PATH": first_name + os.pathsep + second_name},
                clear=False,
            ):
                with self.assertRaisesRegex(motion.GateError, "exactly one complete non-reparse PATH candidate"):
                    motion.resolve_trusted_executable("git", allow_discovery=True)

    def test_explicit_absolute_tool_binding_records_identity(self) -> None:
        environment_name = motion.TRUSTED_EXECUTABLE_ENV["ffmpeg"]
        with tempfile.TemporaryDirectory(prefix="memoryagent-trusted-tool-") as temp_name:
            executable = Path(temp_name) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            executable.write_bytes(b"explicit trusted executable fixture")
            executable.chmod(0o700)
            with mock.patch.dict(os.environ, {environment_name: str(executable)}, clear=False):
                trusted = motion.resolve_trusted_executable("ffmpeg", allow_discovery=False)
                record = trusted.verified_record()
        self.assertEqual(record["trustSource"], environment_name)
        self.assertEqual(
            record["sha256"],
            hashlib.sha256(b"explicit trusted executable fixture").hexdigest(),
        )
        self.assertEqual(record["size"], len(b"explicit trusted executable fixture"))
        self.assertEqual(record["linkCount"], 1)

    def test_trusted_media_toolchain_rejects_split_directories(self) -> None:
        with tempfile.TemporaryDirectory(prefix="memoryagent-split-toolchain-") as temp_name:
            root = Path(temp_name)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            paths = {
                "git": first / motion._trusted_executable_filename("git"),
                "ffmpeg": first / motion._trusted_executable_filename("ffmpeg"),
                "ffprobe": second / motion._trusted_executable_filename("ffprobe"),
            }
            for name, path in paths.items():
                path.write_bytes(f"trusted {name} fixture".encode("ascii"))
                path.chmod(0o700)
            environment = {
                motion.TRUSTED_EXECUTABLE_ENV[name]: str(path)
                for name, path in paths.items()
            }
            with mock.patch.dict(os.environ, environment, clear=False):
                with self.assertRaisesRegex(motion.GateError, "sibling files"):
                    motion.trusted_toolchain_records(allow_discovery=False)

    def test_explicit_tool_binding_rejects_hardlinked_alias(self) -> None:
        for name in ("ffmpeg", "ffprobe"):
            motion.clear_trusted_executable_cache()
            environment_name = motion.TRUSTED_EXECUTABLE_ENV[name]
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix="memoryagent-hardlinked-tool-") as temp_name:
                executable = Path(temp_name) / motion._trusted_executable_filename(name)
                alias = Path(temp_name) / "mutable-tool-alias"
                executable.write_bytes(b"hardlinked executable fixture")
                executable.chmod(0o700)
                os.link(executable, alias)
                with mock.patch.dict(os.environ, {environment_name: str(executable)}, clear=False):
                    with self.assertRaisesRegex(motion.GateError, "exactly one filesystem link"):
                        motion.resolve_trusted_executable(name, allow_discovery=False)

    def test_explicit_git_hardlink_uses_absolute_argv_and_rejects_content_drift(self) -> None:
        environment_name = motion.TRUSTED_EXECUTABLE_ENV["git"]
        with tempfile.TemporaryDirectory(prefix="memoryagent-hardlinked-git-") as temp_name:
            executable = Path(temp_name) / motion._trusted_executable_filename("git")
            executable.write_bytes(b"trusted git fixture v1\n")
            executable.chmod(0o700)
            os.link(executable, Path(temp_name) / "distribution-git-hardlink")
            with mock.patch.dict(os.environ, {environment_name: str(executable)}, clear=False):
                trusted = motion.resolve_trusted_executable("git", allow_discovery=False)
                self.assertEqual(trusted.link_count, 2)
                self.assertEqual(trusted.record()["linkCount"], 2)
                completed = subprocess.CompletedProcess([], 0, stdout=b"git version fixture\n", stderr=b"")
                with mock.patch.object(motion.subprocess, "run", return_value=completed) as run:
                    result = motion._run_git(["--version"])
                self.assertEqual(result.returncode, 0)
                argv = run.call_args.args[0]
                self.assertEqual(Path(argv[0]), executable.resolve(strict=True))
                self.assertNotEqual(argv[0], "git")
                self.assertEqual(argv[1:], ["--version"])

                executable.write_bytes(b"trusted git fixture v2\n")
                executable.chmod(0o700)
                with self.assertRaisesRegex(motion.GateError, "changed bytes after resolution"):
                    trusted.verified_record()

    def test_explicit_tool_binding_rejects_reparse_path_component(self) -> None:
        environment_name = motion.TRUSTED_EXECUTABLE_ENV["ffmpeg"]
        with tempfile.TemporaryDirectory(prefix="memoryagent-reparse-tool-") as temp_name:
            root = Path(temp_name)
            actual = root / "actual"
            actual.mkdir()
            executable = actual / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            executable.write_bytes(b"reparse executable fixture")
            executable.chmod(0o700)
            alias = root / "alias"
            try:
                alias.symlink_to(actual, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"directory symlinks are unavailable: {exc}")
            with mock.patch.dict(os.environ, {environment_name: str(alias / executable.name)}, clear=False):
                with self.assertRaisesRegex(motion.GateError, "symlink or reparse point"):
                    motion.resolve_trusted_executable("ffmpeg", allow_discovery=False)

    def test_claim_boundary_requires_exact_release_language(self) -> None:
        motion.validate_final_claim_boundary(motion.CLAIM_BOUNDARY)
        with self.assertRaisesRegex(motion.GateError, "claim boundary"):
            motion.validate_final_claim_boundary(motion.CLAIM_BOUNDARY + " altered")

    def test_release_critical_source_inventory_is_exact(self) -> None:
        self.assertEqual(set(motion.RELEASE_SOURCE_RELS), {
            "demo/tools/build_local_narration.py",
            "demo/tools/build_elevenlabs_narration.py",
            "demo/tools/build_caption_video.py",
            "demo/tools/record_live_motion.py",
            "demo/tools/compose_real_motion_video.py",
            "demo/tools/build_real_motion_submission.py",
            "scripts/repo_paths.py",
            "scripts/exact_deploy_evidence.py",
            "scripts/capture_submission_gallery.py",
        })


if __name__ == "__main__":
    unittest.main()
