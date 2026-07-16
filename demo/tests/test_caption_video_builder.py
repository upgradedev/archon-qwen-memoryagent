"""Offline regression tests for the caption-led final-video builder."""

from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import traceback
import unittest
from unittest import mock
from urllib import error as urlerror
from urllib import request as urlrequest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "demo" / "tools" / "build_caption_video.py"
SPEC = importlib.util.spec_from_file_location("memoryagent_caption_video", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
builder = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = builder
SPEC.loader.exec_module(builder)

CAPTURE_MODULE_PATH = ROOT / "scripts" / "capture_submission_gallery.py"
CAPTURE_SPEC = importlib.util.spec_from_file_location("memoryagent_capture_gallery_contract", CAPTURE_MODULE_PATH)
assert CAPTURE_SPEC is not None and CAPTURE_SPEC.loader is not None
capture = importlib.util.module_from_spec(CAPTURE_SPEC)
sys.modules[CAPTURE_SPEC.name] = capture
CAPTURE_SPEC.loader.exec_module(capture)

from repo_paths import read_project_file_once


class FakeJsonResponse:
    """Small context-managed urllib response used by transport-only tests."""

    def __init__(self, payload: bytes, *, status: int = 200) -> None:
        self.payload = payload
        self.status = status
        self.headers = {"Content-Type": "application/json"}

    def __enter__(self) -> "FakeJsonResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.payload


class CaptureTransportRetryTests(unittest.TestCase):
    TOKEN = "reviewer-secret-that-must-never-leak-1234567890"

    def test_body_free_get_retries_transport_failure_on_exact_schedule(self) -> None:
        requests: list[urlrequest.Request] = []

        def open_once_then_succeed(req: urlrequest.Request, *, timeout: float) -> FakeJsonResponse:
            requests.append(req)
            self.assertEqual(timeout, 7.0)
            if len(requests) == 1:
                raise urlerror.URLError("temporary TCP connect timeout")
            return FakeJsonResponse(b'{"status":"ok"}')

        with (
            mock.patch.object(capture.NO_REDIRECT_OPENER, "open", side_effect=open_once_then_succeed),
            mock.patch.object(capture.time, "sleep") as sleep,
        ):
            payload, headers = capture.request_json(
                "GET",
                capture.DEFAULT_BASE_URL,
                "/health",
                reviewer_token=self.TOKEN,
                timeout=7.0,
            )

        self.assertEqual(payload, {"status": "ok"})
        self.assertEqual(headers, {"content-type": "application/json"})
        self.assertEqual(len(requests), 2)
        self.assertEqual(sleep.call_args_list, [mock.call(capture.GET_TRANSPORT_RETRY_DELAYS_SECONDS[0])])
        for req in requests:
            self.assertEqual(req.get_method(), "GET")
            self.assertEqual(req.full_url, capture.DEFAULT_BASE_URL + "/health")
            self.assertEqual(req.get_header("Authorization"), f"Bearer {self.TOKEN}")

    def test_get_transport_retry_is_bounded_and_scrubs_exception_details(self) -> None:
        transport = urlerror.URLError(f"upstream accidentally included {self.TOKEN}")
        with (
            mock.patch.object(capture.NO_REDIRECT_OPENER, "open", side_effect=transport) as open_mock,
            mock.patch.object(capture.time, "sleep") as sleep,
            self.assertRaises(capture.GateError) as raised,
        ):
            capture.request_json(
                "GET",
                capture.DEFAULT_BASE_URL,
                "/ready/deep",
                reviewer_token=self.TOKEN,
            )

        self.assertEqual(open_mock.call_count, capture.GET_TRANSPORT_MAX_ATTEMPTS)
        self.assertEqual(
            sleep.call_args_list,
            [mock.call(delay) for delay in capture.GET_TRANSPORT_RETRY_DELAYS_SECONDS],
        )
        message = str(raised.exception)
        self.assertEqual(
            message,
            f"GET /ready/deep was unreachable after {capture.GET_TRANSPORT_MAX_ATTEMPTS} transport attempts",
        )
        self.assertNotIn(self.TOKEN, message)
        self.assertNotIn(str(transport.reason), message)
        self.assertIsNone(raised.exception.__cause__)
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertNotIn(self.TOKEN, "".join(traceback.format_exception(raised.exception)))

    def test_each_supported_transport_exception_is_retryable_for_safe_get(self) -> None:
        cases = (
            urlerror.URLError("connect timeout"),
            TimeoutError("socket timeout"),
            OSError("connection reset"),
        )
        for transport in cases:
            with (
                self.subTest(transport=type(transport).__name__),
                mock.patch.object(
                    capture.NO_REDIRECT_OPENER,
                    "open",
                    side_effect=[transport, FakeJsonResponse(b'{"status":"ok"}')],
                ) as open_mock,
                mock.patch.object(capture.time, "sleep") as sleep,
            ):
                payload, _ = capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health")
            self.assertEqual(payload, {"status": "ok"})
            self.assertEqual(open_mock.call_count, 2)
            self.assertEqual(
                sleep.call_args_list,
                [mock.call(capture.GET_TRANSPORT_RETRY_DELAYS_SECONDS[0])],
            )

    def test_post_transport_failure_is_never_retried(self) -> None:
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            transport = urlerror.URLError(f"mutation failure {self.TOKEN}")
            with (
                self.subTest(method=method),
                mock.patch.object(capture.NO_REDIRECT_OPENER, "open", side_effect=transport) as open_mock,
                mock.patch.object(capture.time, "sleep") as sleep,
                self.assertRaises(capture.GateError) as raised,
            ):
                capture.request_json(
                    method,
                    capture.DEFAULT_BASE_URL,
                    "/demo/seed",
                    body={},
                    reviewer_token=self.TOKEN,
                )

            self.assertEqual(open_mock.call_count, 1)
            sleep.assert_not_called()
            self.assertEqual(str(raised.exception), f"{method} /demo/seed was unreachable")
            self.assertNotIn(self.TOKEN, str(raised.exception))
            self.assertIsNone(raised.exception.__cause__)

    def test_get_with_body_is_not_eligible_for_retry(self) -> None:
        with (
            mock.patch.object(
                capture.NO_REDIRECT_OPENER,
                "open",
                side_effect=urlerror.URLError("transport failure"),
            ) as open_mock,
            mock.patch.object(capture.time, "sleep") as sleep,
            self.assertRaises(capture.GateError),
        ):
            capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health", body={})

        self.assertEqual(open_mock.call_count, 1)
        sleep.assert_not_called()

    def test_http_errors_and_redirects_are_never_retried(self) -> None:
        cases = (
            (503, "GET /health returned HTTP 503"),
            (302, "GET /health attempted a forbidden HTTP redirect"),
        )
        for code, expected in cases:
            error = urlerror.HTTPError(
                capture.DEFAULT_BASE_URL + "/health",
                code,
                "untrusted detail",
                {},
                io.BytesIO(b'{"secret":"untrusted"}'),
            )
            with (
                self.subTest(code=code),
                mock.patch.object(capture.NO_REDIRECT_OPENER, "open", side_effect=error) as open_mock,
                mock.patch.object(capture.time, "sleep") as sleep,
                self.assertRaises(capture.GateError) as raised,
            ):
                capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health")
            self.assertEqual(open_mock.call_count, 1)
            sleep.assert_not_called()
            self.assertEqual(str(raised.exception), expected)

    def test_invalid_json_and_semantic_failure_are_not_retried(self) -> None:
        with (
            mock.patch.object(
                capture.NO_REDIRECT_OPENER,
                "open",
                return_value=FakeJsonResponse(b"not-json"),
            ) as open_mock,
            mock.patch.object(capture.time, "sleep") as sleep,
            self.assertRaises(capture.GateError) as raised,
        ):
            capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health")
        self.assertEqual(open_mock.call_count, 1)
        sleep.assert_not_called()
        self.assertEqual(str(raised.exception), "GET /health did not return JSON")

        wrong_health = json.dumps(
            {
                "status": "degraded",
                "embedder": capture.EXPECTED_EMBEDDER,
                "narrator": capture.EXPECTED_NARRATOR,
                "judge": "qwen-plus",
                "embedDim": capture.EXPECTED_DIMENSION,
            }
        ).encode("utf-8")
        with (
            mock.patch.object(
                capture.NO_REDIRECT_OPENER,
                "open",
                return_value=FakeJsonResponse(wrong_health),
            ) as open_mock,
            mock.patch.object(capture.time, "sleep") as sleep,
            self.assertRaises(capture.GateError) as raised,
        ):
            capture.public_release_probes(capture.DEFAULT_BASE_URL, self.TOKEN)
        self.assertEqual(open_mock.call_count, 1)
        sleep.assert_not_called()
        self.assertEqual(str(raised.exception), "/health is not ok")


class CaptionTimelineTests(unittest.TestCase):
    def test_real_motion_defaults_cover_the_matching_recall_beat(self) -> None:
        build_source = (ROOT / "demo" / "tools" / "build_real_motion_submission.py").read_text(encoding="utf-8")
        compose_source = (ROOT / "demo" / "tools" / "compose_real_motion_video.py").read_text(encoding="utf-8")
        runbook = (ROOT / "demo" / "REAL_MOTION_VIDEO.md").read_text(encoding="utf-8")
        for source in (build_source, compose_source):
            self.assertIn('\"--overlay-start\", type=float, default=51.0', source)
            self.assertIn('\"--overlay-end\", type=float, default=73.0', source)
            self.assertNotIn('\"--overlay-start\", type=float, default=13.0', source)
        self.assertIn("00:51–01:13 cross-session-recall panel", runbook)
        self.assertIn("00:13–00:32 exact-release, readiness, and Qwen vision proof remains visible", runbook)

    def test_final_video_docs_converge_on_real_motion_publication_gate(self) -> None:
        deploy_state = (ROOT / "deploy" / "DEPLOY_STATE.md").read_text(encoding="utf-8")
        canonical = (ROOT / "demo" / "REAL_MOTION_VIDEO.md").read_text(encoding="utf-8")
        supporting = (
            "demo/BUILD_RECORDING.md",
            "demo/CAPTION_VIDEO_BUILD.md",
            "demo/FINAL_MEDIA_CHECKLIST.md",
            "demo/VIDEO_RECORDING_CHECKLIST.md",
            "demo/final-media/README.md",
        )
        routed = supporting + (
            "README.md",
            "docs/BUILD_PLAN.md",
            "demo/MEDIA_CAPTURE_RUNBOOK.md",
            "demo/gallery/README.md",
            "demo/RIGHTS_RELEASE_CHECKLIST.md",
            "demo/VIDEO_SCRIPT.md",
            "demo/VIDEO_PUBLICATION_PACKET.md",
        )

        self.assertIn("`scripts/capture_submission_gallery.py`", deploy_state)
        self.assertIn("review-only, non-runtime capture tooling", deploy_state)
        self.assertIn("only canonical publication-candidate pipeline", canonical)
        self.assertRegex(canonical, r"build_caption_video\.py[\s\S]*intermediate[\s\S]*base renderer only")
        video_checklist = (ROOT / "demo" / "VIDEO_RECORDING_CHECKLIST.md").read_text(encoding="utf-8")
        self.assertIn("silence peak `<=8`", video_checklist)
        self.assertIn("static base retains its stricter `<=4`", video_checklist)
        for relative in routed:
            with self.subTest(route=relative):
                self.assertIn("REAL_MOTION_VIDEO.md", (ROOT / relative).read_text(encoding="utf-8"))
        for relative in supporting:
            with self.subTest(path=relative):
                doc = (ROOT / relative).read_text(encoding="utf-8")
                self.assertIn("REAL_MOTION_VIDEO.md", doc)
                self.assertRegex(doc, r"(?i)static")
                self.assertRegex(doc, r"(?i)base")
                self.assertIn("memoryagent-demo.manifest.json", doc)
                self.assertIn("memoryagent-demo.qa.json", doc)
                self.assertIn("--verify-only", doc)

    def test_canonical_ten_beats_are_frame_exact_and_under_limit(self) -> None:
        windows = builder.caption_windows()
        self.assertEqual(len(windows), 10)
        self.assertEqual([row[:2] for row in windows], [
            [0, 13],
            [13, 32],
            [32, 51],
            [51, 73],
            [73, 95],
            [95, 113],
            [113, 130],
            [130, 142],
            [142, 162],
            [162, 172],
        ])
        self.assertEqual(sum(beat.seconds * builder.FPS for beat in builder.BEATS), 5_160)
        self.assertEqual(windows[-1][1], 172)
        self.assertLess(windows[-1][1], builder.STRICT_LIMIT_SECONDS)

    def test_srt_is_exactly_measured_from_frame_boundaries(self) -> None:
        srt = builder.expected_srt()
        self.assertTrue(srt.startswith("1\n00:00:00,000 --> 00:00:13,000\n"))
        self.assertIn("3\n00:00:32,000 --> 00:00:51,000\n", srt)
        self.assertIn("10\n00:02:42,000 --> 00:02:52,000\n", srt)
        self.assertEqual(srt.count(" --> "), 10)
        self.assertNotIn("\r", srt)
        self.assertTrue(srt.endswith("\n"))

    def test_capture_pipeline_and_builder_emit_the_same_srt_bytes(self) -> None:
        blocks = []
        for index, (start, end, caption) in enumerate(builder.caption_windows(), start=1):
            blocks.append(
                f"{index}\n{capture.format_srt_time(float(start))} --> "
                f"{capture.format_srt_time(float(end))}\n{caption}\n"
            )
        self.assertEqual("\n".join(blocks).encode("utf-8"), builder.expected_srt().encode("utf-8"))

    def test_every_canonical_proof_frame_is_used_and_hash_required(self) -> None:
        used = {visual for beat in builder.BEATS for visual in beat.visuals}
        self.assertEqual(set(builder.PROOF_RELS) - used, set())
        self.assertEqual(set(builder.EVIDENCE_PROOF_RELS) - used, set())
        self.assertEqual(len(builder.EVIDENCE_PROOF_RELS), 10)
        self.assertIn(builder.ARCHITECTURE_REL, used)
        self.assertTrue(set(builder.GALLERY_RELS).issubset(builder.REQUIRED_ARTIFACTS))
        self.assertTrue(set(builder.PROOF_RELS).issubset(builder.REQUIRED_ARTIFACTS))
        self.assertIn(builder.SRT_REL, builder.REQUIRED_ARTIFACTS)

    def test_captions_retain_every_material_claim_boundary(self) -> None:
        captions = " ".join(beat.caption for beat in builder.BEATS).lower()
        self.assertIn("14,600 workforce cost versus 10,800 bank outflow", captions)
        self.assertNotIn("15,800 workforce cost versus 10,000 bank outflow", captions)
        for lock in (
            "original synthetic",
            "two-png",
            "qwen-vl-max",
            "zero writes or residue",
            "not raw-pdf parsing",
            "pure cosine",
            "product default remains hybrid",
            "defer only",
            "zero api call or write",
            "accept and override remain unexercised",
            "explicit reviewer feedback",
            "fresh authenticated session b",
            "not training, autonomous learning, or a model-weight update",
            "offline 90% fixture",
            "http is authenticated",
            "stdio trusted-local",
            "feedback-superseded",
            "exactly one",
            "marker residue is zero",
            "not an age-expired row",
            "not production accuracy",
            "independent evaluation",
            "no universal superiority claim",
            "function compute and rds",
            "alternative-only",
        ):
            self.assertIn(lock, captions)

    def test_production_gate_contract_is_explicit(self) -> None:
        self.assertEqual(builder.REQUIRED_BOOLEAN_GATES["exactDeploymentEvidence"], True)
        self.assertEqual(builder.REQUIRED_BOOLEAN_GATES["authenticatedDeepReadiness"], True)
        self.assertEqual(builder.REQUIRED_BOOLEAN_GATES["reviewerCredentialRendered"], False)
        self.assertEqual(builder.REQUIRED_BOOLEAN_GATES["rawCapturesTracked"], False)
        self.assertEqual(builder.EXPECTED_EMBEDDER, "text-embedding-v4")
        self.assertEqual(builder.EXPECTED_NARRATOR, "qwen-plus")
        self.assertEqual(builder.EXPECTED_VISION, "qwen-vl-max")
        self.assertEqual(builder.EXPECTED_EMBED_DIM, 1024)
        builder.validate_claim_matrix(ROOT / builder.CLAIM_MATRIX_REL)
        self.assertIn("MRR 0.883 → 0.911", builder.REQUIRED_CLAIM_SNIPPETS)

    def test_repo_path_gate_rejects_escape_without_creating_it(self) -> None:
        outside = ROOT.parent / "memoryagent-caption-unit-test-escape"
        self.assertFalse(outside.exists())
        with self.assertRaises(builder.GateError):
            builder.project_path(outside, "unit-test escape")
        self.assertFalse(outside.exists())


class ExactDeployEvidenceTests(unittest.TestCase):
    SHA = "1" * 40
    AUTOPILOT_SHA = "a" * 40

    def setUp(self) -> None:
        self.status_base = {
            "memorySha": self.SHA,
            "status": "Success",
            "terminal": True,
            "exitCode": 0,
            "outputCaptured": True,
            "projectContained": True,
            "invocationId": "invoke-memoryagent-attempt-16",
            "commandId": "command-exact-merged-deploy-v2",
        }
        self.prefix = (
            f"EXACT_CHECKOUT_OK app=memoryagent sha={self.SHA}\n"
            f"EXACT_APP_DEPLOY_OK app=memoryagent sha={self.SHA}\n"
        )

    def status_for(self, output: str, **overrides: object) -> dict[str, object]:
        raw = output.encode("utf-8")
        return {
            **self.status_base,
            "outputSha256": hashlib.sha256(raw).hexdigest(),
            "outputBytes": len(raw),
            **overrides,
        }

    def final_marker(self, memory_sha: str | None = None) -> str:
        return f"EXACT_DEPLOY_SUCCESS memory={memory_sha or self.SHA} autopilot={self.AUTOPILOT_SHA}\n"

    @staticmethod
    def validators():
        return (
            ("capture", capture.validate_exact_deploy_evidence, capture.GateError),
            ("builder", builder.validate_exact_deploy_evidence, builder.GateError),
        )

    def test_strict_final_marker_and_terminal_truncation_paths_are_both_accepted(self) -> None:
        strict = self.prefix + self.final_marker()
        for name, validator, _error in self.validators():
            with self.subTest(parser=name, mode="strict"):
                self.assertEqual(validator(self.SHA, self.status_for(strict), strict), "strict-final-marker")
            with self.subTest(parser=name, mode="truncated-output"):
                self.assertEqual(
                    validator(self.SHA, self.status_for(self.prefix), self.prefix),
                    "terminal-success-truncated-output",
                )

    def test_truncation_fallback_rejects_weak_status_missing_markers_and_conflicts(self) -> None:
        cases = (
            ("non-terminal", {"terminal": False}, self.prefix),
            ("non-zero-exit", {"exitCode": 1}, self.prefix),
            ("boolean-exit-code", {"exitCode": False}, self.prefix),
            ("not-captured", {"outputCaptured": False}, self.prefix),
            ("not-contained", {"projectContained": False}, self.prefix),
            ("missing-app", {}, f"EXACT_CHECKOUT_OK app=memoryagent sha={self.SHA}\n"),
            (
                "conflicting-final",
                {},
                self.prefix + self.final_marker("2" * 40),
            ),
            ("error-marker", {}, self.prefix + "EXACT_DEPLOY_ERROR post-deploy failure\n"),
        )
        for parser_name, validator, error in self.validators():
            for case_name, overrides, output in cases:
                with self.subTest(parser=parser_name, case=case_name):
                    with self.assertRaises(error):
                        validator(self.SHA, self.status_for(output, **overrides), output)

    def test_marker_stream_rejects_post_app_output_and_out_of_order_success(self) -> None:
        cases = (
            (
                "post-app-failure",
                self.prefix + "fatal: post-deploy TLS check failed\n",
            ),
            (
                "reversed-strict-order",
                self.final_marker()
                + f"EXACT_APP_DEPLOY_OK app=memoryagent sha={self.SHA}\n"
                + f"EXACT_CHECKOUT_OK app=memoryagent sha={self.SHA}\n",
            ),
        )
        for parser_name, validator, error in self.validators():
            for case_name, output in cases:
                with self.subTest(parser=parser_name, case=case_name):
                    with self.assertRaises(error):
                        validator(self.SHA, self.status_for(output), output)

    def test_status_must_bind_the_exact_output_and_producer_ids(self) -> None:
        strict = self.prefix + self.final_marker()
        for parser_name, validator, error in self.validators():
            weak = {key: value for key, value in self.status_for(strict).items() if key not in {"invocationId", "commandId"}}
            cases = (
                ("legacy-weak-status", weak),
                ("status-from-other-output", self.status_for(self.prefix)),
                ("wrong-output-hash", self.status_for(strict, outputSha256="0" * 64)),
                ("wrong-output-size", self.status_for(strict, outputBytes=len(strict.encode("utf-8")) + 1)),
                ("unsafe-invocation-id", self.status_for(strict, invocationId="../../other attempt")),
            )
            for case_name, status in cases:
                with self.subTest(parser=parser_name, case=case_name):
                    with self.assertRaises(error):
                        validator(self.SHA, status, strict)

    def test_marker_lines_follow_the_controller_exact_schema(self) -> None:
        valid_reuse = (
            f"EXACT_CHECKOUT_OK app=memoryagent sha={self.SHA}\n"
            f"EXACT_APP_REUSE_OK app=memoryagent sha={self.SHA} health=ok\n"
        )
        unsafe_outputs = (
            self.prefix.rstrip("\n") + " extra=hidden\n",
            self.prefix.rstrip("\n") + " EXACT_DEPLOY_ERROR hidden\n",
            self.prefix + self.final_marker().rstrip("\n") + " synthetic_test=true\n",
            self.prefix + self.final_marker().rstrip("\n") + " EXACT_DEPLOY_ERROR hidden\n",
            f"EXACT_CHECKOUT_OK app=memoryagent sha={self.SHA}\n"
            f"EXACT_APP_REUSE_OK app=memoryagent sha={self.SHA}\n",
        )
        for parser_name, validator, error in self.validators():
            with self.subTest(parser=parser_name, case="exact-reuse"):
                self.assertEqual(
                    validator(self.SHA, self.status_for(valid_reuse), valid_reuse),
                    "terminal-success-truncated-output",
                )
            for index, output in enumerate(unsafe_outputs):
                with self.subTest(parser=parser_name, case=f"same-line-{index}"):
                    with self.assertRaises(error):
                        validator(self.SHA, self.status_for(output), output)


class ReleaseBoundaryTests(unittest.TestCase):
    SHA = "1" * 40

    def test_capture_live_origin_is_exactly_pinned(self) -> None:
        self.assertEqual(capture.validate_live_origin(capture.DEFAULT_BASE_URL), capture.DEFAULT_BASE_URL)
        for unsafe in (
            capture.DEFAULT_BASE_URL + "/",
            capture.DEFAULT_BASE_URL + "/path",
            capture.DEFAULT_BASE_URL + "?next=https://example.invalid",
            "https://memory.43.106.13.19.sslip.io:444",
            "https://user:secret@memory.43.106.13.19.sslip.io",
            "https://example.invalid",
        ):
            with self.subTest(origin=unsafe):
                with self.assertRaises(capture.GateError):
                    capture.validate_live_origin(unsafe)

    def test_capture_http_redirect_handler_refuses_to_construct_followup(self) -> None:
        req = urlrequest.Request(
            capture.DEFAULT_BASE_URL + "/ready/deep",
            headers={"Authorization": "Bearer " + "x" * 32},
        )
        redirected = capture.NoRedirectHandler().redirect_request(
            req,
            io.BytesIO(),
            302,
            "Found",
            {},
            "https://example.invalid/steal",
        )
        self.assertIsNone(redirected)

    def test_browser_network_guard_rejects_redirects_and_other_origins(self) -> None:
        self.assertTrue(capture.is_pinned_live_request(capture.DEFAULT_BASE_URL + "/ready/deep"))
        self.assertFalse(capture.is_pinned_live_request(capture.DEFAULT_BASE_URL, redirected=True))
        self.assertFalse(capture.is_pinned_live_request("https://example.invalid/steal"))
        self.assertFalse(capture.is_pinned_live_request("https://memory.43.106.13.19.sslip.io:444/steal"))

    def test_deploy_state_requires_one_exact_sha_bound_machine_record(self) -> None:
        good = (
            "# Deployment state\n\n"
            f"<!-- MEMORYAGENT_DEPLOY_STATE_V1 status=LIVE_VERIFIED_READY runtime_sha={self.SHA} -->\n"
        )
        builder.validate_deploy_state_text(good, self.SHA)
        for unsafe in (
            f"**Status: NOT READY**\n{self.SHA}\n",
            f"**Status: UNVERIFIED**\n{self.SHA}\n",
            good.replace(self.SHA, "2" * 40),
            good + good,
        ):
            with self.subTest(state=unsafe[:80]):
                with self.assertRaises(builder.GateError):
                    builder.validate_deploy_state_text(unsafe, self.SHA)

    def test_capture_review_binds_evidence_mode_path_hash_and_size(self) -> None:
        root = ROOT / ".artifacts" / "release-boundary-unit-test"
        if root.exists():
            shutil.rmtree(root)
        root.mkdir(parents=True)
        try:
            status_path = root / "status.json"
            output_path = root / "output.txt"
            output_path.write_text("marker stream\n", encoding="utf-8")
            output = read_project_file_once(output_path, "test output")
            status_payload = {
                "invocationId": "invoke-release-boundary-test",
                "commandId": "command-release-boundary-test",
                "outputSha256": output.sha256,
                "outputBytes": output.size,
            }
            status_path.write_text(json.dumps(status_payload) + "\n", encoding="utf-8")
            status = read_project_file_once(status_path, "test status")
            review = {
                "deploymentEvidence": {
                    "mode": "strict-final-marker",
                    "producer": status_payload,
                    "status": {"path": status.relative_path, "sha256": status.sha256, "size": status.size},
                    "output": {"path": output.relative_path, "sha256": output.sha256, "size": output.size},
                }
            }
            builder.validate_bound_deployment_evidence(review, status, output, "strict-final-marker")

            bad = {"deploymentEvidence": {**review["deploymentEvidence"], "mode": "terminal-success-truncated-output"}}
            with self.assertRaises(builder.GateError):
                builder.validate_bound_deployment_evidence(bad, status, output, "strict-final-marker")
            bad = {
                "deploymentEvidence": {
                    **review["deploymentEvidence"],
                    "output": {**review["deploymentEvidence"]["output"], "sha256": "0" * 64},
                }
            }
            with self.assertRaises(builder.GateError):
                builder.validate_bound_deployment_evidence(bad, status, output, "strict-final-marker")
            bad = {
                "deploymentEvidence": {
                    **review["deploymentEvidence"],
                    "producer": {**status_payload, "invocationId": "invoke-other-attempt"},
                }
            }
            with self.assertRaises(builder.GateError):
                builder.validate_bound_deployment_evidence(bad, status, output, "strict-final-marker")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_random_exclusive_atomic_write_does_not_follow_predictable_link(self) -> None:
        root = ROOT / ".artifacts" / "atomic-output-boundary-unit-test"
        if root.exists():
            shutil.rmtree(root)
        scratch = root / "scratch"
        scratch.mkdir(parents=True)
        try:
            victim = root / "victim.txt"
            victim.write_text("do not overwrite\n", encoding="utf-8")
            target = root / "final.txt"
            predictable_old_temp = scratch / ".final.txt.writing"
            os.link(victim, predictable_old_temp)
            builder.atomic_write_text(target, "safe final\n", scratch)
            self.assertEqual(victim.read_text(encoding="utf-8"), "do not overwrite\n")
            self.assertEqual(target.read_text(encoding="utf-8"), "safe final\n")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_tracked_snapshot_is_compared_directly_with_head_blob(self) -> None:
        snapshot = read_project_file_once(ROOT / "docs" / "CLAIM_EVIDENCE_MATRIX.md", "tracked test input")
        builder.ensure_snapshot_matches_head(snapshot, "tracked test input")
        changed = builder.ProjectFileSnapshot(
            path=snapshot.path,
            relative_path=snapshot.relative_path,
            data=snapshot.data + b"tampered",
            sha256=hashlib.sha256(snapshot.data + b"tampered").hexdigest(),
            size=snapshot.size + len(b"tampered"),
        )
        with self.assertRaises(builder.GateError):
            builder.ensure_snapshot_matches_head(changed, "tracked test input")

    def test_read_once_snapshot_rejects_hardlinks_and_symlinks(self) -> None:
        root = ROOT / ".artifacts" / "snapshot-identity-unit-test"
        if root.exists():
            shutil.rmtree(root)
        root.mkdir(parents=True)
        try:
            source = root / "evidence.txt"
            source.write_bytes(b"immutable evidence\n")
            snapshot = read_project_file_once(source, "test evidence")
            self.assertEqual(snapshot.data, b"immutable evidence\n")

            alias = root / "hardlink.txt"
            os.link(source, alias)
            with self.assertRaises(ValueError):
                read_project_file_once(source, "hardlinked evidence")
            alias.unlink()

            symlink = root / "symlink.txt"
            try:
                symlink.symlink_to(source.name)
            except OSError:
                symlink = None
            if symlink is not None:
                with self.assertRaises(ValueError):
                    read_project_file_once(symlink, "symlink evidence")
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
