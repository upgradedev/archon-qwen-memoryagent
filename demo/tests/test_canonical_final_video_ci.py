"""Release-contract tests for the canonical final-video GitHub Actions path."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest import mock
import uuid


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "canonical-final-video.yml"
TOOLS = ROOT / "demo" / "tools"
sys.path.insert(0, str(TOOLS))
import build_caption_video as caption
import compose_real_motion_video as motion

SPEC = importlib.util.spec_from_file_location("materialize_ci_evidence", TOOLS / "materialize_ci_evidence.py")
assert SPEC is not None and SPEC.loader is not None
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)


class CanonicalFinalVideoWorkflowTests(unittest.TestCase):
    def test_publication_audio_processing_contract_is_shared_exactly(self) -> None:
        self.assertEqual(caption.PUBLICATION_AUDIO_PROCESSING, motion.PUBLICATION_AUDIO_PROCESSING)

    def test_post_capture_allowlist_is_exactly_bounded_to_known_media_workflows(self) -> None:
        for allowed in (
            ".github/workflows/demo-video.yml",
            ".github/workflows/canonical-elevenlabs-narration.yml",
            ".github/workflows/canonical-final-video.yml",
        ):
            self.assertTrue(caption.allowed_submission_path(allowed))
        self.assertTrue(caption.allowed_submission_path("tests/docs/supply-chain-consistency.test.ts"))
        self.assertFalse(caption.allowed_submission_path(".github/workflows/unreviewed.yml"))
        self.assertFalse(caption.allowed_submission_path(".github/workflows/canonical-final-video.yaml"))
        self.assertFalse(caption.allowed_submission_path("tests/docs/unreviewed.test.ts"))
        self.assertFalse(caption.allowed_submission_path("tests/runtime/unreviewed.test.ts"))

    def test_workflow_is_main_only_hash_pinned_and_has_read_only_permissions(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("test \"$GITHUB_REF\" = 'refs/heads/main'", text)
        self.assertIn('test "$(git rev-parse HEAD)" = "$EXPECTED_SOURCE_SHA"', text)
        self.assertIn("actions: read\n  contents: read", text)
        self.assertNotIn("pull_request:", text)
        self.assertNotIn("push:", text)
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("uses:") or stripped.startswith("- uses:"):
                target = stripped.split("uses:", 1)[1].strip().split()[0]
                self.assertRegex(target, r"^[^@]+@[0-9a-f]{40}$")

    def test_workflow_reuses_exact_narration_and_never_synthesizes_or_uses_reviewer_key(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("NARRATION_RUN_ID: '29733820211'", text)
        self.assertIn("4ca7f130c297a4f7156a7ac917d8b10596f7f95ff7bcc1ce41a04f478acc35a7", text)
        self.assertIn("7d64a5ff47049b3a6584216e2f51a753c754b26c56bd5e04d5725911cf0a9802", text)
        self.assertIn("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", text)
        self.assertNotIn("ELEVEN_LABS_KEY:", text)
        self.assertNotIn("MEMORYAGENT_JUDGE_API_KEY:", text)
        self.assertNotIn("build_elevenlabs_narration.py", text)
        self.assertNotIn("edge-tts", text)

    def test_workflow_provisions_exact_external_ffmpeg_before_any_live_capture(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/assets/482421474", text)
        self.assertIn("9b9efbd57c146eb2fc32d27c64c36b9ad5134eb0692b757836baaf298793afa0", text)
        self.assertIn("FFMPEG_ASSET_BYTES: '118992068'", text)
        self.assertIn("echo \"$FFMPEG_ASSET_SHA256  $archive\" | sha256sum --check --strict", text)
        self.assertIn('echo "MEMORYAGENT_FFMPEG_EXECUTABLE=$ffmpeg" >> "$GITHUB_ENV"', text)
        self.assertIn('echo "MEMORYAGENT_FFPROBE_EXECUTABLE=$ffprobe" >> "$GITHUB_ENV"', text)
        provision = text.index("Provision exact hash-gated ffmpeg and ffprobe")
        preflight = text.index("Pin authorized main source and immutable release inputs")
        capture = text.index("Record one public live interaction pass")
        self.assertLess(provision, preflight)
        self.assertLess(preflight, capture)
        self.assertNotIn("apt-get install -y ffmpeg", text)

    def test_workflow_uses_a_narrow_apparmor_profile_and_keeps_chromium_sandboxed(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        profile = text.index("Allow user namespaces only for the exact Playwright Chromium binary")
        capture = text.index("Record one public live interaction pass")
        self.assertLess(profile, capture)
        self.assertIn("profile memoryagent-playwright-chromium %s flags=(unconfined)", text)
        self.assertIn("'  userns,'", text)
        self.assertIn("chromium_sandbox=True", text)
        self.assertIn("Chromium sandbox smoke test: PASS", text)
        self.assertNotIn("apparmor_restrict_unprivileged_userns=0", text)
        self.assertNotIn("--no-sandbox", text)

    def test_workflow_checkpoints_public_capture_before_build_verify_and_final_upload(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        capture = text.index("Record one public live interaction pass")
        checkpoint = text.index("Checkpoint the successful public live capture immediately")
        reuse = text.index("Reuse one exact successful public live-capture checkpoint")
        build = text.index("Build canonical narrated real-motion final")
        verify = text.index("Independently verify final bundle")
        upload = text.index("Upload verified final-video bundle")
        self.assertLess(capture, checkpoint)
        self.assertLess(checkpoint, build)
        self.assertLess(reuse, build)
        self.assertLess(build, verify)
        self.assertLess(verify, upload)
        self.assertEqual(text.count("python demo/tools/record_live_motion.py \\"), 1)
        self.assertIn("python demo/tools/compose_real_motion_video.py --verify-only", text)
        self.assertIn("canonical-live-capture-${{ github.sha }}", text)
        self.assertIn("canonical-final-video-${{ github.sha }}", text)
        for required_input in (
            ".artifacts/deploy/exact-merged-deploy-output-attempt-27.txt",
            ".artifacts/deploy/exact-merged-deploy-status-attempt-27.json",
            ".artifacts/final-video/base-*/caption-base.mp4",
            ".artifacts/final-video/base-*/caption-base.manifest.json",
            ".artifacts/final-video/memoryagent-live-interaction.webm",
            ".artifacts/final-narration/memoryagent-narration.wav",
        ):
            self.assertIn(required_input, text)

    def test_fresh_and_reused_capture_paths_are_exclusive_and_hash_bound(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("reuse_capture_run_id:", text)
        self.assertIn("reuse_capture_source_sha:", text)
        self.assertGreaterEqual(text.count("if: ${{ inputs.reuse_capture_run_id == '' }}"), 3)
        self.assertEqual(text.count("if: ${{ inputs.reuse_capture_run_id != '' }}"), 1)
        self.assertIn('[[ "$REUSE_CAPTURE_RUN_ID" =~ ^[0-9]+$ ]]', text)
        self.assertIn('[[ "$REUSE_CAPTURE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]', text)
        self.assertIn(
            'git merge-base --is-ancestor "$REUSE_CAPTURE_SOURCE_SHA" "$EXPECTED_SOURCE_SHA"',
            text,
        )
        self.assertIn("canonical-live-capture-${{ inputs.reuse_capture_source_sha }}", text)
        self.assertIn("run-id: ${{ inputs.reuse_capture_run_id }}", text)


class MaterializeCiEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = ROOT / ".artifacts" / "deploy" / f"materialize-test-{os.getpid()}-{uuid.uuid4().hex}"
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def run_materializer(self, output: bytes, status: bytes, *, output_hash: str | None = None) -> int:
        output_rel = (self.root / "output.txt").relative_to(ROOT).as_posix()
        status_rel = (self.root / "status.json").relative_to(ROOT).as_posix()
        env = {
            evidence.SECRET_NAMES["output"]: base64.b64encode(output).decode("ascii"),
            evidence.SECRET_NAMES["status"]: base64.b64encode(status).decode("ascii"),
        }
        with mock.patch.dict(os.environ, env, clear=False):
            return evidence.main([
                "--output-path", output_rel,
                "--output-sha256", output_hash or hashlib.sha256(output).hexdigest(),
                "--output-bytes", str(len(output)),
                "--status-path", status_rel,
                "--status-sha256", hashlib.sha256(status).hexdigest(),
                "--status-bytes", str(len(status)),
            ])

    def test_materializes_exact_bytes_once_without_logging_secret_values(self) -> None:
        output = b"sanitized exact deployment output\n"
        status = b'{"status":"Success"}\n'
        with mock.patch("builtins.print") as printed:
            self.assertEqual(self.run_materializer(output, status), 0)
        self.assertEqual((self.root / "output.txt").read_bytes(), output)
        self.assertEqual((self.root / "status.json").read_bytes(), status)
        rendered = " ".join(str(call) for call in printed.call_args_list)
        self.assertNotIn(base64.b64encode(output).decode("ascii"), rendered)
        self.assertNotIn(output.decode().strip(), rendered)
        self.assertEqual(self.run_materializer(output, status), 2)

    def test_rejects_hash_mismatch_without_materializing_any_file(self) -> None:
        output = b"sanitized exact deployment output\n"
        status = b'{"status":"Success"}\n'
        self.assertEqual(self.run_materializer(output, status, output_hash="0" * 64), 2)
        self.assertFalse((self.root / "output.txt").exists())
        self.assertFalse((self.root / "status.json").exists())

    def test_rejects_destination_outside_ignored_deploy_root(self) -> None:
        with self.assertRaises(evidence.EvidenceError):
            evidence.project_output("demo/final-media/evidence.txt", "deployment output")


if __name__ == "__main__":
    unittest.main()
