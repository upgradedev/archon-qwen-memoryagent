# Video recording and publication checklist

Use this after the repository and live release gates are green. It is intentionally
video-specific; the screenshots, posts, and Devpost fields remain in
[`FINAL_MEDIA_CHECKLIST.md`](./FINAL_MEDIA_CHECKLIST.md).

## Before capture

- [ ] Read the [official rules](https://qwencloud-hackathon.devpost.com/rules);
      confirm the video will be `<3:00`, public, English or English-translated, and
      hosted on YouTube, Vimeo, or Youku.
- [ ] Confirm `origin/main` is the intended submission source and
      [`../deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) records deployed
      runtime-source SHA `e4b208a63e1768409e5b94fe305a3672c4c96dcd`.
- [ ] Run `git diff --name-only e4b208a63e1768409e5b94fe305a3672c4c96dcd..origin/main`.
      Every descendant must remain within the explicit submission-pack allowlist in
      `DEPLOY_STATE.md`; any application, dependency, schema, container,
      runtime/deployment-workflow, deploy-script, or unlisted-path change invalidates
      the release gate and requires review plus redeployment.
- [ ] Re-run public `/health`, `/ready`, and OpenAPI checks. Verify real Qwen model
      ids and every required route; do not record a degraded or stale box.
- [ ] Run the protected semantic path once with the reviewer credential without
      echoing it. Clear the credential from the UI immediately afterward.
- [ ] Use a clean browser profile at 1440×900 or larger, 100% zoom, no personal tabs,
      bookmarks, password-manager popups, extensions, notifications, or account avatar.
- [ ] Confirm the narration/voice, fonts, music, images, logos, and all other assets
      are owned or authorized for public competition use. Keep the evidence of rights.
- [ ] Read [`VIDEO_SCRIPT.md`](./VIDEO_SCRIPT.md) and
      [`../docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md) end to end.

## Required footage

- [ ] Project/Track 1 hook and live HTTPS hostname.
- [ ] Exact deployed runtime SHA proof, followed by `/health` and `/ready`; keep
      commit attestation and endpoint readiness as two distinct claims.
- [ ] Canonical 16:9 architecture held long enough to read.
- [ ] Session A write and fresh Session B grounded/cited recall.
- [ ] Field contradiction with both values, provenance, recommendation, and
      read-only/no-mutation boundary.
- [ ] Meaning-level contradiction via the configured Qwen judge with the token hidden.
- [ ] Four typed MCP operations and the authenticated HTTP/trusted-local distinction.
- [ ] Timely forgetting/lifecycle proof: tenant-scoped preview first, then explicit
      reason + confirmation and an auditable result; never stage a surprise deletion.
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

- [ ] A scratch recording of the exact final narration measures `<=168` seconds by
      `ffprobe`; if longer, tighten wording and re-record before editing.
- [ ] The workflow source candidate's permanent A/V/caption/order gate passed. If the
      final edit changes that structure, do not represent the source-candidate gate as
      validation of the exported final.
- [ ] `ffprobe` reports a duration strictly below 175 seconds and one expected video
      plus audio stream; no blank lead-in or silent ending.
- [ ] Narration, screen action, captions, and highlighted evidence stay synchronized.
- [ ] Captions are accurate English, correctly spell every model id, and remain inside
      safe margins at 1080p playback.
- [ ] The full video was watched with headphones at normal speed and once muted with
      captions; no clipped sentence, unreadable panel, stale metric, or unexplained cut.
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
