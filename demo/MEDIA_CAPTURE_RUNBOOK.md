# Final submission-media capture gate

This is the one-command, fail-closed path from an exact-deployed MemoryAgent release
to the final Devpost gallery, video proof frames, YouTube thumbnail and English
subtitle file. It never publishes anything. Every persistent input and output must
remain inside this repository.

## What the gate proves before it writes finals

The capture exits non-zero unless all of these are true:

- the supplied 40-character MemoryAgent SHA exists locally;
- the project-contained deployment status is terminal `Success`, exit `0`, and
  records that exact SHA;
- the decoded deployment output contains exact-checkout, exact-app success and
  final exact-deploy success markers for that SHA;
- the deployed SHA is an ancestor of current `origin/main`, and every later path is
  submission-only according to the script's explicit allowlist;
- `/health` reports `text-embedding-v4`, `qwen-plus`, a non-Fake judge and 1,024
  dimensions;
- `/ready` proves database, Qwen configuration and reviewer authentication ready;
- authenticated `/ready/deep` proves the embedder operational and grounded
  narration passed;
- the final OpenAPI routes exist, public seed retry is idempotent, and selected-
  company Northwind P&L returns the canonical one-currency totals;
- the live Explorer produces cited recall, the `INV-5521` 8,400/8,900 field
  contradiction, the complete Qwen meaning-level contradiction and the human
  control boundary;
- safe-default forgetting previews first and then records a confirmed audited
  no-op without deleting active memory;
- GitHub's unauthenticated API reports the repository public, default branch
  `main`, and SPDX license `MIT`;
- the Alibaba raw screenshot exactly matches its human-reviewed SHA-256/redaction
  profile. A new screenshot cannot reuse old masks;
- no file under `demo/private-originals/` is tracked.

`/health` and `/ready` are never treated as commit attestation. The exact runtime
claim comes only from the deployment evidence; live probes independently prove
models and readiness.

## Dependencies

Reuse the already-installed Python 3.11, Pillow, Playwright/Chromium and ffmpeg
environment when available. Do not create a duplicate browser cache or virtual
environment merely for this gate. Only when a dependency is missing, install the
repository's hash-locked media environment:

```bash
python -m pip install --require-hashes -r requirements/video-demo.lock
python -m playwright install chromium
python scripts/capture_submission_gallery.py --self-test
```

The self-test writes only ignored fixtures under `.artifacts/`. It never contacts
the live service and never creates judge-facing evidence.

Browser process temp/profile/cache paths are redirected to the ignored
`demo/private-originals/browser-runtime/` directory and removed when capture ends.
Fixed raw filenames are overwritten, and the gate fails if retained private capture
scratch exceeds 256 MiB.

## Inputs

Keep all inputs inside this project:

1. Exact deployment output and sanitized status JSON under `.artifacts/deploy/`.
2. The raw Alibaba ECS overview at
   `demo/private-originals/alibaba-ecs-overview-raw.png`.
3. The dedicated, low-privilege reviewer token in the explicitly requested ignored
   `.artifacts/devpost/memory-reviewer-credential.json` `token` field, or in the
   process environment only. Never use both sources in one run.
4. Preferably the final renderer's measured `caption_windows.json`,
   `video_manifest.json`, and exact `narration_web.txt`, copied into an ignored
   repo-local working folder.

The checked-in [`alibaba-redaction-profile.json`](./alibaba-redaction-profile.json)
is bound to one reviewed 1600×842 raw capture. It crops out the account header and
opaque-masks the instance id, instance name and raw public IP before any final is
made. If the raw capture changes, stop: review it visually and update the profile's
hash, dimensions, crop and masks in a separate review. Never bypass the hash check.

## One final command

Run from the repository root after the exact deployment finishes. Replace only the
runtime SHA and attempt number with the values from that completed run:

```bash
python scripts/capture_submission_gallery.py \
  --expected-sha 0000000000000000000000000000000000000000 \
  --deployment-output .artifacts/deploy/exact-merged-deploy-output-attempt-N.txt \
  --deployment-status .artifacts/deploy/exact-merged-deploy-status-attempt-N.json \
  --reviewer-credential-json .artifacts/devpost/memory-reviewer-credential.json \
  --alibaba-raw demo/private-originals/alibaba-ecs-overview-raw.png \
  --caption-windows .artifacts/final-video/caption_windows.json \
  --video-manifest .artifacts/final-video/video_manifest.json \
  --web-narration .artifacts/final-video/narration_web.txt
```

The zero SHA and `N` above are intentional measured-release placeholders; never
run them unchanged. The script refuses a tracked or non-ignored credential JSON,
reads only its `token` field in memory, and never copies or serializes it. If the
ignored JSON is unavailable, use `DEMO_JUDGE_API_KEY` as the sole source; on
PowerShell acquire it with `Read-Host -AsSecureString`, convert it only for the
child process, and clear both the environment variable and unmanaged buffer in a
`finally` block. Do not put the token in command history.

If final measured caption windows do not exist yet, the only permitted preliminary
mode is an explicitly unmeasured draft:

```bash
python scripts/capture_submission_gallery.py ... \
  --allow-canonical-caption-fallback
```

That fallback is recorded as `canonical-unmeasured-draft` in the capture review.
Regenerate with the measured files before publishing the video or uploading its
captions.

## Deterministic outputs

Devpost finals are 1500×1000 (3:2). Each is generated from a no-crop, center-safe
1920×1080 source frame. The exact video equivalents are written to
`demo/final-media/proof-frames/<gallery-stem>-16x9.png`.

| Devpost final | 16:9 video mapping |
|---|---|
| `gallery/01-grounded-cross-session-recall.png` | `proof-frames/01-grounded-cross-session-recall-16x9.png` |
| `gallery/02-read-only-field-self-audit.png` | `proof-frames/02-read-only-field-self-audit-16x9.png` |
| `gallery/03-qwen-semantic-self-audit.png` | `proof-frames/03-qwen-semantic-self-audit-16x9.png` |
| `gallery/04-human-resolution-control.png` | `proof-frames/04-human-resolution-control-16x9.png` |
| `gallery/05-safe-memory-lifecycle.png` | `proof-frames/05-safe-memory-lifecycle-16x9.png` |
| `gallery/06-qwen-memoryagent-architecture.png` | `proof-frames/06-qwen-memoryagent-architecture-16x9.png` |
| `gallery/07-live-health-readiness.png` | `proof-frames/07-live-health-readiness-16x9.png` |
| `gallery/08-alibaba-runtime-proof.png` | `proof-frames/08-alibaba-runtime-proof-16x9.png` |
| `gallery/09-public-repository-license.png` | `proof-frames/09-public-repository-license-16x9.png` |

Additional outputs:

- `demo/final-media/youtube-thumbnail.png` — 1280×720, original project visuals;
- `demo/final-media/memoryagent-demo.en.srt` — English subtitles from measured
  windows, with the separately measured browser beat when its manifest/narration
  are supplied;
- `demo/gallery/CAPTURE_REVIEW.json` — exact runtime/source split, model ids, gate
  outcomes and SHA-256 for every reviewed deliverable;
- ignored response JSON, raw browser screenshots and the sanitized Alibaba
  intermediate under `demo/private-originals/`.

The script synthesizes no voice, publishes nothing, and makes no voice or media
rights attestation.

## Final human review

After a green run:

```bash
git status --ignored --short demo/
git ls-files demo/private-originals/
```

The second command must print nothing. Open every 3:2 final at 100% and thumbnail
size, and every 16:9 proof frame at 1080p. Confirm that:

- no account, email, avatar, instance id/name, raw IP, token field value, request
  header, private host, notification or browser-profile data is visible;
- Alibaba masks fully cover all identifiers and retain only the qualifying ECS
  product/region/running-resource context;
- model ids, numbers, captions and exact-runtime footer agree with
  `CAPTURE_REVIEW.json` and the claim/evidence matrix;
- the thumbnail's text remains readable on a small YouTube card;
- the SRT timing matches the actual final MP4, including the browser beat;
- `demo/private-originals/` remains ignored and unstaged.

Only then stage the reviewed finals. Raw captures and reviewer credentials never
belong in Git, Devpost, the public video or its metadata.
