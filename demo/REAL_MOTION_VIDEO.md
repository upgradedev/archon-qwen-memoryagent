# Final real-motion submission video

This is the publication candidate path. It keeps the existing ten claim-locked,
caption-led beats, but replaces the 00:51–01:13 cross-session-recall panel with
**genuine live browser interaction** against the final deployed MemoryAgent. The
00:13–00:32 exact-release, readiness, and Qwen vision proof remains visible and is
never covered by unrelated interaction footage. Nothing is uploaded or published by
these commands.

Production capture is intentionally blocked until the exact deployment and
`demo/gallery/CAPTURE_REVIEW.json` both pass. The recorder never reads a reviewer
credential. It exercises only the idempotent public seed, public recall and public
browse flow; `#judgeToken` must remain blank for the entire recording.

## Deterministic offline acceptance

Run from the repository root before touching the live service:

```powershell
python -m py_compile demo/tools/record_live_motion.py demo/tools/compose_real_motion_video.py demo/tools/build_real_motion_submission.py
python demo/tools/record_live_motion.py --self-test
python demo/tools/compose_real_motion_video.py --self-test
```

The self-tests create only ignored, unmistakably labelled fixture artifacts below
`.artifacts/final-video/`. They verify a real browser recording, 1920×1080 pixels,
zero recorder audio streams, frame diversity, H.264/30 fps composition, decoded
digital silence, SRT bounds, evidence hashes and independent post-build re-verification.

## Final production run

The exact deployed runtime and matching attempt-22 evidence are already locked:

```powershell
$sha = '104a002820607c754d857473877da28b69ebb44d'

python demo/tools/record_live_motion.py `
  --expected-sha $sha `
  --capture-review demo/gallery/CAPTURE_REVIEW.json

python demo/tools/build_real_motion_submission.py `
  --expected-sha $sha `
  --deployment-output .artifacts/deploy/exact-merged-deploy-output-attempt-22.txt `
  --deployment-status .artifacts/deploy/exact-merged-deploy-status-attempt-22.json `
  --replace

python demo/tools/compose_real_motion_video.py --verify-only
```

The recorder fails unless the tracked `src/demo-data.ts` at final `HEAD` contains the
reviewed citation-explicit `DEMO_PRIMARY_RECALL_QUESTION`. It then verifies the real
request is byte-identical and carries `limit: 3`; the response must report
`qwen-plus`, one to three citations, `[1]`, and grounding `(passed, 1)` or
`(repaired, 2)`. The final compositor also binds the exact SHA, CAPTURE_REVIEW bytes,
interaction-video bytes, SRT and thumbnail.

Final judge-facing artifacts:

- `demo/final-media/memoryagent-demo.mp4`
- `demo/final-media/memoryagent-demo.en.srt`
- `demo/final-media/memoryagent-demo.manifest.json`
- `demo/final-media/memoryagent-demo.qa.json`
- `demo/final-media/youtube-thumbnail.png`

The MP4 has one locally generated silent AAC compatibility stream—no voice, TTS,
music or captured microphone/system audio. The final video, subtitles, manifest, QA
and thumbnail hashes must pass `--verify-only` immediately before upload.
