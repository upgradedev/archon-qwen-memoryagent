# Final real-motion submission video

This is the **only canonical publication-candidate pipeline**. It keeps the existing ten claim-locked,
captioned and narrated beats, but replaces the 00:51–01:13 cross-session-recall panel with
**genuine live browser interaction** against the final deployed MemoryAgent. The
00:13–00:32 exact-release, readiness, and Qwen vision proof remains visible and is
never covered by unrelated interaction footage. Nothing is uploaded or published by
these commands.

[`tools/build_caption_video.py`](./tools/build_caption_video.py) is an intermediate
base renderer only. The one-command real-motion builder invokes it with the hash-bound
canonical ElevenLabs narration bundle inside a randomized, project-contained scratch
directory before applying the SHA-bound live interaction. The bundle is generated
once by the dedicated main-only workflow, with no retry or fallback voice.
A directly exported static caption MP4 or its base manifest is never the publication
candidate, even if its own encode checks pass. Supporting guides must return here for
the production build and final acceptance.

Production capture is intentionally blocked until the exact deployment and
`demo/gallery/CAPTURE_REVIEW.json` both pass. The recorder never reads a reviewer
credential. It exercises only the idempotent public seed, public recall and public
browse flow; `#judgeToken` must remain blank for the entire recording.

## Deterministic offline acceptance

Run from the repository root before touching the live service or ElevenLabs. Replace the three
placeholders with absolute executable paths that were reviewed before this release;
ffmpeg and ffprobe must be siblings from the same reviewed toolchain directory:

```powershell
$env:MEMORYAGENT_GIT_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_GIT_EXECUTABLE>'
$env:MEMORYAGENT_FFMPEG_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFMPEG_EXECUTABLE>'
$env:MEMORYAGENT_FFPROBE_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFPROBE_EXECUTABLE>'

python -m py_compile demo/tools/record_live_motion.py demo/tools/compose_real_motion_video.py demo/tools/build_real_motion_submission.py
python demo/tools/build_local_narration.py --self-test
python demo/tools/record_live_motion.py --self-test
python demo/tools/compose_real_motion_video.py --self-test
```

All production and `--verify-only` subprocesses use only those configured files.
They do not select Git, ffmpeg, or ffprobe from the working directory or `PATH`, and
they fail if a configured file is not absolute, regular, non-reparse, pre-reviewed,
or unchanged from its bound identity and SHA-256. PATH discovery is available only
to the explicitly non-submission self-test fixtures when all three variables are
unset; it is never a production fallback.

The recorder and compositor self-tests create only ignored, unmistakably labelled
fixture artifacts below `.artifacts/final-video/`. The narration-validator self-test uses
the separate ignored `.artifacts/local-narration-selftest/` directory. They verify a
real browser recording, 1920×1080 pixels,
zero recorder audio streams, frame diversity, H.264/30 fps composition, non-silent
AAC narration preservation, clipping and digital-silence rejection, EBU R128
loudness and true-peak headroom, SRT bounds,
evidence hashes and independent post-build re-verification.

## Final production run

Set the exact deployed runtime and matching evidence from the current green
`deploy/DEPLOY_STATE.md` record:

```powershell
$sha = '<FINAL_RUNTIME_SHA>'
$deployOutput = '.artifacts/deploy/<FINAL_DEPLOY_OUTPUT>.txt'
$deployStatus = '.artifacts/deploy/<FINAL_DEPLOY_STATUS>.json'
$env:MEMORYAGENT_GIT_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_GIT_EXECUTABLE>'
$env:MEMORYAGENT_FFMPEG_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFMPEG_EXECUTABLE>'
$env:MEMORYAGENT_FFPROBE_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFPROBE_EXECUTABLE>'

gh workflow run canonical-elevenlabs-narration.yml `
  --repo upgradedev/archon-qwen-memoryagent `
  --ref main `
  -f expected_source_sha='<FINAL_MAIN_SHA>' `
  -f commercial_rights_approved=true

# After the one authorized run passes, download its exact two-file artifact into
# .artifacts/final-narration/ without renaming either file.

python demo/tools/record_live_motion.py `
  --expected-sha $sha `
  --capture-review demo/gallery/CAPTURE_REVIEW.json

python demo/tools/build_real_motion_submission.py `
  --expected-sha $sha `
  --deployment-output $deployOutput `
  --deployment-status $deployStatus `
  --replace

python demo/tools/compose_real_motion_video.py --verify-only
```

The recorder fails unless the tracked `scripts/capture_submission_gallery.py` at
final `HEAD` contains the reviewed capture-specific, one-sentence citation question.
That prompt asks for the same employer-cost fact as the public demo chip but excludes
unrequested amounts, ratios, counts and calculations; it contains no answer. The
recorder verifies the real request is byte-identical and carries `limit: 3`; the response must report
`qwen-plus`, one to three citations, `[1]`, and grounding `(passed, 1)` or
`(repaired, 2)`. The final compositor also binds the exact SHA, CAPTURE_REVIEW bytes,
interaction-video bytes, caption-base manifest, ElevenLabs narration WAV and manifest,
SRT and thumbnail. Voice id `pNInz6obpgDQGcFmaJgB`, the `eleven_multilingual_v2` model, request contract,
decoded PCM hashes and entrant-approved commercial/publication rights are disclosed
in the manifests. Generation uses the provider network once; no retry, fallback voice,
music or human voice is permitted.

Final judge-facing artifacts:

- `demo/final-media/memoryagent-demo.mp4`
- `demo/final-media/memoryagent-demo.en.srt`
- `demo/final-media/memoryagent-demo.manifest.json`
- `demo/final-media/memoryagent-demo.qa.json`
- `demo/final-media/youtube-thumbnail.png`

The MP4 has one preserved AAC stream containing disclosed, entrant-approved ElevenLabs
synthetic narration. It contains no human voice, music, fallback voice, or captured
microphone/system audio. Burned captions and the exact SRT remain required
for accessibility and muted playback. The final video, subtitles, manifest, QA,
narration evidence and thumbnail hashes must pass `--verify-only` immediately before
upload; decoded audio must be meaningfully non-silent and contain zero clipped samples.

Publication is blocked unless both
`demo/final-media/memoryagent-demo.manifest.json` and
`demo/final-media/memoryagent-demo.qa.json` report `status: passed`, the manifest
identifies `caption-led-real-motion-compositor-v3-narrated-immutable-inputs` and binds the exact capture
review, caption base, narration source/manifest and live-interaction bytes, and the
final `--verify-only` command exits successfully
against those unchanged files. No static-base output, workflow candidate, or manually
edited export can substitute for that manifest + QA + independent re-verification.
