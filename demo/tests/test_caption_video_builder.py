"""Offline regression tests for the caption-led final-video builder."""

from __future__ import annotations

import importlib.util
import hashlib
from http import client as httpclient
import json
import os
from pathlib import Path
import shutil
import ssl
import sys
import traceback
import unittest
from unittest import mock


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


class FakeHttpResponse:
    """Fully readable response that leaves its owning connection reusable."""

    def __init__(
        self,
        payload: bytes,
        *,
        status: int = 200,
        read_failure: BaseException | None = None,
        close_failure: BaseException | None = None,
    ) -> None:
        self.payload = payload
        self.status = status
        self.read_failure = read_failure
        self.close_failure = close_failure
        self.read_calls = 0
        self.close_calls = 0

    def read(self) -> bytes:
        self.read_calls += 1
        if self.read_failure is not None:
            raise self.read_failure
        return self.payload

    def getheaders(self) -> list[tuple[str, str]]:
        return [("Content-Type", "application/json")]

    def close(self) -> None:
        self.close_calls += 1
        if self.close_failure is not None:
            raise self.close_failure


class FakePersistentConnection:
    """Scripted stdlib HTTPSConnection double with explicit close evidence."""

    def __init__(self, *outcomes: FakeHttpResponse | BaseException) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[tuple[str, str, bytes | None, dict[str, str]]] = []
        self.close_calls = 0
        self.timeout: float | None = None
        self.sock = None
        self._pending: FakeHttpResponse | None = None

    def request(self, method: str, path: str, *, body: bytes | None, headers: dict[str, str]) -> None:
        self.requests.append((method, path, body, dict(headers)))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        self._pending = outcome

    def getresponse(self) -> FakeHttpResponse:
        assert self._pending is not None
        response = self._pending
        self._pending = None
        return response

    def close(self) -> None:
        self.close_calls += 1


class FakeConnectionFactory:
    def __init__(self, *connections: FakePersistentConnection) -> None:
        self.connections = list(connections)
        self.calls: list[tuple[str, int, float, ssl.SSLContext]] = []

    def __call__(
        self,
        host: str,
        port: int,
        *,
        timeout: float,
        context: ssl.SSLContext,
    ) -> FakePersistentConnection:
        self.calls.append((host, port, timeout, context))
        connection = self.connections.pop(0)
        connection.timeout = timeout
        return connection


class CapturePersistentTransportTests(unittest.TestCase):
    TOKEN = "reviewer-secret-that-must-never-leak-1234567890"

    def make_transport(
        self,
        *connections: FakePersistentConnection,
    ) -> tuple[object, FakeConnectionFactory, ssl.SSLContext]:
        context = ssl.create_default_context()
        factory = FakeConnectionFactory(*connections)
        transport = capture.PinnedHttpsJsonTransport(ssl_context=context, connection_factory=factory)
        return transport, factory, context

    def test_successive_requests_reuse_one_verified_pinned_connection(self) -> None:
        health_response = FakeHttpResponse(b'{"status":"ok"}')
        ready_response = FakeHttpResponse(b'{"status":"ready"}')
        connection = FakePersistentConnection(health_response, ready_response)
        transport, factory, context = self.make_transport(connection)

        with mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport):
            health, headers = capture.request_json(
                "GET",
                capture.DEFAULT_BASE_URL,
                "/health",
                reviewer_token=self.TOKEN,
                timeout=7.0,
            )
            ready, _ = capture.request_json("GET", capture.DEFAULT_BASE_URL, "/ready", timeout=11.0)

        self.assertEqual(health, {"status": "ok"})
        self.assertEqual(ready, {"status": "ready"})
        self.assertEqual(headers, {"content-type": "application/json"})
        self.assertEqual(
            factory.calls,
            [(capture.PINNED_LIVE_HOST, capture.PINNED_LIVE_PORT, 7.0, context)],
        )
        self.assertEqual(connection.timeout, 11.0)
        self.assertEqual([request[1] for request in connection.requests], ["/health", "/ready"])
        self.assertEqual(connection.requests[0][3]["Authorization"], f"Bearer {self.TOKEN}")
        self.assertNotIn("Authorization", connection.requests[1][3])
        self.assertEqual(health_response.close_calls, 1)
        self.assertEqual(ready_response.close_calls, 1)

    def test_broken_safe_get_resets_connection_then_retries_on_exact_schedule(self) -> None:
        broken = FakePersistentConnection(OSError(f"temporary failure {self.TOKEN}"))
        recovered = FakePersistentConnection(FakeHttpResponse(b'{"status":"ok"}'))
        transport, factory, _ = self.make_transport(broken, recovered)

        with (
            mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport),
            mock.patch.object(capture.time, "sleep") as sleep,
        ):
            payload, _ = capture.request_json(
                "GET",
                capture.DEFAULT_BASE_URL,
                "/health",
                reviewer_token=self.TOKEN,
            )

        self.assertEqual(payload, {"status": "ok"})
        self.assertEqual(len(factory.calls), 2)
        self.assertEqual(broken.close_calls, 1)
        self.assertEqual(recovered.close_calls, 0)
        self.assertEqual(sleep.call_args_list, [mock.call(capture.GET_TRANSPORT_RETRY_DELAYS_SECONDS[0])])
        self.assertEqual(recovered.requests[0][3]["Authorization"], f"Bearer {self.TOKEN}")

    def test_get_transport_retry_is_bounded_and_scrubs_exception_details(self) -> None:
        connections = [
            FakePersistentConnection(OSError(f"upstream accidentally included {self.TOKEN}"))
            for _ in range(capture.GET_TRANSPORT_MAX_ATTEMPTS)
        ]
        transport, factory, _ = self.make_transport(*connections)
        with (
            mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport),
            mock.patch.object(capture.time, "sleep") as sleep,
            self.assertRaises(capture.GateError) as raised,
        ):
            capture.request_json(
                "GET",
                capture.DEFAULT_BASE_URL,
                "/ready/deep",
                reviewer_token=self.TOKEN,
            )

        self.assertEqual(len(factory.calls), capture.GET_TRANSPORT_MAX_ATTEMPTS)
        self.assertTrue(all(connection.close_calls == 1 for connection in connections))
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
        self.assertIsNone(raised.exception.__cause__)
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertNotIn(self.TOKEN, "".join(traceback.format_exception(raised.exception)))

    def test_each_supported_transport_exception_resets_and_retries_safe_get(self) -> None:
        cases = (
            httpclient.RemoteDisconnected("peer closed"),
            ssl.SSLError("TLS read failed"),
            TimeoutError("socket timeout"),
            OSError("connection reset"),
        )
        for failure in cases:
            broken = FakePersistentConnection(failure)
            recovered = FakePersistentConnection(FakeHttpResponse(b'{"status":"ok"}'))
            transport, factory, _ = self.make_transport(broken, recovered)
            with (
                self.subTest(transport=type(failure).__name__),
                mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport),
                mock.patch.object(capture.time, "sleep") as sleep,
            ):
                payload, _ = capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health")
            self.assertEqual(payload, {"status": "ok"})
            self.assertEqual(len(factory.calls), 2)
            self.assertEqual(broken.close_calls, 1)
            self.assertEqual(
                sleep.call_args_list,
                [mock.call(capture.GET_TRANSPORT_RETRY_DELAYS_SECONDS[0])],
            )

    def test_mutation_transport_failure_is_never_retried(self) -> None:
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            mutation_response = FakeHttpResponse(
                b"",
                read_failure=OSError(f"post-send response failure {self.TOKEN}"),
            )
            connection = FakePersistentConnection(
                FakeHttpResponse(b'{"status":"ok"}'),
                mutation_response,
            )
            transport, factory, _ = self.make_transport(connection)
            with (
                self.subTest(method=method),
                mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport),
                mock.patch.object(capture.time, "sleep") as sleep,
            ):
                capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health")
                with self.assertRaises(capture.GateError) as raised:
                    capture.request_json(
                        method,
                        capture.DEFAULT_BASE_URL,
                        "/demo/seed",
                        body={},
                        reviewer_token=self.TOKEN,
                    )

            self.assertEqual(len(factory.calls), 1)
            self.assertEqual(len(connection.requests), 2)
            self.assertEqual(connection.requests[1][2], b"{}")
            self.assertEqual(connection.close_calls, 1)
            self.assertEqual(mutation_response.read_calls, 1)
            self.assertEqual(mutation_response.close_calls, 1)
            sleep.assert_not_called()
            self.assertEqual(str(raised.exception), f"{method} /demo/seed was unreachable")
            self.assertNotIn(self.TOKEN, str(raised.exception))
            self.assertIsNone(raised.exception.__cause__)

    def test_get_with_body_is_not_eligible_for_retry(self) -> None:
        connection = FakePersistentConnection(OSError("transport failure"))
        transport, factory, _ = self.make_transport(connection)
        with (
            mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport),
            mock.patch.object(capture.time, "sleep") as sleep,
            self.assertRaises(capture.GateError) as raised,
        ):
            capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health", body={})

        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(connection.close_calls, 1)
        sleep.assert_not_called()
        self.assertEqual(str(raised.exception), "GET /health was unreachable")

    def test_http_errors_and_redirects_are_authoritative_and_never_retried(self) -> None:
        cases = (
            (503, None, "GET /health returned HTTP 503"),
            (302, None, "GET /health attempted a forbidden HTTP redirect"),
            (503, OSError(f"close failure {self.TOKEN}"), "GET /health returned HTTP 503"),
        )
        for status, close_failure, expected in cases:
            response = FakeHttpResponse(
                b'{"secret":"untrusted"}',
                status=status,
                close_failure=close_failure,
            )
            connection = FakePersistentConnection(response)
            transport, factory, _ = self.make_transport(connection)
            with (
                self.subTest(status=status),
                mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport),
                mock.patch.object(capture.time, "sleep") as sleep,
                self.assertRaises(capture.GateError) as raised,
            ):
                capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health")
            self.assertEqual(len(factory.calls), 1)
            self.assertEqual(len(connection.requests), 1)
            self.assertEqual(connection.close_calls, 1)
            self.assertEqual(response.read_calls, 0)
            self.assertEqual(response.close_calls, 1)
            sleep.assert_not_called()
            self.assertEqual(str(raised.exception), expected)
            self.assertNotIn("untrusted", str(raised.exception))

    def test_invalid_json_and_semantic_failure_are_not_retried(self) -> None:
        invalid = FakePersistentConnection(FakeHttpResponse(("not-json-" + self.TOKEN).encode("utf-8")))
        transport, factory, _ = self.make_transport(invalid)
        with (
            mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport),
            mock.patch.object(capture.time, "sleep") as sleep,
            self.assertRaises(capture.GateError) as raised,
        ):
            capture.request_json("GET", capture.DEFAULT_BASE_URL, "/health")
        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(len(invalid.requests), 1)
        sleep.assert_not_called()
        self.assertEqual(str(raised.exception), "GET /health did not return JSON")
        self.assertNotIn(self.TOKEN, "".join(traceback.format_exception(raised.exception)))

        wrong_health = json.dumps(
            {
                "status": "degraded",
                "embedder": capture.EXPECTED_EMBEDDER,
                "narrator": capture.EXPECTED_NARRATOR,
                "judge": "qwen-plus",
                "embedDim": capture.EXPECTED_DIMENSION,
            }
        ).encode("utf-8")
        semantic = FakePersistentConnection(FakeHttpResponse(wrong_health))
        transport, factory, _ = self.make_transport(semantic)
        with (
            mock.patch.object(capture, "LIVE_JSON_TRANSPORT", transport),
            mock.patch.object(capture.time, "sleep") as sleep,
            self.assertRaises(capture.GateError) as raised,
        ):
            capture.public_release_probes(capture.DEFAULT_BASE_URL, self.TOKEN)
        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(len(semantic.requests), 1)
        sleep.assert_not_called()
        self.assertEqual(str(raised.exception), "/health is not ok")

    def test_tls_context_must_verify_the_exact_hostname_and_certificate(self) -> None:
        no_hostname = ssl.create_default_context()
        no_hostname.check_hostname = False
        with self.assertRaisesRegex(capture.GateError, "verify the pinned hostname"):
            capture.PinnedHttpsJsonTransport(ssl_context=no_hostname)

        no_certificate = mock.Mock(check_hostname=True, verify_mode=ssl.CERT_NONE)
        with self.assertRaisesRegex(capture.GateError, "require certificate validation"):
            capture.PinnedHttpsJsonTransport(ssl_context=no_certificate)


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

    def test_capture_transport_rejects_authority_style_request_paths(self) -> None:
        transport = capture.PinnedHttpsJsonTransport()
        with self.assertRaisesRegex(capture.GateError, "origin-relative"):
            transport.request_json("GET", capture.DEFAULT_BASE_URL, "//example.invalid/steal")

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

    def test_post_deploy_allowlist_adds_only_exact_non_runtime_capture_paths(self) -> None:
        for path in (
            "scripts/capture_web.py",
            "tests/docs/docs-consistency.test.ts",
        ):
            self.assertTrue(capture.allowed_post_deploy_path(path), path)
        for path in (
            "scripts/capture_web.py/extra",
            "scripts/capture_web.py.bak",
            "tests/docs/docs-consistency.test.ts/extra",
            "tests/docs/other.test.ts",
            "src/server.ts",
            "package.json",
        ):
            self.assertFalse(capture.allowed_post_deploy_path(path), path)


class CaptureTransientResilienceTests(unittest.TestCase):
    ROOT = ROOT / ".artifacts" / "capture-transient-resilience-unit-test"

    def setUp(self) -> None:
        if self.ROOT.exists():
            shutil.rmtree(self.ROOT)
        self.ROOT.mkdir(parents=True)
        self.run_counter = 0

    def tearDown(self) -> None:
        shutil.rmtree(self.ROOT, ignore_errors=True)

    def ledger(self) -> object:
        self.run_counter += 1
        run_id = f"20000101T0000{self.run_counter:02d}Z-{self.run_counter:08x}"
        return capture.CaptureAttemptLedger(run_id, self.ROOT / run_id)

    @staticmethod
    def narrator_success() -> dict[str, object]:
        return {
            "answer": "Employer cost appears first [1].",
            "hits": [{"id": "memory-1"}],
            "citations": [{"marker": "[1]", "content": "Synthetic employer cost fact."}],
            "modelId": capture.EXPECTED_NARRATOR,
            "consistency": {},
            "retrieval": {},
            "grounding": {"status": "passed", "attempts": 1},
        }

    @staticmethod
    def narrator_transient(code: str = "upstream_timeout") -> dict[str, object]:
        return {
            "answer": "Retrieved memory [1].",
            "hits": [{"id": "memory-1"}],
            "citations": [{"marker": "[1]", "content": "Synthetic fact."}],
            "modelId": "degraded",
            "consistency": {},
            "retrieval": {},
            "degraded": capture.NARRATOR_DEGRADED_MESSAGE,
            "degradationCode": code,
            "degradationAttempts": 1,
        }

    @staticmethod
    def semantic_success() -> dict[str, object]:
        return {
            "totalMemories": 3,
            "audited": 3,
            "candidatePairs": 2,
            "compared": 2,
            "modelCalls": 2,
            "judged": 2,
            "failed": 0,
            "embeddingFailed": 0,
            "truncated": False,
            "status": "complete",
            "errors": [],
            "embeddingErrors": [],
            "semanticContradictions": [{"type": "semantic-contradiction"}],
            "ok": False,
        }

    @staticmethod
    def semantic_transient(reason: str = "judge unavailable") -> dict[str, object]:
        return {
            "totalMemories": 3,
            "audited": 3,
            "candidatePairs": 2,
            "compared": 2,
            "modelCalls": 2,
            "judged": 1,
            "failed": 1,
            "embeddingFailed": 0,
            "truncated": False,
            "status": "partial",
            "errors": [{"memoryIds": ["memory-1", "memory-2"], "reason": reason}],
            "embeddingErrors": [],
            "semanticContradictions": [],
            "ok": False,
        }

    def test_allowlisted_http_200_transients_select_later_strict_attempt(self) -> None:
        for stage in ("session-b-recall", "explorer-recall"):
            with self.subTest(stage=stage):
                outcomes = [self.narrator_transient(), self.narrator_success()]
                sleeps: list[float] = []
                ledger = self.ledger()
                selected = capture.run_stage_local_retry(
                    stage=stage,
                    operation=lambda: (outcomes.pop(0), 200),
                    classifier=capture.classify_narrator_stage,
                    ledger=ledger,
                    sleeper=sleeps.append,
                )
                self.assertEqual(selected["modelId"], capture.EXPECTED_NARRATOR)
                self.assertEqual(sleeps, [1.0])
                self.assertEqual([row["outcome"] for row in ledger.records], ["retryable-transient", "selected"])

        outcomes = [self.semantic_transient(), self.semantic_success()]
        sleeps = []
        ledger = self.ledger()
        selected = capture.run_stage_local_retry(
            stage="semantic-audit",
            operation=lambda: (outcomes.pop(0), 200),
            classifier=capture.classify_semantic_stage,
            ledger=ledger,
            sleeper=sleeps.append,
        )
        self.assertEqual(selected["status"], "complete")
        self.assertEqual(sleeps, [1.0])
        self.assertEqual([row["outcome"] for row in ledger.records], ["retryable-transient", "selected"])

    def test_transient_exhaustion_is_bounded_and_fail_closed(self) -> None:
        ledger = self.ledger()
        calls = 0
        sleeps: list[float] = []

        def operation() -> tuple[object, int]:
            nonlocal calls
            calls += 1
            return self.narrator_transient("upstream_unavailable"), 200

        with self.assertRaisesRegex(capture.GateError, "exhausted 3"):
            capture.run_stage_local_retry(
                stage="session-b-recall",
                operation=operation,
                classifier=capture.classify_narrator_stage,
                ledger=ledger,
                sleeper=sleeps.append,
            )
        self.assertEqual(calls, 3)
        self.assertEqual(sleeps, [1.0, 2.0])
        self.assertEqual(ledger.records[-1]["outcome"], "transient-exhausted")
        self.assertNotIn("selected", {row["outcome"] for row in ledger.records})

    def test_unknown_malformed_nontransient_and_non_200_results_never_retry(self) -> None:
        malformed_degraded = self.narrator_transient()
        malformed_degraded["unexpected"] = True
        grounding_degraded = self.narrator_transient("grounding_unsupported_numeric_claim")
        grounding_degraded["degradationAttempts"] = 2
        cases = (
            (None, 200, capture.classify_narrator_stage),
            ({"modelId": "other-model"}, 200, capture.classify_narrator_stage),
            ({"modelId": "degraded", "degradationCode": []}, 200, capture.classify_narrator_stage),
            ({"modelId": capture.EXPECTED_NARRATOR, "grounding": {"status": [], "attempts": 1}}, 200, capture.classify_narrator_stage),
            (grounding_degraded, 200, capture.classify_narrator_stage),
            (malformed_degraded, 200, capture.classify_narrator_stage),
            (None, 503, capture.classify_narrator_stage),
            (self.semantic_transient("unparseable judge response"), 200, capture.classify_semantic_stage),
            ({"status": []}, 200, capture.classify_semantic_stage),
        )
        for index, (payload, status, classifier) in enumerate(cases):
            with self.subTest(index=index):
                ledger = self.ledger()
                calls = 0

                def operation() -> tuple[object, int]:
                    nonlocal calls
                    calls += 1
                    return payload, status

                returned = capture.run_stage_local_retry(
                    stage="semantic-audit" if classifier is capture.classify_semantic_stage else "explorer-recall",
                    operation=operation,
                    classifier=classifier,
                    ledger=ledger,
                    sleeper=lambda _delay: self.fail("non-retryable result slept"),
                )
                self.assertIs(returned, payload)
                self.assertEqual(calls, 1)
                self.assertEqual(ledger.records[0]["outcome"], "rejected-no-retry")
                if payload is grounding_degraded:
                    self.assertEqual(ledger.records[0]["observation"]["degradationClass"], "grounding-failure")
                    self.assertEqual(ledger.records[0]["observation"]["degradationAttempts"], 2)

    def test_transport_or_parse_exception_never_retries(self) -> None:
        ledger = self.ledger()
        calls = 0

        def operation() -> tuple[object, int]:
            nonlocal calls
            calls += 1
            raise ValueError("synthetic malformed response")

        with self.assertRaisesRegex(capture.GateError, "without retry") as raised:
            capture.run_stage_local_retry(
                stage="semantic-audit",
                operation=operation,
                classifier=capture.classify_semantic_stage,
                ledger=ledger,
                sleeper=lambda _delay: self.fail("failed request slept"),
            )
        self.assertIsInstance(raised.exception.__cause__, ValueError)
        self.assertEqual(calls, 1)
        self.assertEqual(ledger.records[0]["outcome"], "request-failed-no-retry")

    def test_final_content_and_finding_gates_are_not_retry_triggers(self) -> None:
        narrator_payload = self.narrator_success()
        narrator_payload["answer"] = ""
        narrator_ledger = self.ledger()
        narrator_calls = 0

        def narrator_operation() -> tuple[object, int]:
            nonlocal narrator_calls
            narrator_calls += 1
            return narrator_payload, 200

        selected = capture.run_stage_local_retry(
            stage="explorer-recall",
            operation=narrator_operation,
            classifier=capture.classify_narrator_stage,
            ledger=narrator_ledger,
            sleeper=lambda _delay: self.fail("content failure slept"),
        )
        with self.assertRaises(capture.GateError):
            capture.require(bool(selected["answer"].strip()), "synthetic final content gate")
        self.assertEqual(narrator_calls, 1)

        semantic_payload = self.semantic_success()
        semantic_payload["semanticContradictions"] = []
        semantic_ledger = self.ledger()
        semantic_calls = 0

        def semantic_operation() -> tuple[object, int]:
            nonlocal semantic_calls
            semantic_calls += 1
            return semantic_payload, 200

        selected_semantic = capture.run_stage_local_retry(
            stage="semantic-audit",
            operation=semantic_operation,
            classifier=capture.classify_semantic_stage,
            ledger=semantic_ledger,
            sleeper=lambda _delay: self.fail("finding failure slept"),
        )
        with self.assertRaises(capture.GateError):
            capture.require(bool(selected_semantic["semanticContradictions"]), "synthetic final finding gate")
        self.assertEqual(semantic_calls, 1)

    def test_quota_math_and_selected_attempt_provenance_are_explicit(self) -> None:
        expected_max = {
            "session-b-recall": 12,
            "explorer-recall": 12,
            "semantic-audit": 75,
        }
        self.assertEqual(len(capture.STAGE_LOCAL_BACKOFF_SECONDS), capture.STAGE_LOCAL_MAX_ATTEMPTS - 1)
        for stage, quota in capture.STAGE_LOCAL_RETRY_QUOTA.items():
            max_units = quota["workUnitsPerAttempt"] * capture.STAGE_LOCAL_MAX_ATTEMPTS
            self.assertEqual(max_units, expected_max[stage])
            self.assertLessEqual(max_units, quota["limit"])

        ledger = self.ledger()
        for stage in ("session-b-recall", "explorer-recall"):
            capture.run_stage_local_retry(
                stage=stage,
                operation=lambda: (self.narrator_success(), 200),
                classifier=capture.classify_narrator_stage,
                ledger=ledger,
                sleeper=lambda _delay: self.fail("strict success slept"),
            )
        capture.run_stage_local_retry(
            stage="semantic-audit",
            operation=lambda: (self.semantic_success(), 200),
            classifier=capture.classify_semantic_stage,
            ledger=ledger,
            sleeper=lambda _delay: self.fail("strict success slept"),
        )
        provenance = ledger.review_provenance()
        self.assertEqual(set(provenance["selectedAttempts"]), set(expected_max))
        self.assertTrue(all(item["selectedAttempt"] == 1 for item in provenance["selectedAttempts"].values()))
        for record in provenance["attemptEvidence"]:
            evidence = ROOT / record["path"]
            self.assertTrue(evidence.is_file())
            self.assertEqual(capture.sha256_file(evidence), record["sha256"])
            text = evidence.read_text(encoding="utf-8")
            self.assertNotIn("Employer cost appears", text)
            self.assertNotIn("Synthetic fact", text)

    def test_attempt_evidence_rejects_secret_shaped_observations(self) -> None:
        ledger = self.ledger()
        with self.assertRaisesRegex(capture.GateError, "sensitive key"):
            ledger.record(
                stage="explorer-recall",
                attempt=1,
                outcome="selected",
                classification="strict-qwen-narrator",
                observation={"apiToken": "must-not-write"},
            )
        self.assertFalse((ledger.output_dir / "attempts").exists())

    def test_private_capture_run_removes_stale_generated_outputs_only(self) -> None:
        private = self.ROOT / "private-originals"
        private.mkdir()
        canonical = private / "alibaba-ecs-overview-raw.png"
        canonical.write_bytes(b"canonical-source")
        unrelated = private / "reviewer-credential.json"
        unrelated.write_text('{"token":"fixture-only"}\n', encoding="utf-8")
        stale_raw = private / "01-grounded-cross-session-recall-raw.png"
        stale_raw.write_bytes(b"stale")
        stale_probe = private / "health.json"
        stale_probe.write_text('{"status":"stale"}\n', encoding="utf-8")
        old_attempt = private / "runs" / "old-run" / "attempts" / "attempt.json"
        old_attempt.parent.mkdir(parents=True)
        old_attempt.write_text("{}\n", encoding="utf-8")
        snapshot = self.ROOT / "attempt-snapshots" / "attempt-3.json"
        snapshot.parent.mkdir()
        snapshot.write_text('{"status":"preserved"}\n', encoding="utf-8")

        run_dir = capture.prepare_private_capture_run(
            "20000101T000000Z-00000001",
            private_root=private,
            protected_inputs=(canonical, unrelated),
        )
        self.assertTrue(run_dir.is_dir())
        self.assertEqual(canonical.read_bytes(), b"canonical-source")
        self.assertTrue(unrelated.is_file())
        self.assertFalse(stale_raw.exists())
        self.assertFalse(stale_probe.exists())
        self.assertFalse(old_attempt.exists())
        self.assertTrue(snapshot.is_file())

        second = capture.prepare_private_capture_run(
            "20000101T000001Z-00000002",
            private_root=private,
            protected_inputs=(canonical, unrelated),
        )
        self.assertTrue(second.is_dir())
        self.assertFalse(run_dir.exists())
        self.assertTrue(snapshot.is_file())

    def test_private_cleanup_refuses_to_delete_a_declared_input(self) -> None:
        private = self.ROOT / "private-overlap"
        protected = private / "runs" / "prior" / "source.png"
        protected.parent.mkdir(parents=True)
        protected.write_bytes(b"input")
        with self.assertRaisesRegex(capture.GateError, "input overlaps"):
            capture.prepare_private_capture_run(
                "20000101T000000Z-00000003",
                private_root=private,
                protected_inputs=(protected,),
            )
        self.assertEqual(protected.read_bytes(), b"input")

    def test_capture_retry_artifacts_refuse_paths_outside_the_project(self) -> None:
        outside = capture.REPO.parent / f"capture-resilience-must-not-create-{os.getpid()}"
        self.assertFalse(outside.exists())
        with self.assertRaisesRegex(capture.GateError, "escaped the repository"):
            capture.CaptureAttemptLedger("20000101T000000Z-00000004", outside)
        with self.assertRaisesRegex(capture.GateError, "escaped the repository"):
            capture.prepare_private_capture_run(
                "20000101T000000Z-00000005",
                private_root=outside,
            )
        self.assertFalse(outside.exists())


if __name__ == "__main__":
    unittest.main()
