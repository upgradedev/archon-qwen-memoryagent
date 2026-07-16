# Build the final caption-led video

This is the preferred rights-safe final assembly path. It produces the canonical
**172-second**, ten-beat MemoryAgent video without speech synthesis, recorded voice,
or third-party music. Every English caption is burned into the 1920×1080 picture and
mirrored in an exact measured SRT. The compatibility audio stream is generated
digital silence (48 kHz stereo AAC), not music or TTS.

The builder does not call the live service, capture a browser, download an asset, or
create substitute evidence. It can assemble a final only after the exact-release
gallery gate has produced all approved media. Until
[`../deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) is green and the canonical
gallery exists, production mode is expected to fail.

## 1. Verify the offline compositor

Run from the repository root:

```bash
python -m py_compile demo/tools/build_caption_video.py
python -m unittest discover -s demo/tests -p 'test_caption_video_builder.py' -v
python demo/tools/build_caption_video.py --self-test
# Slower pre-release acceptance of the complete 172-second / 5,160-frame encode:
python demo/tools/build_caption_video.py --full-self-test
```

Both self-tests create only unmistakably watermarked synthetic fixtures under the
ignored `.artifacts/caption-video-selftest/` directory. Their MP4s are named
`SELF-TEST-NOT-SUBMISSION-EVIDENCE.mp4` or
`FULL-172S-SELF-TEST-NOT-SUBMISSION-EVIDENCE.mp4`; neither is a final or
live-evidence source. The full run replaces the fast self-test scratch in that
dedicated ignored directory.

## 2. Lock the exact caption timeline before final capture

```bash
python demo/tools/build_caption_video.py \
  --emit-caption-windows .artifacts/final-caption-video/caption_windows.json
```

The output is the canonical frame-aligned plan consumed by
[`capture_submission_gallery.py`](../scripts/capture_submission_gallery.py):

| Beat | Window | Frames at 30 fps |
|---|---:|---:|
| Stakes + Track 1 | 0:00–0:13 | 390 |
| Exact live proof + Qwen vision | 0:13–0:32 | 570 |
| Architecture + bounded scale path | 0:32–0:51 | 570 |
| Cross-session memory | 0:51–1:13 | 660 |
| Self-audit + human control | 1:13–1:35 | 660 |
| Feedback persists across sessions | 1:35–1:53 | 540 |
| Meaning-level audit + MCP | 1:53–2:10 | 510 |
| Timely forgetting | 2:10–2:22 | 360 |
| Evidence, not hype | 2:22–2:42 | 600 |
| Alibaba + public-source close | 2:42–2:52 | 300 |

Total: **5,160 frames / 172.000 seconds**, strictly below the 175-second
publication safety ceiling.

Pass that JSON to the one-command final capture gate documented in
[`MEDIA_CAPTURE_RUNBOOK.md`](./MEDIA_CAPTURE_RUNBOOK.md):

```bash
python scripts/capture_submission_gallery.py \
  --expected-sha <FINAL_RUNTIME_SHA> \
  --deployment-output .artifacts/deploy/exact-merged-deploy-output-attempt-<ATTEMPT>.txt \
  --deployment-status .artifacts/deploy/exact-merged-deploy-status-attempt-<ATTEMPT>.json \
  --reviewer-credential-json .artifacts/devpost/memory-reviewer-credential.json \
  --alibaba-raw demo/private-originals/alibaba-ecs-overview-raw.png \
  --caption-windows .artifacts/final-caption-video/caption_windows.json
```

Both placeholders remain unresolved until a real successful final deployment exists.
Do not use the command while the deployment contract says **REDEPLOY REQUIRED**.

## 3. Validate every final input without encoding

After a human has reviewed all gallery/proof frames and the capture gate has written
`demo/gallery/CAPTURE_REVIEW.json`:

```bash
python demo/tools/build_caption_video.py \
  --expected-sha <FINAL_RUNTIME_SHA> \
  --deployment-output .artifacts/deploy/exact-merged-deploy-output-attempt-<ATTEMPT>.txt \
  --deployment-status .artifacts/deploy/exact-merged-deploy-status-attempt-<ATTEMPT>.json \
  --check-only
```

This is a cryptographic freshness gate, not a filename check. It requires:

- a green canonical `DEPLOY_STATE.md` naming the expected SHA;
- the builder, deployment state, and claim/evidence matrix committed and byte-equal
  to current HEAD, so the final manifest identifies the actual gate source;
- successful, terminal, project-contained deployment status plus exactly one
  ordered checkout/app marker pair for that same SHA; strict evidence requires a
  terminal final marker, while the recorded provider-truncation fallback requires
  the app marker itself to be terminal;
- immutable read-once status/output bytes whose project-relative paths, lengths,
  SHA-256 values and strict/fallback evidence mode exactly match the passed capture
  review;
- producer-bound `invocationId` and `commandId` values, with status-side
  `outputSha256` and `outputBytes` recomputed from that exact output snapshot;
- a passed capture review whose runtime/source ancestry is compatible with current
  HEAD and whose later/dirty paths are submission-only;
- real `text-embedding-v4`, `qwen-plus`, `qwen-vl-max`, 1,024 dimensions, a real
  Qwen judge, and every release/capture gate set to its safe value;
- the locked Qwen-VL zero-write dry-run, Session-A → fresh-Session-B feedback,
  Defer-only human-control, and one-row lifecycle result with zero marker residue;
- all eleven 1500×1000 gallery finals, all eleven 1920×1080 proof frames (the ten
  evidence frames plus the architecture wrapper), the independently source-bound
  canonical architecture raster, and every other reviewed artifact at the SHA-256
  recorded in the capture review; and
- `subtitleTimingSource=measured-caption-windows` plus an SRT that exactly equals the
  deterministic ten-beat text and boundaries. A draft/fallback SRT is rejected.

Missing media, a changed byte, stale source ancestry, a runtime-affecting working-tree
change, a red deploy state, or an unmeasured/mismatched SRT stops the build before an
output or scratch directory is created.

The deploy-state gate recognizes only one exact machine-readable record whose SHA
matches the requested runtime:

```text
<!-- MEMORYAGENT_DEPLOY_STATE_V1 status=LIVE_VERIFIED_READY runtime_sha=<FINAL_RUNTIME_SHA> -->
```

Human prose such as `NOT READY` or `UNVERIFIED`, a loose SHA elsewhere in the file,
or duplicate machine records cannot make the build green. Until a new exact
deployment writes that single record, production mode remains blocked.

The builder retains immutable snapshots of every input it validates. Its tracked
gate sources are compared directly with their current `HEAD` blobs after Git clean
filtering. Encoding occurs only in a newly randomized project-contained scratch
child; frame, concat, log and final `.writing` files are created exclusively without
following pre-seeded links.

## 4. Build and verify the canonical final

Run the same command without `--check-only`:

```bash
python demo/tools/build_caption_video.py \
  --expected-sha <FINAL_RUNTIME_SHA> \
  --deployment-output .artifacts/deploy/exact-merged-deploy-output-attempt-<ATTEMPT>.txt \
  --deployment-status .artifacts/deploy/exact-merged-deploy-status-attempt-<ATTEMPT>.json
```

Outputs:

- `demo/final-media/memoryagent-demo.mp4` — canonical 1920×1080 H.264 final;
- `demo/final-media/memoryagent-demo.en.srt` — exact ten-entry English SRT (the
  builder re-emits only the byte-identical file already SHA-bound by capture review);
- `demo/final-media/memoryagent-demo.manifest.json` — release/input/output hashes,
  exact frame windows, measured duration/codecs, decoded silence peak, and claim
  locks; and
- `.artifacts/final-caption-video/` — ignored, repository-contained rendered beats
  and ffmpeg diagnostics.

The permanent post-encode gate requires exactly one H.264/yuv420p 1920×1080 video
stream at 30 fps, exactly 5,160 frames, one 48 kHz stereo AAC stream, decoded audio
peak no greater than four signed-16-bit units, measured duration matching 172 seconds,
and no extra stream or sensitive-shaped metadata.

## 5. Human acceptance remains mandatory

Open the final at normal 1080p playback size and at 0.25×. Confirm captions never
cover required evidence; every sanitized source label is readable; no secret or
identifier is visible; and the metric/claim boundaries remain intact:

- all business records, including `INV-5521`, are original synthetic demo data;
- fixtures are developer-labelled/offline, not production accuracy or independent
  evaluation, and make no universal-superiority claim;
- audit detects disagreement and recommends; the captured live human-control proof
  exercises Defer only with zero API call/write, while Accept/Override stay unclaimed;
- the readable proof may show pure cosine while the product default remains hybrid;
- the original synthetic two-PNG Qwen-VL canary is a zero-write dry-run, not raw-PDF
  parsing; explicit feedback is persisted state, not training or model-weight change;
- forgetting targets exactly one feedback-superseded synthetic row, not an
  age-expired row, and preserves protected state with zero marker residue; and
- Alibaba ECS + self-hosted pgvector is active, while Function Compute/RDS is an
  alternative only.

Then complete [`VIDEO_RECORDING_CHECKLIST.md`](./VIDEO_RECORDING_CHECKLIST.md). A
green local manifest does not authorize upload or publication.
