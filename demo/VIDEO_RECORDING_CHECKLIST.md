# Video recording and publication checklist

Use this after the repository and live release gates are green. It is intentionally
video-specific; the screenshots, posts, and Devpost fields remain in
[`FINAL_MEDIA_CHECKLIST.md`](./FINAL_MEDIA_CHECKLIST.md).

Before any local production media command, replace these placeholders with absolute
Git, ffmpeg, and ffprobe executable paths that were reviewed for this release:

```powershell
$env:MEMORYAGENT_GIT_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_GIT_EXECUTABLE>'
$env:MEMORYAGENT_FFMPEG_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFMPEG_EXECUTABLE>'
$env:MEMORYAGENT_FFPROBE_EXECUTABLE = '<ABSOLUTE_PRE_REVIEWED_FFPROBE_EXECUTABLE>'
```

ffmpeg and ffprobe must be siblings from the same reviewed toolchain directory.
The production pipeline requires all three pinned values. Its live recording, build,
and `--verify-only` commands never discover executables from the working directory or
`PATH`. PATH discovery is reserved for explicitly labelled non-submission self-tests
when all three variables are unset.

## Before capture

- [ ] Read the [official rules](https://qwencloud-hackathon.devpost.com/rules);
      confirm the video will be `<3:00`, public, English or English-translated, and
      hosted on YouTube, Vimeo, or Youku.
- [ ] Confirm `origin/main` is the intended submission source and
      [`../deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) records
      one exact `<FINAL_RUNTIME_SHA>` as deployed and live-verified with its
      retained controller evidence.
      Endpoint health alone is insufficient evidence. A later
      runtime-affecting commit is a hard stop until another exact deployment.
- [ ] Confirm `<FINAL_RUNTIME_SHA>` is an ancestor of `origin/main`, then inspect with
      `& $env:MEMORYAGENT_GIT_EXECUTABLE diff --name-only <FINAL_RUNTIME_SHA>..origin/main`.
      Every later path must remain within the explicit submission-pack allowlist in
      `DEPLOY_STATE.md`; any new runtime-affecting delta requires another redeploy.
- [ ] Exercise selected-company P&L in the live Explorer and confirm its request and
      result are scoped to the selected company. This is the runtime behavior fixed
      by the candidate and must not be inferred from endpoint readiness.
- [ ] Re-run public `/health`, `/ready`, and OpenAPI checks. Verify real Qwen model
      ids and every required route; do not record a degraded or stale box.
- [ ] Click **Run bounded Qwen insight scan** once with the reviewer credential and
      confirm the result labels an at-most-one eligible `insight` pair scan. The request
      must use `maxPairs: 1`; do not add the offline FakeEmbedder fixture's
      `similarityThreshold: 0.5`. Do not echo the credential, and clear it from the
      UI immediately afterward.
- [ ] Use a clean browser profile at 1440×900 or larger, 100% zoom, no personal tabs,
      bookmarks, password-manager popups, extensions, notifications, or account avatar.
- [ ] Use the only canonical publication pipeline in
      [`REAL_MOTION_VIDEO.md`](./REAL_MOTION_VIDEO.md): burned captions, disclosed
      local Windows System.Speech narration, no music or third-party audio, plus
      SHA-bound genuine browser interaction.
      [`CAPTION_VIDEO_BUILD.md`](./CAPTION_VIDEO_BUILD.md) is only the deterministic
      base guide; a direct base export is not a final. Do not manually splice an
      alternate narration or workflow export into the canonical final. Retain the
      exact local narration manifest and rights evidence for every voice, font,
      image, logo and other asset.
- [ ] Confirm the three `MEMORYAGENT_*_EXECUTABLE` values above still name the exact
      pre-reviewed absolute files. Do not derive production values with `where`,
      `which`, `Get-Command`, or `command -v`.
- [ ] Read [`VIDEO_SCRIPT.md`](./VIDEO_SCRIPT.md) and
      [`../docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md) end to end.

## Required visuals

- [ ] Project/Track 1 hook and live HTTPS hostname.
- [ ] Exact deployed runtime SHA proof, followed by `/health` and `/ready`; keep
      commit attestation and endpoint readiness as two distinct claims.
- [ ] Release-bound qwen-vl proof: original synthetic payroll-register +
      bank-confirmation PNG pair, response-reported `qwen-vl-max`, one fused event,
      zero writes, unchanged reviewer count, and zero exact-marker residue.
- [ ] Canonical 16:9 architecture held long enough to read.
- [ ] Session A write and fresh Session B grounded/cited recall.
- [ ] Field contradiction with both values, provenance, recommendation, and
      read-only/no-mutation boundary.
- [ ] Human-control frame exercises Defer only and visibly says zero API call/write;
      Accept/Override remain labelled unexercised rather than implied live.
- [ ] Session-A feedback stores a correction; a separately authenticated fresh
      Session-B request recalls and cites it. Label persisted state, never training
      or model-weight learning.
- [ ] Meaning-level contradiction via the configured Qwen judge with the token hidden.
- [ ] Four typed MCP operations and the authenticated HTTP/trusted-local distinction.
- [ ] Timely forgetting/lifecycle proof: preview exactly one feedback-superseded
      retention candidate, confirm exactly one audited deletion, prove protected
      seed/correction unchanged, and finish at zero exact-marker residue.
- [ ] One honest evidence card with fixture labels and caveats.
- [ ] MemoryAgent-only Alibaba runtime proof; no reused footage from another entry.
- [ ] End card: project name, Track 1, live URL, public repository, MIT, Qwen/Alibaba.

## Secret and privacy pass

- [ ] Watch every frame at 0.25× and inspect title/outro frames separately.
- [ ] No `.env`, token field value, Authorization header, API key, cloud credential,
      shell history, email, account/instance/security-group identifier, private IP,
      browser profile, or real financial/customer data is visible.
- [ ] No secret appears in subtitles, chapter names, filenames, metadata, video
      description, thumbnail, alt text, or public post copy.
- [ ] Raw footage stays only under ignored `demo/private-originals/`; only sanitized
      selections are promoted to `demo/final-media/` or `demo/gallery/`.

## Technical acceptance

- [ ] `memoryagent-demo.manifest.json` reports `status: passed`, identifies
      `caption-led-real-motion-compositor-v3-narrated-immutable-inputs`, binds the exact runtime,
      `CAPTURE_REVIEW`, caption-base manifest/video, narration WAV/manifest,
      live-interaction manifest/video, SRT, thumbnail and final
      output hashes, and records exactly 5,160 frames, 172 measured seconds, ten SRT
      entries, one 1080p H.264 stream and one preserved narrated AAC stream. Decoded
      source, base and final measurements must prove meaningful signal, zero clipped
      samples and byte-identical base-to-final normalized PCM.
- [ ] `memoryagent-demo.qa.json` reports `status: passed` for the same final MP4/SRT,
      and, with the three pinned executable variables still set,
      `python demo/tools/compose_real_motion_video.py --verify-only` passes immediately
      before upload against every unchanged bound artifact. Static-base or
      workflow-candidate manifests do not satisfy this gate.
- [ ] No alternate narration, workflow candidate or manually edited export is used
      instead of the canonical real-motion final. The shipped audio is the exact
      manifest-bound local Windows System.Speech narration preserved from the base AAC.
- [ ] If the workflow source candidate is used, its permanent A/V/caption/order gate
      passed. Do not represent that source-candidate gate as validation of a changed
      exported final.
- [ ] The pinned `$env:MEMORYAGENT_FFPROBE_EXECUTABLE` reports a duration strictly
      below 175 seconds and exactly one expected video plus one expected audio stream;
      no blank lead-in or unexplained tail.
- [ ] Burned captions, source labels, beat transitions, and highlighted evidence stay
      synchronized with the narration. Inspect both audio/video sync and muted caption
      comprehension; narration must never mask stale or mistimed captions.
- [ ] Captions are accurate English, correctly spell every model id, and remain inside
      safe margins at 1080p playback.
- [ ] The full video was watched at normal speed and at 0.25×, once with audio enabled
      and once muted. Confirm narration is audible, unclipped and synchronized, the
      host/player adds no extra audio, and every captioned beat remains understandable.
- [ ] The thumbnail contains no unverified metric or sensitive browser/terminal detail.

## Publication and Devpost

- [ ] Upload to an accepted host with exact **Public** visibility, no login, no access
      request, no premiere delay, and no geographic restriction that blocks judges.
- [ ] Test video, captions, thumbnail, description, links, and playback signed out in
      an incognito window. Save the public URL.
- [ ] Replace the README's pending-video badge and paste the same public URL into
      Devpost. Preview both links signed out.
- [ ] Keep the live app, reviewer credential, repository, and video available free of
      charge through the judging period ending August 11, 2026 at 2:00 PM PDT.
- [ ] Save the final hosted page and Devpost confirmation as submission evidence.

Do not mark this checklist complete merely because a local MP4 exists. Public hosting
and a full human rights/security/content review are part of acceptance.
