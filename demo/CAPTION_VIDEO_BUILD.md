# Build and verify the static caption-led base

This guide covers the deterministic **intermediate base** used by the only canonical
publication pipeline, [`REAL_MOTION_VIDEO.md`](./REAL_MOTION_VIDEO.md). The base is a
**172-second**, ten-beat composition with locally generated synthetic narration and
no third-party music. Every English caption is burned into the 1920×1080 picture and
mirrored in an exact measured SRT. Production rejects digital silence: audio must
come from the SHA-bound canonical ElevenLabs narration bundle described below.

`build_caption_video.py` does not call the live service, capture a browser, download
an asset, or create substitute evidence. It is not a publication builder: the
real-motion one-command runner invokes it inside randomized ignored scratch and then
adds SHA-bound genuine browser interaction. A direct static MP4 or static manifest
must never be uploaded. Until
[`../deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) is green and the canonical
gallery exists, even the base production gate is expected to fail.

## 1. Verify the offline compositor

Run from the repository root. Replace each placeholder with an absolute executable
path that was reviewed before this release. The ffmpeg and ffprobe files must be
siblings from the same reviewed toolchain directory. Keep all three values set for
every later production media command in this guide:

```powershell
$env:MEMORYAGENT_GIT_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_GIT_EXECUTABLE>'
$env:MEMORYAGENT_FFMPEG_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFMPEG_EXECUTABLE>'
$env:MEMORYAGENT_FFPROBE_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFPROBE_EXECUTABLE>'

python -m py_compile demo/tools/build_caption_video.py
python -m py_compile demo/tools/build_local_narration.py
python -m unittest discover -s demo/tests -p 'test_caption_video_builder.py' -v
python demo/tools/build_local_narration.py --self-test
python demo/tools/build_caption_video.py --self-test
# Slower pre-release acceptance of the complete 172-second / 5,160-frame encode:
python demo/tools/build_caption_video.py --full-self-test
```

Production and `--check-only` execution never discover Git, ffmpeg, or ffprobe from
the working directory or `PATH`. The three configured files must be absolute,
pre-reviewed, regular, non-reparse executables; the tools bind their identity and
SHA-256 and fail if a file changes. Leaving all three variables unset permits narrow,
unambiguous `PATH` discovery only inside the explicitly non-submission `--self-test`
and `--full-self-test` fixture modes. Never derive production values with `where`,
`which`, `Get-Command`, or `command -v` during the release run.

The two caption compositor self-tests create only unmistakably watermarked synthetic
fixtures under the ignored `.artifacts/caption-video-selftest/` directory. Their MP4s
are named
`SELF-TEST-NOT-SUBMISSION-EVIDENCE.mp4` or
`FULL-172S-SELF-TEST-NOT-SUBMISSION-EVIDENCE.mp4`; neither is a final or
live-evidence source. The full run replaces the fast self-test scratch in that
dedicated ignored directory. The local narration self-test writes its separate
non-submission fixture only under `.artifacts/local-narration-selftest/`.

## 2. Generate the canonical narration bundle

Production narration uses the paid ElevenLabs account through a main-only workflow.
The completion workflow first recovers the exact first five history items from failed
run `29731821217`, then makes exactly five new caption-bound requests for beats 6-10.
It uses no per-beat retry or fallback voice and promotes nothing unless the exact
history, request, PCM, timing, clipping and rights gates pass:

```powershell
gh workflow run canonical-elevenlabs-narration.yml `
  --repo upgradedev/archon-qwen-memoryagent `
  --ref main `
  -f expected_source_sha='<FINAL_MAIN_SHA>' `
  -f commercial_rights_approved=true
```

There is no implicit provider default. Production requires voice id
`pNInz6obpgDQGcFmaJgB`, model `eleven_multilingual_v2`, PCM 24 kHz provider output,
fixed per-beat seeds, and an explicit commercial/publication-rights approval.
The first five items must match the exact failed-run time window, text, voice, model,
settings and output format before any new synthesis begins. The generator speaks one
complete segment per row of tracked [`caption-timeline.json`](./caption-timeline.json)
and deterministically duration-fits PCM only when necessary, capped at 1.35x. It never
cuts or drops speech. A successful run writes only:

- `.artifacts/final-narration/memoryagent-narration.wav`, exactly 172.000 seconds,
  48 kHz, stereo, signed 16-bit PCM;
- `.artifacts/final-narration/memoryagent-narration.manifest.json`, binding the WAV
  and timeline SHA-256 values, selected voice, all ten placements, measured signal,
  and the synthetic-voice disclosure.

Generation stays in private randomized staging until the complete WAV and manifest
validate together. Pair promotion is exclusive and rollback-protected, so a failed
validation or second-file promotion leaves the previous pair byte-for-byte intact.
If an OS-level restore itself fails, the tool retains that randomized project-local
recovery directory instead of cleaning it, reports its exact path, and writes a
`RECOVERY_REQUIRED-*.json` inventory with the retained SHA-256 values and intended
destinations. Those files require manual review and must never be published directly.
The manifest also binds the generator source, canonical PowerShell file identity,
synthesizer script, normalized request, voice metadata and each placed source-PCM
segment. This is strong local build evidence, not an authenticated legal-rights
attestation; the human synthetic-voice rights review below remains authoritative.

Both records stay ignored and project-contained. The validator requires meaningful
non-silent audio in every beat and zero clipped samples. `--self-test` does not
invoke ElevenLabs; it creates a cross-platform ten-tone fixture that the
production gate explicitly rejects.

## 3. Lock the exact caption timeline before final capture

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
  --deployment-output .artifacts/deploy/<FINAL_DEPLOY_OUTPUT>.txt \
  --deployment-status .artifacts/deploy/<FINAL_DEPLOY_STATUS>.json \
  --reviewer-credential-json .artifacts/devpost/memory-reviewer-credential.json \
  --alibaba-raw demo/private-originals/alibaba-ecs-overview-raw.png \
  --caption-windows .artifacts/final-caption-video/caption_windows.json
```

Replace the placeholders only with the exact SHA and evidence pair recorded by the
current green `DEPLOY_STATE.md`. A later SHA is a hard stop until another exact
deployment refreshes that record.

## 4. Validate every base input without encoding

After a human has reviewed all gallery/proof frames and the capture gate has written
`demo/gallery/CAPTURE_REVIEW.json`:

```powershell
$env:MEMORYAGENT_GIT_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_GIT_EXECUTABLE>'
$env:MEMORYAGENT_FFMPEG_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFMPEG_EXECUTABLE>'
$env:MEMORYAGENT_FFPROBE_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFPROBE_EXECUTABLE>'

python demo/tools/build_caption_video.py `
  --expected-sha <FINAL_RUNTIME_SHA> `
  --deployment-output .artifacts/deploy/<FINAL_DEPLOY_OUTPUT>.txt `
  --deployment-status .artifacts/deploy/<FINAL_DEPLOY_STATUS>.json `
  --narration-audio .artifacts/final-narration/memoryagent-narration.wav `
  --narration-manifest .artifacts/final-narration/memoryagent-narration.manifest.json `
  --check-only
```

This is an optional cryptographic freshness preflight for the intermediate base, not
a filename check and not publication approval. It requires:

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
- the read-once narration WAV and manifest, SHA-bound to each other and the exact
  tracked caption contract; production requires the exact approved ElevenLabs
  voice/model/request contract named in that manifest; and
- exactly 172 seconds of 48 kHz stereo PCM with meaningful signal in all ten beats,
  no speech truncation, no clipping, no music or fallback media, the canonical
  synthetic-voice disclosure, and a declared deterministic
  `volume=-1.5dB:precision=fixed` gain applied only while encoding the publication
  AAC; the manifest-bound source WAV remains unchanged.

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

The builder retains immutable snapshots of every input it validates. Both the
caption builder and narration validators are compared directly with their
current `HEAD` blobs and recorded in the base manifest. Direct CLI output is limited
to `.artifacts/final-caption-video/`; it cannot replace the canonical final video.
The canonical public SRT is a validated read-only input and is never rewritten or
replaced as a caption-base build side effect.
Encoding occurs only in a newly randomized project-contained scratch child; frame,
concat, log and final `.writing` files are created exclusively without following
pre-seeded links.

## 5. Build and verify the canonical real-motion final

Do **not** run the static builder directly into `demo/final-media/`. Follow the exact
production sequence in [`REAL_MOTION_VIDEO.md`](./REAL_MOTION_VIDEO.md): record the
public, credential-free interaction, run `build_real_motion_submission.py`, and then
run `compose_real_motion_video.py --verify-only` against the resulting unchanged
files. The one-command builder creates a randomized project-contained
`.artifacts/final-video/base-*` session, invokes `build_caption_video.py` there, and
uses that static output only as the base for the live-motion compositor.

The only final judge-facing video records are:

- `demo/final-media/memoryagent-demo.mp4` — canonical 1920×1080 H.264 real-motion final;
- `demo/final-media/memoryagent-demo.en.srt` — exact ten-entry measured English SRT;
- `demo/final-media/memoryagent-demo.manifest.json` — `status: passed`, builder
  `caption-led-real-motion-compositor-v4-narrated-gain-normalized-immutable-inputs`, exact release/capture/live-input/output
  hashes, frame windows, measured codecs/duration, narration bindings and claim locks;
- `demo/final-media/memoryagent-demo.qa.json` — `status: passed` independent measured
  QA for the shipped MP4/SRT; and
- `demo/final-media/youtube-thumbnail.png` — thumbnail whose hash is bound by the
  final manifest.

The static post-encode checks include one H.264/yuv420p 1920×1080 stream at 30 fps,
exactly 5,160 frames, one 48 kHz stereo AAC narration stream, meaningful decoded
signal, zero clipped samples, EBU R128 loudness within the reviewed range, at least
1 dB of measured true-peak headroom, 172 measured seconds, and no extra stream or
sensitive metadata. They become publication evidence only after the
real-motion manifest + QA are green and the independent final `--verify-only` pass
recomputes every bound hash and measurement.

## 6. Human acceptance remains mandatory

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
static-base manifest never authorizes upload. Even a green real-motion manifest and QA
do not authorize publication until the final `--verify-only` pass and human review are
complete.
