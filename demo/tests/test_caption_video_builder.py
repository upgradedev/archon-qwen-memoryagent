"""Offline regression tests for the caption-led final-video builder."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


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


class CaptionTimelineTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
