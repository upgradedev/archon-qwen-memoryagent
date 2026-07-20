"""Focused offline regressions for the private live-motion recorder bundle."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock
import uuid


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "demo" / "tools"
sys.path.insert(0, str(TOOLS))
MODULE_PATH = TOOLS / "record_live_motion.py"
SPEC = importlib.util.spec_from_file_location("memoryagent_live_motion_recorder", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
recorder = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = recorder
SPEC.loader.exec_module(recorder)


class LiveMotionRecorderTests(unittest.TestCase):
    SHA = "1" * 40

    def setUp(self) -> None:
        self.root = (
            ROOT
            / ".artifacts"
            / "final-video"
            / "memory-recorder-selftest"
            / f"unit-{os.getpid()}-{uuid.uuid4().hex}"
        )
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def fixture_evidence(self) -> Path:
        path = self.root / "CAPTURE_REVIEW.json"
        path.write_text(json.dumps({"exactRuntimeSource": self.SHA}) + "\n", encoding="utf-8")
        return path

    @staticmethod
    def fake_runtime_reset(runtime: Path):
        def reset(relative_path: str, label: str) -> Path:
            if relative_path != recorder.RECORDING_RUNTIME_ROOT or label != "recording runtime":
                raise AssertionError((relative_path, label))
            shutil.rmtree(runtime, ignore_errors=True)
            return runtime

        return reset

    @staticmethod
    def fake_browser_capture(*, run_root: Path, poster: Path, **_kwargs: object):
        raw = run_root / "playwright-raw.webm"
        raw.write_bytes(b"private-browser-video" * 700)
        poster.write_bytes(b"private-poster")
        return raw, [{"atSeconds": 0.0, "action": "fixture"}], {"fixture": True}

    def test_reviewed_question_accepts_crlf_worktree_against_lf_head(self) -> None:
        source_bytes = recorder.CAPTURE_QUESTION_SOURCE.read_bytes()
        lf_source = recorder.normalize_git_output(source_bytes)
        crlf_source = lf_source.replace(b"\n", b"\r\n")
        snapshot = SimpleNamespace(
            data=crlf_source,
            sha256=hashlib.sha256(crlf_source).hexdigest(),
        )
        git_result = subprocess.CompletedProcess([], 0, stdout=lf_source, stderr=b"")

        with (
            mock.patch.object(recorder, "read_project_file_once", return_value=snapshot),
            mock.patch.object(recorder, "_run_git", return_value=git_result),
        ):
            question, source_sha = recorder.reviewed_capture_question()

        self.assertEqual(question, recorder.EXPECTED_CAPTURE_QUESTION)
        self.assertEqual(source_sha, snapshot.sha256)

    def test_reviewed_question_rejects_semantic_head_drift(self) -> None:
        source_bytes = recorder.normalize_git_output(recorder.CAPTURE_QUESTION_SOURCE.read_bytes())
        drifted_head = source_bytes.replace(b"Northwind Trading", b"Contoso Trading", 1)
        snapshot = SimpleNamespace(
            data=source_bytes,
            sha256=hashlib.sha256(source_bytes).hexdigest(),
        )
        git_result = subprocess.CompletedProcess([], 0, stdout=drifted_head, stderr=b"")
        with (
            mock.patch.object(recorder, "read_project_file_once", return_value=snapshot),
            mock.patch.object(recorder, "_run_git", return_value=git_result),
            self.assertRaisesRegex(recorder.CaptureError, "differs from final source HEAD"),
        ):
            recorder.reviewed_capture_question()

    def test_git_resolution_never_consults_cwd_or_path_shims(self) -> None:
        cwd_shim = self.root / ("git.exe" if os.name == "nt" else "git")
        path_root = self.root / "early-path"
        path_root.mkdir()
        path_shim = path_root / cwd_shim.name
        cwd_shim.write_bytes(b"inert cwd shim")
        path_shim.write_bytes(b"inert PATH shim")

        original_cwd = Path.cwd()
        try:
            os.chdir(self.root)
            with (
                mock.patch.dict(
                    os.environ,
                    {"PATH": str(path_root)},
                    clear=False,
                ),
                mock.patch.object(
                    recorder.shutil,
                    "which",
                    return_value="C:/attacker-controlled-path/git.exe",
                ) as which,
            ):
                os.environ.pop(recorder.TRUSTED_GIT_ENV, None)
                with self.assertRaisesRegex(recorder.CaptureError, recorder.TRUSTED_GIT_ENV):
                    recorder.trusted_git()
                which.assert_not_called()
        finally:
            os.chdir(original_cwd)

    def test_reviewed_question_invokes_only_absolute_identity_bound_git_argv(self) -> None:
        source_bytes = recorder.CAPTURE_QUESTION_SOURCE.read_bytes()
        snapshot = SimpleNamespace(
            data=source_bytes,
            sha256=hashlib.sha256(source_bytes).hexdigest(),
        )
        git_path = Path("C:/Program Files/Git/cmd/git.exe") if os.name == "nt" else Path("/opt/trusted/git")
        trusted = SimpleNamespace(path=git_path, assert_unchanged=mock.Mock())
        git_result = subprocess.CompletedProcess([], 0, stdout=source_bytes, stderr=b"")

        with (
            mock.patch.object(recorder, "read_project_file_once", return_value=snapshot),
            mock.patch.object(recorder, "trusted_git", return_value=trusted),
            mock.patch.object(recorder.subprocess, "run", return_value=git_result) as run,
        ):
            recorder.reviewed_capture_question()

        argv = run.call_args.args[0]
        self.assertTrue(Path(argv[0]).is_absolute())
        self.assertEqual(
            argv,
            [
                str(git_path),
                "-C",
                str(recorder.ROOT),
                "show",
                "HEAD:scripts/capture_submission_gallery.py",
            ],
        )
        self.assertEqual(run.call_args.kwargs["cwd"], recorder.ROOT)
        self.assertIs(run.call_args.kwargs["shell"], False)
        self.assertEqual(trusted.assert_unchanged.call_count, 2)

    def test_canonical_private_capture_paths_are_accepted(self) -> None:
        recorder.validate_capture_paths(
            evidence_path=ROOT / recorder.CANONICAL_CAPTURE_REVIEW,
            output=self.root / "interaction.webm",
            manifest_path=self.root / "interaction.manifest.json",
            poster=self.root / "interaction-poster.png",
            fixture=False,
        )

    def test_public_aliased_overlapping_and_runtime_outputs_are_rejected(self) -> None:
        evidence = ROOT / recorder.CANONICAL_CAPTURE_REVIEW
        valid_manifest = self.root / "interaction.manifest.json"
        valid_poster = self.root / "interaction-poster.png"
        cases = (
            {
                "output": ROOT / "demo" / "final-media" / "raw.webm",
                "manifest_path": valid_manifest,
                "poster": valid_poster,
            },
            {
                "output": self.root / "same.webm",
                "manifest_path": self.root / "same.webm",
                "poster": valid_poster,
            },
            {
                "output": self.root / "parent.webm",
                "manifest_path": valid_manifest,
                "poster": self.root / "parent.webm" / "poster.png",
            },
            {
                "output": ROOT / recorder.RECORDING_RUNTIME_ROOT / "raw.webm",
                "manifest_path": valid_manifest,
                "poster": valid_poster,
            },
        )
        for paths in cases:
            with self.subTest(paths=paths), self.assertRaises(recorder.CaptureError):
                recorder.validate_capture_paths(
                    evidence_path=evidence,
                    fixture=False,
                    **paths,
                )

    def test_existing_hardlink_alias_is_rejected(self) -> None:
        original = self.root / "evidence.json"
        alias = self.root / "alias.json"
        original.write_text("{}\n", encoding="utf-8")
        try:
            os.link(original, alias)
        except OSError as exc:
            self.skipTest(f"hard links unavailable: {exc}")
        with self.assertRaisesRegex(recorder.CaptureError, "exactly one hard link"):
            recorder.project_path(original, "evidence", exists=True)

    def test_owned_path_rejects_changed_bytes_even_when_filesystem_identity_is_stable(self) -> None:
        path = self.root / "owned.bin"
        path.write_bytes(b"original-owned-bytes")
        owner = recorder.OwnedPath.capture(path, "owned fixture")
        before = path.stat()
        path.write_bytes(b"replaced-owned-bytes")
        after = path.stat()
        self.assertEqual((before.st_dev, before.st_ino), (after.st_dev, after.st_ino))
        self.assertEqual(len(b"original-owned-bytes"), len(b"replaced-owned-bytes"))
        self.assertFalse(owner.still_owned())

    def test_symlink_alias_is_rejected_when_supported(self) -> None:
        original = self.root / "evidence.json"
        alias = self.root / "alias.json"
        original.write_text("{}\n", encoding="utf-8")
        try:
            os.symlink(original, alias)
        except OSError:
            synthetic_link = SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0)
            self.assertTrue(recorder._is_symlink_or_reparse(synthetic_link))
            return
        with self.assertRaisesRegex(recorder.CaptureError, "symlink or reparse point"):
            recorder.project_path(alias, "evidence", exists=True)

    def test_parent_traversal_spelling_is_rejected_before_resolution(self) -> None:
        with self.assertRaisesRegex(recorder.CaptureError, "parent traversal"):
            recorder.project_path(
                ".artifacts/final-video/../final-video/alias.webm",
                "output",
            )

    def test_windows_device_and_stream_spellings_are_rejected(self) -> None:
        for path in (
            ".artifacts/final-video/CON.webm",
            ".artifacts/final-video/interaction.webm:alternate",
            ".artifacts/final-video/trailing-dot./interaction.webm",
        ):
            with self.subTest(path=path), self.assertRaises(recorder.CaptureError):
                recorder.project_path(path, "output")

    def test_network_guard_blocks_wss_off_origin_and_redirected_requests(self) -> None:
        guard = recorder.network_guard(recorder.DEFAULT_URL)
        cases = (
            (f"{recorder.DEFAULT_URL}/app.js", None, False),
            ("wss://memory.43.106.13.19.sslip.io/socket", None, True),
            ("https://example.invalid/tracker", None, True),
            (f"{recorder.DEFAULT_URL}/redirect-target", object(), True),
        )
        for url, redirected_from, should_abort in cases:
            route = SimpleNamespace(
                request=SimpleNamespace(url=url, redirected_from=redirected_from),
                abort=mock.Mock(),
                continue_=mock.Mock(),
            )
            with self.subTest(url=url, redirected=redirected_from is not None):
                guard(route)
                if should_abort:
                    route.abort.assert_called_once_with()
                    route.continue_.assert_not_called()
                else:
                    route.continue_.assert_called_once_with()
                    route.abort.assert_not_called()

    def test_live_context_blocks_service_workers_and_every_websocket(self) -> None:
        options = recorder.browser_context_options(self.root / "runtime")
        self.assertEqual(options["service_workers"], "block")
        self.assertIs(options["ignore_https_errors"], False)

        context = mock.Mock()
        recorder.configure_live_context(context, recorder.DEFAULT_URL)
        context.route_web_socket.assert_called_once()
        pattern, handler = context.route_web_socket.call_args.args
        self.assertEqual(pattern, "**/*")
        websocket = mock.Mock()
        handler(websocket)
        websocket.close.assert_called_once_with(
            code=1008,
            reason="network destination not permitted",
        )

    def test_production_chromium_enables_sandbox_and_rejects_every_disabling_flag(self) -> None:
        options = recorder.chromium_launch_options(recorder.PRODUCTION_BROWSER_MODE)
        self.assertIs(options["chromium_sandbox"], True)
        self.assertEqual(options["args"], [])
        self.assertFalse({
            argument.lower().split("=", 1)[0]
            for argument in options["args"]
        }.intersection(recorder.SANDBOX_DISABLING_CHROMIUM_FLAGS))

        for flag in recorder.SANDBOX_DISABLING_CHROMIUM_FLAGS:
            with (
                self.subTest(flag=flag),
                mock.patch.object(
                    recorder,
                    "PRODUCTION_CHROMIUM_ARGS",
                    (flag.upper() + "=true",),
                ),
                self.assertRaisesRegex(recorder.CaptureError, "must not disable"),
            ):
                recorder.chromium_launch_options(recorder.PRODUCTION_BROWSER_MODE)

    def test_production_capture_passes_only_sandboxed_options_to_chromium(self) -> None:
        chromium = mock.Mock()
        chromium.launch.side_effect = RuntimeError("stop after Chromium launch")
        playwright = SimpleNamespace(chromium=chromium)
        manager = mock.MagicMock()
        manager.__enter__.return_value = playwright

        with (
            mock.patch.object(recorder, "sync_playwright", return_value=manager),
            self.assertRaisesRegex(RuntimeError, "stop after Chromium launch"),
        ):
            recorder.capture_browser_video(
                run_root=self.root / "production-launch-runtime",
                poster=self.root / "production-launch-poster.png",
                fixture=False,
                base_url=recorder.DEFAULT_URL,
                canonical_question=recorder.EXPECTED_CAPTURE_QUESTION,
            )

        chromium.launch.assert_called_once_with(
            headless=True,
            chromium_sandbox=True,
            args=[],
        )

    def test_sandbox_bypass_is_confined_to_labelled_nonproduction_fixture(self) -> None:
        self.assertEqual(
            recorder.FIXTURE_SELF_TEST_BROWSER_MODE,
            "offline-fixture-self-test-non-production",
        )
        options = recorder.chromium_launch_options(recorder.FIXTURE_SELF_TEST_BROWSER_MODE)
        self.assertIs(options["chromium_sandbox"], False)
        self.assertEqual(options["args"], ["--no-sandbox"])
        self.assertNotEqual(
            recorder.FIXTURE_SELF_TEST_BROWSER_MODE,
            recorder.PRODUCTION_BROWSER_MODE,
        )

    def test_seed_disables_redirects_and_rejects_changed_response_url(self) -> None:
        request = mock.Mock()
        request.post.return_value = SimpleNamespace(
            url=f"{recorder.DEFAULT_URL}/redirected-seed",
            ok=True,
            status=200,
        )
        context = SimpleNamespace(request=request)

        with self.assertRaisesRegex(recorder.CaptureError, "response URL changed"):
            recorder.seed_public_demo(context, recorder.DEFAULT_URL)

        request.post.assert_called_once_with(
            f"{recorder.DEFAULT_URL}/demo/seed",
            data="{}",
            headers={"content-type": "application/json"},
            max_redirects=0,
        )

    def test_live_recall_proof_requires_exact_fields_and_types(self) -> None:
        proof = {
            "question": recorder.EXPECTED_CAPTURE_QUESTION,
            "company": "Northwind Trading",
            "requestLimit": 3,
            "modelId": "qwen-plus",
            "grounding": {"status": "passed", "attempts": 1},
            "citationCount": 2,
            "answerSha256": "a" * 64,
        }
        recorder.validate_recall_proof(proof, recorder.EXPECTED_CAPTURE_QUESTION, fixture=False)
        for invalid in (
            {**proof, "reviewerCredentialUsed": False},
            {**proof, "requestLimit": True},
            {**proof, "citationCount": True},
            {**proof, "grounding": {"status": "passed", "attempts": 2}},
            {**proof, "answerSha256": "A" * 64},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(recorder.CaptureError):
                recorder.validate_recall_proof(invalid, recorder.EXPECTED_CAPTURE_QUESTION, fixture=False)

    def test_production_evidence_requires_exact_deploy_and_hidden_credential_gates(self) -> None:
        payload = {
            "schemaVersion": 3,
            "status": "passed",
            "exactRuntimeSource": self.SHA,
            "liveBaseUrl": recorder.DEFAULT_URL,
            "deploymentEvidence": {"mode": "strict-final-marker"},
            "gates": {
                "reviewerCredentialRendered": False,
                "exactDeploymentEvidence": True,
                "exactDeploymentEvidenceMode": "strict-final-marker",
            },
        }
        self.assertIs(recorder.production_evidence(payload, self.SHA, recorder.DEFAULT_URL), payload)
        for mutation in (
            {"schemaVersion": 2},
            {"gates": {**payload["gates"], "reviewerCredentialRendered": True}},
            {"gates": {**payload["gates"], "exactDeploymentEvidence": False}},
            {"deploymentEvidence": {"mode": "self-attested"}},
        ):
            invalid = {**payload, **mutation}
            with self.subTest(mutation=mutation), self.assertRaises(recorder.CaptureError):
                recorder.production_evidence(invalid, self.SHA, recorder.DEFAULT_URL)

    def test_self_test_fixture_discovery_restores_compose_environment_and_cache_on_failure(self) -> None:
        environment_names = tuple(
            recorder.video_qa.TRUSTED_EXECUTABLE_ENV[name]
            for name in ("ffmpeg", "ffprobe")
        )
        missing = object()
        original_environment = {
            name: os.environ.get(name, missing) for name in environment_names
        }
        original_cache = dict(recorder.video_qa._TRUSTED_EXECUTABLE_CACHE)
        previous_cache_marker = object()
        previous_cache = {"git": previous_cache_marker}
        discovered: list[str] = []

        def fixture_discovery(name: str, *, allow_discovery: bool = False) -> object:
            self.assertTrue(allow_discovery)
            self.assertNotIn(recorder.video_qa.TRUSTED_EXECUTABLE_ENV[name], os.environ)
            discovered.append(name)
            token = object()
            recorder.video_qa._TRUSTED_EXECUTABLE_CACHE[name] = token
            return token

        try:
            recorder.video_qa.clear_trusted_executable_cache()
            recorder.video_qa._TRUSTED_EXECUTABLE_CACHE.update(previous_cache)
            for index, name in enumerate(environment_names, start=1):
                os.environ[name] = f"original-binding-{index}"
            self_test_root = self.root / "scoped-self-test"
            with (
                mock.patch.object(
                    recorder.video_qa,
                    "resolve_trusted_executable",
                    side_effect=fixture_discovery,
                ),
                mock.patch.object(
                    recorder.video_qa,
                    "safe_reset_artifact_directory",
                    return_value=self_test_root,
                ),
                mock.patch.object(
                    recorder,
                    "capture",
                    side_effect=recorder.CaptureError("synthetic self-test failure"),
                ),
                self.assertRaisesRegex(recorder.CaptureError, "synthetic self-test failure"),
            ):
                recorder.self_test()

            self.assertEqual(discovered, ["ffmpeg", "ffprobe"])
            self.assertEqual(
                {name: os.environ.get(name) for name in environment_names},
                {name: f"original-binding-{index}" for index, name in enumerate(environment_names, start=1)},
            )
            self.assertEqual(recorder.video_qa._TRUSTED_EXECUTABLE_CACHE, previous_cache)
            self.assertIs(
                recorder.video_qa._TRUSTED_EXECUTABLE_CACHE["git"],
                previous_cache_marker,
            )
        finally:
            recorder.video_qa.clear_trusted_executable_cache()
            recorder.video_qa._TRUSTED_EXECUTABLE_CACHE.update(original_cache)
            for name, value in original_environment.items():
                if value is missing:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = str(value)

    def test_fixture_capture_promotes_complete_private_bundle_and_exact_safety_fields(self) -> None:
        evidence = self.fixture_evidence()
        output = self.root / "fixture.webm"
        manifest_path = self.root / "fixture.manifest.json"
        poster = self.root / "fixture-poster.png"
        runtime = self.root / "runtime"
        media = {
            "durationSeconds": 5.0,
            "width": 1920,
            "height": 1080,
            "audioStreamCount": 0,
            "videoCodec": "vp8",
        }
        motion = {"uniqueFrames": 10, "sampledFrames": 10, "uniqueRatio": 1.0}
        with (
            mock.patch.object(
                recorder.video_qa,
                "safe_reset_artifact_directory",
                side_effect=self.fake_runtime_reset(runtime),
            ),
            mock.patch.object(recorder, "capture_browser_video", side_effect=self.fake_browser_capture),
            mock.patch.object(recorder.video_qa, "media_summary", return_value=media),
            mock.patch.object(recorder.video_qa, "diversity", return_value=motion),
        ):
            manifest = recorder.capture(
                expected_sha=self.SHA,
                evidence_path=evidence,
                base_url=recorder.DEFAULT_URL,
                output=output,
                manifest_path=manifest_path,
                poster=poster,
                replace=False,
                fixture=True,
            )

        self.assertTrue(output.is_file())
        self.assertTrue(poster.is_file())
        self.assertEqual(json.loads(manifest_path.read_text(encoding="utf-8")), manifest)
        self.assertFalse(runtime.exists())
        self.assertEqual(
            (manifest["reviewerCredentialRendered"], manifest["reviewerCredentialUsed"],
             manifest["durableReviewerWritesCreated"]),
            (False, False, False),
        )
        self.assertEqual(set(manifest["recorderSource"]), {"path", "sha256", "size"})
        self.assertEqual(manifest["rawVideo"]["path"], recorder.relative(output))
        self.assertEqual(manifest["poster"]["path"], recorder.relative(poster))

    def test_validation_failure_removes_runtime_and_leaves_no_partial_bundle(self) -> None:
        evidence = self.fixture_evidence()
        output = self.root / "failed.webm"
        manifest_path = self.root / "failed.manifest.json"
        poster = self.root / "failed-poster.png"
        runtime = self.root / "runtime"
        with (
            mock.patch.object(
                recorder.video_qa,
                "safe_reset_artifact_directory",
                side_effect=self.fake_runtime_reset(runtime),
            ),
            mock.patch.object(recorder, "capture_browser_video", side_effect=self.fake_browser_capture),
            mock.patch.object(
                recorder.video_qa,
                "media_summary",
                side_effect=recorder.CaptureError("synthetic validation failure"),
            ),
            self.assertRaisesRegex(recorder.CaptureError, "synthetic validation failure"),
        ):
            recorder.capture(
                expected_sha=self.SHA,
                evidence_path=evidence,
                base_url=recorder.DEFAULT_URL,
                output=output,
                manifest_path=manifest_path,
                poster=poster,
                replace=False,
                fixture=True,
            )

        self.assertFalse(runtime.exists())
        self.assertFalse(output.exists())
        self.assertFalse(poster.exists())
        self.assertFalse(manifest_path.exists())

    def test_destination_appearing_after_preflight_is_never_overwritten(self) -> None:
        scratch = self.root / "appearance-scratch"
        scratch.mkdir()
        staged = [scratch / "new.webm", scratch / "new.png", scratch / "new.json"]
        destinations = [self.root / "out.webm", self.root / "out.png", self.root / "out.json"]
        for path, data in zip(staged, (b"new-video", b"new-poster", b"new-manifest"), strict=True):
            path.write_bytes(data)

        real_move = recorder._move_no_overwrite
        appeared = b"concurrently-created-video"
        injected = False

        def inject_appearance(source: str | Path, destination: str | Path) -> None:
            nonlocal injected
            source_path = Path(source)
            destination_path = Path(destination)
            if not injected and source_path == staged[0] and destination_path == destinations[0]:
                injected = True
                destination_path.write_bytes(appeared)
            real_move(source_path, destination_path)

        with (
            mock.patch.object(recorder, "_move_no_overwrite", side_effect=inject_appearance),
            self.assertRaises(FileExistsError),
        ):
            recorder.promote_recorder_bundle(
                tuple(zip(staged, destinations, strict=True)),
                scratch,
                replace=False,
            )

        self.assertEqual(destinations[0].read_bytes(), appeared)
        self.assertTrue(all(not path.exists() for path in destinations[1:]))
        self.assertTrue(all(not path.exists() for path in staged))

    def test_post_move_verification_failure_leaves_no_untracked_output(self) -> None:
        scratch = self.root / "post-move-scratch"
        scratch.mkdir()
        staged = [scratch / "new.webm", scratch / "new.png", scratch / "new.json"]
        destinations = [self.root / "out.webm", self.root / "out.png", self.root / "out.json"]
        for path, data in zip(staged, (b"new-video", b"new-poster", b"new-manifest"), strict=True):
            path.write_bytes(data)

        real_still_owned = recorder.OwnedPath.still_owned
        injected = False

        def fail_first_promoted_verification(owner: object) -> bool:
            nonlocal injected
            assert isinstance(owner, recorder.OwnedPath)
            if not injected and owner.path == destinations[0]:
                injected = True
                raise recorder.CaptureError("synthetic post-move identity verification failure")
            return real_still_owned(owner)

        with (
            mock.patch.object(
                recorder.OwnedPath,
                "still_owned",
                autospec=True,
                side_effect=fail_first_promoted_verification,
            ),
            self.assertRaisesRegex(recorder.CaptureError, "post-move identity verification failure"),
        ):
            recorder.promote_recorder_bundle(
                tuple(zip(staged, destinations, strict=True)),
                scratch,
                replace=False,
            )

        self.assertTrue(all(not path.exists() for path in destinations))
        self.assertTrue(all(not path.exists() for path in staged))
        self.assertEqual(list(self.root.glob("*.failed-promotion")), [])

    def test_backup_verification_failure_before_caller_ownership_restores_destination(self) -> None:
        scratch = self.root / "backup-window-scratch"
        scratch.mkdir()
        staged = [scratch / "new.webm", scratch / "new.png", scratch / "new.json"]
        destinations = [self.root / "old.webm", self.root / "old.png", self.root / "old.json"]
        old_bytes = [b"old-video", b"old-poster", b"old-manifest"]
        for path, data in zip(staged, (b"new-video", b"new-poster", b"new-manifest"), strict=True):
            path.write_bytes(data)
        for path, data in zip(destinations, old_bytes, strict=True):
            path.write_bytes(data)

        real_still_owned = recorder.OwnedPath.still_owned
        injected = False

        def fail_first_backup_verification(owner: object) -> bool:
            nonlocal injected
            assert isinstance(owner, recorder.OwnedPath)
            if not injected and owner.path.suffix == ".rollback":
                injected = True
                raise recorder.CaptureError("synthetic backup identity verification failure")
            return real_still_owned(owner)

        with (
            mock.patch.object(
                recorder.OwnedPath,
                "still_owned",
                autospec=True,
                side_effect=fail_first_backup_verification,
            ),
            self.assertRaisesRegex(recorder.CaptureError, "backup identity verification failure"),
        ):
            recorder.promote_recorder_bundle(
                tuple(zip(staged, destinations, strict=True)),
                scratch,
                replace=True,
            )

        self.assertEqual([path.read_bytes() for path in destinations], old_bytes)
        self.assertTrue(all(not path.exists() for path in staged))
        self.assertEqual(list(self.root.glob("*.rollback")), [])

    def test_rollback_preserves_a_concurrently_replaced_destination_and_old_backup(self) -> None:
        scratch = self.root / "rollback-race-scratch"
        scratch.mkdir()
        staged = [scratch / "new.webm", scratch / "new.png", scratch / "new.json"]
        destinations = [self.root / "old.webm", self.root / "old.png", self.root / "old.json"]
        old_bytes = [b"old-video", b"old-poster", b"old-manifest"]
        for path, data in zip(staged, (b"new-video", b"new-poster", b"new-manifest"), strict=True):
            path.write_bytes(data)
        for path, data in zip(destinations, old_bytes, strict=True):
            path.write_bytes(data)

        real_move = recorder._move_no_overwrite
        concurrent = b"concurrently-replaced-poster"

        def replace_poster_then_fail(source: str | Path, destination: str | Path) -> None:
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path == staged[-1]:
                destinations[1].unlink()
                destinations[1].write_bytes(concurrent)
                raise OSError("synthetic manifest promotion failure")
            real_move(source_path, destination_path)

        with mock.patch.object(recorder, "_move_no_overwrite", side_effect=replace_poster_then_fail):
            with self.assertRaisesRegex(
                recorder.CaptureError,
                "preserved concurrently appeared",
            ):
                recorder.promote_recorder_bundle(
                    tuple(zip(staged, destinations, strict=True)),
                    scratch,
                    replace=True,
                )

        self.assertEqual(destinations[0].read_bytes(), old_bytes[0])
        self.assertEqual(destinations[1].read_bytes(), concurrent)
        self.assertEqual(destinations[2].read_bytes(), old_bytes[2])
        retained_old_poster = [
            path for path in self.root.glob("*.rollback") if path.read_bytes() == old_bytes[1]
        ]
        self.assertEqual(len(retained_old_poster), 1)

    def test_promotion_failure_rolls_back_every_replaced_destination(self) -> None:
        scratch = self.root / "scratch"
        scratch.mkdir()
        staged = [scratch / "new.webm", scratch / "new.png", scratch / "new.json"]
        destinations = [self.root / "old.webm", self.root / "old.png", self.root / "old.json"]
        old_bytes = [b"old-video", b"old-poster", b"old-manifest"]
        new_bytes = [b"new-video", b"new-poster", b"new-manifest"]
        for path, data in zip(staged, new_bytes, strict=True):
            path.write_bytes(data)
        for path, data in zip(destinations, old_bytes, strict=True):
            path.write_bytes(data)

        real_move = recorder._move_no_overwrite

        def fail_manifest_promotion(source: str | Path, destination: str | Path) -> None:
            if Path(source) == staged[-1]:
                raise OSError("synthetic manifest promotion failure")
            real_move(Path(source), Path(destination))

        with (
            mock.patch.object(recorder, "_move_no_overwrite", side_effect=fail_manifest_promotion),
            self.assertRaisesRegex(OSError, "synthetic manifest promotion failure"),
        ):
            recorder.promote_recorder_bundle(
                tuple(zip(staged, destinations, strict=True)),
                scratch,
                replace=True,
            )

        self.assertEqual([path.read_bytes() for path in destinations], old_bytes)
        self.assertTrue(all(not path.exists() for path in staged))
        self.assertEqual(list(self.root.rglob("*.rollback")), [])

    def test_restore_failure_retains_the_unrestored_backup_bytes(self) -> None:
        scratch = self.root / "restore-failure-scratch"
        scratch.mkdir()
        staged = [scratch / "new.webm", scratch / "new.png", scratch / "new.json"]
        destinations = [self.root / "old.webm", self.root / "old.png", self.root / "old.json"]
        old_bytes = [b"old-video", b"only-copy-of-old-poster", b"old-manifest"]
        for path, data in zip(staged, (b"new-video", b"new-poster", b"new-manifest"), strict=True):
            path.write_bytes(data)
        for path, data in zip(destinations, old_bytes, strict=True):
            path.write_bytes(data)

        real_move = recorder._move_no_overwrite

        def fail_promotion_and_one_restore(source: str | Path, destination: str | Path) -> None:
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path == staged[-1]:
                raise OSError("synthetic manifest promotion failure")
            if destination_path == destinations[1] and source_path.suffix == ".rollback":
                raise OSError("synthetic poster restore failure")
            real_move(source_path, destination_path)

        with mock.patch.object(recorder, "_move_no_overwrite", side_effect=fail_promotion_and_one_restore):
            with self.assertRaisesRegex(
                recorder.CaptureError,
                "retained rollback files: .*rollback",
            ) as raised:
                recorder.promote_recorder_bundle(
                    tuple(zip(staged, destinations, strict=True)),
                    scratch,
                    replace=True,
                )

        self.assertIn("synthetic poster restore failure", str(raised.exception))
        self.assertEqual(destinations[0].read_bytes(), old_bytes[0])
        self.assertFalse(destinations[1].exists())
        self.assertEqual(destinations[2].read_bytes(), old_bytes[2])
        retained = list(self.root.glob("*.rollback"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0].read_bytes(), old_bytes[1])
        self.assertTrue(all(not path.exists() for path in staged))
        shutil.rmtree(scratch)
        self.assertTrue(retained[0].is_file())


if __name__ == "__main__":
    unittest.main()
