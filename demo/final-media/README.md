# Final judge-facing media

The canonical real-motion production and QA commands are in
[`../REAL_MOTION_VIDEO.md`](../REAL_MOTION_VIDEO.md). They never publish or upload.

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
- `memoryagent-demo.mp4` — reserved canonical path for the 172-second caption-led,
  rights-reviewed final. The preferred builder uses no voice, TTS, or third-party
  music; it burns English captions and muxes generated digital silence for player
  compatibility. It is intentionally absent until the exact deploy, sanitized
  gallery, SHA-bound capture review, automated encode checks, and every human item in
  `../FINAL_MEDIA_CHECKLIST.md` pass. See [`../CAPTION_VIDEO_BUILD.md`](../CAPTION_VIDEO_BUILD.md).
- `memoryagent-demo.en.srt` — exact ten-beat measured captions. The final builder
  refuses any byte/timing mismatch with the burned 5,160-frame timeline.
- `memoryagent-demo.manifest.json` — reserved final cryptographic build record:
  exact runtime/source heads, upstream/downstream hashes, measured codecs/duration,
  silent-audio peak, timeline, and claim locks.

The judge-facing hero intentionally excludes unfinished model-promotion work. Its
productization card shows only shipped surfaces: tenant-scoped REST/MCP, a pg-wire
storage seam, and the MIT-licensed core. Historical or candidate benchmark artifacts
belong in the technical evidence appendix, never as a pending card in the required
architecture image.
