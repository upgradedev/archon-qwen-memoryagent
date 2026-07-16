# Final judge-facing media

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
- `memoryagent-demo.mp4` — reserved canonical path for the new authenticated,
  rights-reviewed, sub-175-second final capture. It is intentionally absent until
  the post-deploy recording passes every item in `../FINAL_MEDIA_CHECKLIST.md`.

The judge-facing hero intentionally excludes unfinished model-promotion work. Its
productization card shows only shipped surfaces: tenant-scoped REST/MCP, a pg-wire
storage seam, and the MIT-licensed core. Historical or candidate benchmark artifacts
belong in the technical evidence appendix, never as a pending card in the required
architecture image.
