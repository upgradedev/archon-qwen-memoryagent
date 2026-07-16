# Build the authenticated recording candidate

The supported automated path is the manual GitHub Actions workflow
[`Generate Authenticated Demo Video`](../.github/workflows/demo-video.yml). It drives
requests against the already deployed Alibaba host, hard-checks real Qwen responses,
creates terminal/Explorer segments, synthesizes a rights-attested voice, composes the
candidate, and runs the permanent A/V/caption/order gate. A successful job produces
a **candidate**, never an automatically publishable video.

The workflow's assembled MP4 does not contain every editorial proof card in the
canonical nine-beat [`VIDEO_SCRIPT.md`](./VIDEO_SCRIPT.md). Use its real terminal/UI
captures, transcript, and intermediate segments as source footage, then add the
sanitized exact-SHA, architecture, evidence, and Alibaba frames in the final edit.
Do not promote the unedited workflow output merely because the job is green.
Never reuse `demo/video/final/`: it is explicitly historical pre-hardening evidence
and its transcript describes an older BM25-labelled capture rather than the deployed
PostgreSQL full-text path.

## 1. Preconditions

1. Confirm the default branch and live runtime evidence are aligned with
   [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md). The required recording
   runtime candidate is `aee7897d4d436501fc9b0dc1ed28e3757131f559` and it must
   be explicitly recorded there as exact-deployed/live-verified. Its current
   **REDEPLOY REQUIRED** state is a hard stop. Submission-pack-only descendants may
   move repository HEAD after that candidate; runtime descendants require a new deploy.
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

Run from the repository root with local `ffmpeg`/`ffprobe`, Python 3.11, and Pillow
available. Set the actual run id once; the manifest and caption-window sidecars must
come from the same artifact as the candidate:

```bash
RUN_ID=<RUN_ID>
ART="demo/private-originals/video-build-${RUN_ID}"
CAND="${ART}/demo/final-media/memoryagent-demo.mp4"

command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null
python -c 'from PIL import Image; print("Pillow OK")'
test -s "$CAND" -a -s "$ART/video_manifest.json" -a -s "$ART/caption_windows.json"

ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$CAND"
test "$(ffprobe -v error -select_streams v -show_entries stream=index -of csv=p=0 "$CAND" | wc -l)" -eq 1
test "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$CAND" | wc -l)" -eq 1

VIDEO_MANIFEST="$ART/video_manifest.json" \
CAPTION_WINDOWS="$ART/caption_windows.json" \
python scripts/verify_video_sync.py "$CAND"
```

Then complete [`VIDEO_RECORDING_CHECKLIST.md`](./VIDEO_RECORDING_CHECKLIST.md).
The script gate does not replace human review for secrets, rights, stale claims,
readability, pronunciation, or narrative quality.

If the final edit adds the required proof cards or changes the workflow's four-part
segment order, treat the workflow sync result as source-candidate evidence only.
Measure the exported final independently and complete every final-export check in the
recording checklist.

## 6. Promote only the approved deliverables

- Approved canonical video: `demo/final-media/memoryagent-demo.mp4`.
- Sanitized gallery/runtime proof: `demo/gallery/`.
- Canonical architecture: `demo/final-media/judge-architecture.jpg`.
- Raw captures/intermediates: remain ignored under `demo/private-originals/`.

After promotion, check ignored/tracked state before staging:

```bash
git status --ignored --short demo/
git ls-files demo/private-originals/
```

The second command must print nothing. Upload the reviewed video to YouTube, Vimeo,
or Youku with Public visibility, then complete the public-link and Devpost steps in
[`FINAL_MEDIA_CHECKLIST.md`](./FINAL_MEDIA_CHECKLIST.md).
