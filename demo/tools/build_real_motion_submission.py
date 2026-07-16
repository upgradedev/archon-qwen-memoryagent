#!/usr/bin/env python3
"""One-command final MemoryAgent render: exact-gated base + real live motion."""
from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path
from typing import Sequence

import build_caption_video as caption
import compose_real_motion_video as motion


ROOT = Path(__file__).resolve().parents[2]


def require(value: bool, message: str) -> None:
    if not value:
        raise motion.GateError(message)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--deployment-output", required=True)
    parser.add_argument("--deployment-status", required=True)
    parser.add_argument("--live-video", default=".artifacts/final-video/memoryagent-live-interaction.webm")
    parser.add_argument("--interaction-manifest", default=".artifacts/final-video/memoryagent-live-interaction.manifest.json")
    parser.add_argument("--capture-review", default="demo/gallery/CAPTURE_REVIEW.json")
    parser.add_argument("--thumbnail", default="demo/final-media/youtube-thumbnail.png")
    parser.add_argument("--output", default="demo/final-media/memoryagent-demo.mp4")
    parser.add_argument("--srt-output", default="demo/final-media/memoryagent-demo.en.srt")
    parser.add_argument("--manifest", default="demo/final-media/memoryagent-demo.manifest.json")
    parser.add_argument("--qa", default="demo/final-media/memoryagent-demo.qa.json")
    parser.add_argument("--scratch", default=".artifacts/final-video")
    parser.add_argument("--overlay-start", type=float, default=13.0)
    parser.add_argument("--overlay-end", type=float, default=32.0)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        expected_sha = str(args.expected_sha).lower()
        require(caption.SHA40.fullmatch(expected_sha) is not None, "--expected-sha must be 40 lowercase hex characters")
        capture_review = motion.project_path(args.capture_review, "CAPTURE_REVIEW", exists=True)
        deployment_output = motion.project_path(args.deployment_output, "deployment output", exists=True)
        deployment_status = motion.project_path(args.deployment_status, "deployment status", exists=True)
        deploy_state = motion.project_path(caption.DEPLOY_STATE_REL, "deployment state", exists=True)
        live_video = motion.project_path(args.live_video, "live video", exists=True)
        interaction_manifest = motion.project_path(args.interaction_manifest, "interaction manifest", exists=True)
        thumbnail = motion.project_path(args.thumbnail, "thumbnail", exists=True)
        output = motion.project_path(args.output, "output")
        output_srt = motion.project_path(args.srt_output, "SRT output")
        manifest_path = motion.project_path(args.manifest, "manifest")
        qa_path = motion.project_path(args.qa, "QA")
        scratch_root = motion.project_path(args.scratch, "scratch")
        require(motion.relative(scratch_root).startswith(".artifacts/final-video"), "scratch must stay under .artifacts/final-video")
        for final in (output, output_srt, manifest_path, qa_path):
            require(final.parent == ROOT / "demo" / "final-media", "final files must be directly under demo/final-media")

        validated = caption.validate_inputs(
            expected_sha=expected_sha,
            capture_review=capture_review,
            artifact_root=ROOT,
            deployment_output=deployment_output,
            deployment_status=deployment_status,
            deploy_state=deploy_state,
        )
        session = scratch_root / f"base-{expected_sha[:12]}-{secrets.token_hex(8)}"
        base_video = session / "caption-base.mp4"
        base_srt = session / "caption-base.en.srt"
        base_manifest = session / "caption-base.manifest.json"
        base_scratch = session / "render"
        caption.build_video(
            validated,
            output=base_video,
            srt_path=base_srt,
            manifest_path=base_manifest,
            scratch=base_scratch,
        )
        result = motion.compose(
            base_video=base_video,
            live_video=live_video,
            interaction_manifest=interaction_manifest,
            evidence_manifest=capture_review,
            srt=base_srt,
            output_srt=output_srt,
            thumbnail=thumbnail,
            output=output,
            manifest_path=manifest_path,
            qa_path=qa_path,
            scratch=session / "compose",
            expected_sha=expected_sha,
            expected_url=caption.EXPECTED_LIVE_ORIGIN,
            overlay_start=args.overlay_start,
            overlay_end=args.overlay_end,
            replace=args.replace,
        )
        duration = result["qa"]["duration"]["finalSeconds"]
        print(
            f"MemoryAgent real-motion submission: PASS · {duration:.3f}s · 1920x1080 · "
            f"silent/caption-led · exact SHA {expected_sha[:12]} · base retained in {motion.relative(session)}"
        )
        return 0
    except (caption.GateError, motion.GateError, OSError, UnicodeError, ValueError) as exc:
        print(f"MemoryAgent real-motion submission: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
