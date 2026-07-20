# Final judge-facing media

The canonical real-motion production and QA commands are in
[`../REAL_MOTION_VIDEO.md`](../REAL_MOTION_VIDEO.md). They never publish or upload.

Before any production build or independent verification, replace these placeholders
with absolute executable paths reviewed for this release:

```powershell
$env:MEMORYAGENT_GIT_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_GIT_EXECUTABLE>'
$env:MEMORYAGENT_FFMPEG_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFMPEG_EXECUTABLE>'
$env:MEMORYAGENT_FFPROBE_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFPROBE_EXECUTABLE>'
```

ffmpeg and ffprobe must be siblings from the same reviewed toolchain directory.
Production and `--verify-only` execution use only those identity-bound, SHA-bound
files and never discover Git, ffmpeg, or ffprobe from the working directory or
`PATH`. PATH discovery is permitted only for explicitly labelled non-submission
self-tests when all three variables are unset.

- `judge-architecture.jpg` — 1600×900 browser-rendered raster for Devpost and the slide deck.
- Source: [`../../docs/judge-architecture.svg`](../../docs/judge-architecture.svg), retained as an editable, accessible 16:9 vector.
- Publication sanitization is lossless and reproducible: run
  `node scripts/sanitize-jpeg-metadata.mjs demo/final-media/judge-architecture.jpg --in-place --expect 1600x900x3`,
  then repeat with `--verify-only`. The script removes COM/EXIF/XMP/IPTC-style
  application metadata while retaining color-critical JFIF, ICC, and Adobe transform
  markers when present. Its scan SHA-256 and three-component frame check prove the
  dimensions and compressed color payload did not change.
- The separate Devpost gallery thumbnail is [`../thumbnail.png`](../thumbnail.png),
  a 1500×1000 (3:2) raster rendered from [`../thumbnail.svg`](../thumbnail.svg).
- `memoryagent-demo.mp4` — reserved canonical path for the 172-second caption-led
  **real-motion** final. The only publication pipeline is
  [`../REAL_MOTION_VIDEO.md`](../REAL_MOTION_VIDEO.md): it renders the static caption
  composition only as an intermediate scratch base, then inserts SHA-bound genuine
  browser interaction. It uses the explicitly disclosed, entrant-approved ElevenLabs
  voice/model pair, exact five-item history recovery, five-request completion and bounded
  deterministic time-fit, with no fallback voice, human voice, or third-party music.
  Digital silence is rejected. The exact narration WAV and JSON manifest are created
  under ignored `.artifacts/final-narration/` by
  [`../tools/build_local_narration.py`](../tools/build_local_narration.py). The final
  remains absent until the exact deploy, sanitized gallery, SHA-bound capture review,
  narration gate, live recording, automated checks, and every human item in
  `../FINAL_MEDIA_CHECKLIST.md` pass.
- `memoryagent-demo.en.srt` — exact ten-beat measured captions. The final builder
  refuses any byte/timing mismatch with the burned 5,160-frame timeline.
- The inert, tracked [`../caption-timeline.json`](../caption-timeline.json) is the
  single caption/timing source for both capture preflight and video rendering.
  Capture reads the ignored measured windows once, binds their SHA-256 in
  `CAPTURE_REVIEW.json`, and refuses any difference before a live model call. The
  narration generator also binds this exact tracked file, speaks one complete segment
  per beat, and fails instead of truncating speech.
- `memoryagent-demo.manifest.json` — required real-motion cryptographic build record:
  exact runtime/source heads, upstream/downstream hashes, measured codecs/duration,
  narration WAV/manifest/voice/timeline hashes, non-silent and no-clipping audio
  measurements, live-interaction binding, and claim locks.
- `memoryagent-demo.qa.json` — required independent measured QA record for the shipped
  MP4/SRT. Both JSON records must report `status: passed`, and
  `python demo/tools/compose_real_motion_video.py --verify-only` must pass with the
  three pre-reviewed executable variables still set, against their unchanged hashes
  immediately before upload. A static caption-base manifest is intermediate evidence
  only and is not accepted here.

The judge-facing hero intentionally excludes unfinished model-promotion work. Its
productization card shows only shipped surfaces: tenant-scoped REST/MCP, a pg-wire
storage seam, and the MIT-licensed core. Historical or candidate benchmark artifacts
belong in the technical evidence appendix, never as a pending card in the required
architecture image.
