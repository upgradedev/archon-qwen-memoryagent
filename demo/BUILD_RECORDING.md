# Build the final video and optional authenticated source footage

The only canonical publication candidate is the rights-disclosed, narrated and captioned
**real-motion** assembly documented in
[`REAL_MOTION_VIDEO.md`](./REAL_MOTION_VIDEO.md). It uses the hash-reviewed
gallery/proof inputs, burns the exact English captions, inserts SHA-bound genuine live
browser interaction, and preserves the exact entrant-approved ElevenLabs narration
track. It uses no music, human voice, or fallback service. Its 5,160-frame
timeline is deterministically 172 seconds, and its final manifest, QA, and
`--verify-only` gate measure the actual shipped MP4, SRT, and audible signal before
promotion.

[`CAPTION_VIDEO_BUILD.md`](./CAPTION_VIDEO_BUILD.md) documents the deterministic
timeline and static base renderer. `build_caption_video.py` is intermediate tooling
only; the real-motion one-command builder invokes it in ignored scratch. A direct
static export is not the final and must never be uploaded.

The manual GitHub Actions workflow
[`Generate Authenticated Demo Video`](../.github/workflows/demo-video.yml) remains
available for optional source footage. It drives
requests against the already deployed Alibaba host, hard-checks real Qwen responses,
creates terminal/Explorer segments, synthesizes a rights-attested voice, composes the
candidate, and runs its A/V/caption/order gate. That workflow is an **optional
source-footage candidate**, never the canonical final or an automatically publishable
video.

The workflow's assembled MP4 does not contain every editorial proof card in the
canonical ten-beat [`VIDEO_SCRIPT.md`](./VIDEO_SCRIPT.md). Its terminal/UI captures,
transcript, and intermediate segments may be inspected as internal source-candidate
evidence, but the current canonical real-motion pipeline deliberately does not ingest
them. Do not manually splice or promote the workflow output merely because its job is
green; only the independently gated pipeline in `REAL_MOTION_VIDEO.md` may produce the
submission video.
Never use [`archive/pre-hardening-capture-transcript.txt`](./archive/pre-hardening-capture-transcript.txt)
as a recording source: it is retained only as explicitly labelled historical evidence
and describes an older BM25-labelled capture rather than the deployed PostgreSQL
full-text path.

## Canonical narrated real-motion final

Generate and validate the canonical narration, run the offline self-tests, and emit the
deterministic caption-window input before the final gallery capture:

```powershell
$env:MEMORYAGENT_GIT_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_GIT_EXECUTABLE>'
$env:MEMORYAGENT_FFMPEG_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFMPEG_EXECUTABLE>'
$env:MEMORYAGENT_FFPROBE_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFPROBE_EXECUTABLE>'

python -m py_compile demo/tools/build_local_narration.py demo/tools/build_elevenlabs_narration.py demo/tools/build_caption_video.py
python -m unittest discover -s demo/tests -p 'test_caption_video_builder.py' -v
python demo/tools/build_local_narration.py --self-test --rate 1
# Production narration uses voice pNInz6obpgDQGcFmaJgB with
# eleven_multilingual_v2. Beats 1-5 are recovered from failed run 29731821217;
# the workflow synthesizes only beats 6-10, then downloads the verified bundle
# unchanged into .artifacts/final-narration/.
python demo/tools/build_caption_video.py --self-test
python demo/tools/build_caption_video.py --full-self-test
python demo/tools/build_caption_video.py `
  --emit-caption-windows .artifacts/final-caption-video/caption_windows.json
```

Replace the placeholders with absolute paths reviewed for this release. ffmpeg and
ffprobe must be sibling files from the same reviewed toolchain directory. Production
media commands never use working-directory or `PATH` discovery; configured tool
identity and SHA-256 are bound and rechecked. Only explicit non-submission self-test
fixtures may discover an unambiguous PATH toolchain when all three variables are
unset. Do not obtain production values with `where`, `which`, `Get-Command`, or
`command -v`.

After exact deployment and the final media-capture gate, use the static builder's
`--check-only` mode only as an optional base-input preflight. Then run the production
recorder, one-command real-motion builder, and independent `--verify-only` command
exactly as documented in [`REAL_MOTION_VIDEO.md`](./REAL_MOTION_VIDEO.md). Production
intentionally fails while `DEPLOY_STATE.md` is red, `CAPTURE_REVIEW.json` is absent,
any expected hash is stale, the measured SRT differs from the burned-caption timeline,
or the final real-motion manifest/QA cannot be independently re-verified.

## Optional authenticated TTS source-footage candidate

## 1. Preconditions

1. Confirm the default branch and live runtime evidence are aligned with
   [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md). Use only the exact runtime
   SHA and retained deployment evidence named by its current green machine record.
   Submission-only descendants may move repository HEAD after that runtime; any
   runtime-affecting descendant is a hard stop until another exact deployment.
2. Run the secret-safe pre-recording checks in
   [`FINAL_MEDIA_CHECKLIST.md`](./FINAL_MEDIA_CHECKLIST.md).
3. Configure `MEMORYAGENT_JUDGE_API_KEY` only as a private Actions secret. Never put
   its value in a workflow input, command line, issue, log, artifact name, or file.
4. The workflow automatically falls back from the selected ElevenLabs voice to
   edge-tts `en-US-GuyNeural` on any synthesis failure. Confirm and retain publication
   rights evidence for **both** the selected primary voice/service and that fallback
   before attesting. If either path is not authorized, do not trigger this workflow;
   capture the visual source separately and add a human-owned recording in the final
   edit. Never attest merely to make the job pass.

## 2. Trigger from GitHub

The safest path is **Actions → Generate Authenticated Demo Video → Run workflow** on
`main`. Confirm these non-secret inputs:

- base URL: `https://memory.43.106.13.19.sslip.io`;
- repository outro: `github.com/upgradedev/archon-qwen-memoryagent`;
- voice/model ids: only the reviewed authorized primary choice;
- fallback: separately confirm edge-tts `en-US-GuyNeural` authorization;
- `voice_rights_attested`: `true` only for an authorized ElevenLabs path;
- `edge_tts_rights_attested`: `true` only if the fallback is independently authorized.

The equivalent CLI command contains no credential:

```bash
gh workflow run demo-video.yml \
  --repo upgradedev/archon-qwen-memoryagent \
  --ref main \
  -f base_url=https://memory.43.106.13.19.sslip.io \
  -f repo_url=github.com/upgradedev/archon-qwen-memoryagent \
  -f voice_rights_attested=true \
  -f edge_tts_rights_attested=true
```

Do not run that example until both possible voices/services are authorized. The workflow reads
the reviewer credential from the private secret, fails if the live box is down or
Fake-backed, and never prints the credential.

## 3. Inspect the run before downloading

```bash
gh run list \
  --repo upgradedev/archon-qwen-memoryagent \
  --workflow demo-video.yml --branch main --limit 5
gh run watch <RUN_ID> \
  --repo upgradedev/archon-qwen-memoryagent --exit-status
```

Require every step to pass, especially:

- live two-session capture and real-Qwen structured checks;
- live Explorer browser capture;
- narration generation and rights gate;
- `<175s` compose guard; and
- `Verify A/V/caption sync (permanent gate)`.

## 4. Download into the ignored review area

Keep raw artifacts inside the repository and outside tracked final media:

```bash
mkdir -p demo/private-originals/video-build-<RUN_ID>
gh run download <RUN_ID> \
  --repo upgradedev/archon-qwen-memoryagent \
  --name archon-memoryagent-demo-video \
  --dir demo/private-originals/video-build-<RUN_ID>
```

Do not download to an OS temp folder and do not stage the raw artifact directory.
The artifact includes the composed MP4, intermediate segments, live transcript,
screenshots, manifest, and caption windows so synchronization can be audited.

## 5. Re-run local acceptance and review

Run from the repository root with Python 3.11 and Pillow available. Set the actual
run id once, and replace each executable placeholder with a pre-reviewed absolute
path. The manifest and caption-window sidecars must come from the same artifact as
the candidate:

```bash
export MEMORYAGENT_GIT_EXECUTABLE='/absolute/pre-reviewed/path/to/git'
export MEMORYAGENT_FFMPEG_EXECUTABLE='/absolute/pre-reviewed/path/to/ffmpeg'
export MEMORYAGENT_FFPROBE_EXECUTABLE='/absolute/pre-reviewed/path/to/ffprobe'

RUN_ID=<RUN_ID>
ART="demo/private-originals/video-build-${RUN_ID}"
CAND="${ART}/demo/final-media/memoryagent-demo.mp4"

test -x "$MEMORYAGENT_GIT_EXECUTABLE"
test -x "$MEMORYAGENT_FFMPEG_EXECUTABLE"
test -x "$MEMORYAGENT_FFPROBE_EXECUTABLE"
python -c 'from PIL import Image; print("Pillow OK")'
test -s "$CAND" -a -s "$ART/video_manifest.json" -a -s "$ART/caption_windows.json"

"$MEMORYAGENT_FFPROBE_EXECUTABLE" -v error -show_entries format=duration -of default=nw=1:nk=1 "$CAND"
VIDEO_STREAMS=$("$MEMORYAGENT_FFPROBE_EXECUTABLE" -v error -select_streams v -show_entries stream=index -of csv=p=0 "$CAND" | wc -l)
AUDIO_STREAMS=$("$MEMORYAGENT_FFPROBE_EXECUTABLE" -v error -select_streams a -show_entries stream=index -of csv=p=0 "$CAND" | wc -l)
test "$VIDEO_STREAMS" -eq 1
test "$AUDIO_STREAMS" -eq 1

VIDEO_MANIFEST="$ART/video_manifest.json" \
CAPTION_WINDOWS="$ART/caption_windows.json" \
python scripts/verify_video_sync.py "$CAND"
```

Then complete [`VIDEO_RECORDING_CHECKLIST.md`](./VIDEO_RECORDING_CHECKLIST.md).
The script gate does not replace human review for secrets, rights, stale claims,
readability, pronunciation, or narrative quality.

Any manual edit that adds proof cards or changes the workflow's four-part segment order
remains a noncanonical source candidate; its workflow sync result cannot attest the
submission. Produce the actual final afresh through `REAL_MOTION_VIDEO.md`, measure it
through the real-motion manifest + QA, and complete every final-export check in the
recording checklist.

## 6. Promote only the independently re-verified deliverables

- Approved canonical video: `demo/final-media/memoryagent-demo.mp4`, produced only by
  the pipeline in [`REAL_MOTION_VIDEO.md`](./REAL_MOTION_VIDEO.md).
- Required final records: `demo/final-media/memoryagent-demo.manifest.json` and
  `demo/final-media/memoryagent-demo.qa.json`, both `status: passed` and unchanged
  since the final successful
  `python demo/tools/compose_real_motion_video.py --verify-only` run.
- Sanitized gallery/runtime proof: `demo/gallery/`.
- Canonical architecture: `demo/final-media/judge-architecture.jpg`.
- Raw captures/intermediates: remain ignored under `demo/private-originals/`.

After promotion, check ignored/tracked state before staging:

```bash
"$MEMORYAGENT_GIT_EXECUTABLE" status --ignored --short demo/
"$MEMORYAGENT_GIT_EXECUTABLE" ls-files demo/private-originals/
```

The second command must print nothing. A workflow candidate or direct static-caption
export cannot be promoted. Only after the real-motion manifest + QA gate and final
`--verify-only` pass may the reviewed video be uploaded to YouTube, Vimeo, or Youku
with Public visibility; then complete the public-link and Devpost steps in
[`FINAL_MEDIA_CHECKLIST.md`](./FINAL_MEDIA_CHECKLIST.md).
