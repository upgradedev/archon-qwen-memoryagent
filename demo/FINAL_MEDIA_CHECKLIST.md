# Archon MemoryAgent — final media and submission checklist

This is the human handoff. Once the final deployment release gate is green, no source-code work should remain.

**Deadline:** July 20, 2026 at 2:00 PM PDT (July 21, 00:00 EEST). Aim to submit at least six hours early.

**Controlling references:** [official rules](https://qwencloud-hackathon.devpost.com/rules) ·
[submission overview](https://qwencloud-hackathon.devpost.com/) ·
[official schedule](https://qwencloud-hackathon.devpost.com/details/dates) ·
[Devpost submission steps](https://help.devpost.com/article/126-know-your-submission-steps). If a
summary page and the detailed rules differ, follow the detailed rules. The rules
require the working project and any credentialed testing access to remain available,
free of charge and without restriction, through the judging period ending
August 11, 2026 at 2:00 PM PDT.

## 0. One non-negotiable pre-recording gate

- [ ] `GET https://memory.43.106.13.19.sslip.io/ready` returns `200` and shows database/Qwen/auth ready.
- [ ] `/health` reports `text-embedding-v4` and `qwen-plus`, not Fake providers.
- [ ] `/openapi.json` contains `/ready`, `/ingest/invoice`, `/feedback`, `/consistency/semantic`, `/consolidate`, and `/forget`.
- [ ] Public seed → recall → field audit works without a key.
- [ ] Re-running `POST /demo/seed` is idempotent (`alreadySeeded=true`,
      `reconciled=false`, `events=0`), and Northwind P&L shows one EUR bucket,
      zero unknown-currency records, employer cost `14600`, revenue `42700`, and
      net profit `28100`.
- [ ] Protected semantic audit works with the reviewer token.
- [ ] Browser console is clean and the final repository changes are pushed to `main`.
- [ ] [`../deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) records
      `<FINAL_RUNTIME_SHA>` (replaced with the real 40-character SHA) as exact-deployed and
      live-verified. **At authoring time this is pending; do not check the box from
      `/health` or `/ready` alone.**
- [ ] `git merge-base --is-ancestor <FINAL_RUNTIME_SHA> origin/main` passes after
      placeholder replacement, then `git diff --name-only <FINAL_RUNTIME_SHA>..origin/main`
      contains only the post-candidate submission-pack allowlist recorded in
      [`DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md). Any new runtime-affecting path
      requires review and redeployment.
- [ ] Selected-company P&L smoke passes in the Explorer after exact deployment;
      choosing a company changes the `/pnl?company=...` request and result scope.

Stop if any box is red. Do not record a stale deployment.

## 1. Public demo video — target 165–172 seconds

Accepted safe hosts under the detailed rules: **YouTube, Vimeo, or Youku**. Use **Public visibility with no login or access request**, and keep the final duration below the automated 175-second safety limit.

Follow the canonical [`VIDEO_SCRIPT.md`](./VIDEO_SCRIPT.md), run the operational
[`VIDEO_RECORDING_CHECKLIST.md`](./VIDEO_RECORDING_CHECKLIST.md), and use
[`CAPTION_VIDEO_BUILD.md`](./CAPTION_VIDEO_BUILD.md) for the preferred no-TTS,
caption-led final; [`BUILD_RECORDING.md`](./BUILD_RECORDING.md) retains the optional
authenticated source-footage procedure. After final mux/inspection, use the paste-ready
[`VIDEO_PUBLICATION_PACKET.md`](./VIDEO_PUBLICATION_PACKET.md); it prepares upload
metadata but does not authorize publication.

- [ ] Use only owned or properly licensed music, images, logos, fonts, and footage; include no copyrighted third-party asset without permission, and use competition marks only as the rules permit.

### Recommended shot list

| Time | Visual | Narration point |
|---:|---|---|
| 0:00–0:13 | Title, live URL, Track 1 | Conflict stakes and one-line product answer. |
| 0:13–0:32 | Sanitized exact-runtime-SHA release card, `/health`, `/ready`, qwen-vl canary | Commit provenance stays separate from readiness; original synthetic two-PNG dry-run reports `qwen-vl-max`, one fused event, zero writes and zero residue. |
| 0:32–0:51 | `demo/final-media/judge-architecture.jpg` | Trust boundary, Qwen, pgvector, bounded-listwise reranked hybrid recall, read-only audit/human resolution, and portable REST/MCP/pg-wire seams. |
| 0:51–1:13 | Session A write/disconnect, fresh Session B cited recall | `€15,800` true cost versus `€10,000` bank outflow; dense score is exposed only for this human-readable proof while product default remains hybrid. |
| 1:13–1:35 | Original synthetic `INV-5521`, field self-audit, human-control frame | `€8,400` versus `€8,900`, recency recommendation, no silent mutation; live Defer only with zero API/write and Accept/Override unexercised. |
| 1:35–1:53 | Feedback-persistence proof | Session-A stored correction and separately authenticated fresh Session-B cited application; persisted state, not weight learning. |
| 1:53–2:10 | Cropped authenticated semantic result plus four-tool MCP card | “Pays on time” versus “chronically late”; hide the credential/request header and distinguish authenticated HTTP from trusted-local stdio. |
| 2:10–2:22 | Authenticated one-row lifecycle preview and confirmation | Preview one feedback-superseded candidate, delete one with audit, protected state unchanged, zero marker residue. |
| 2:22–2:42 | One prepared evidence card | 5/5 field issues with 0 FP; 4/4 policy conformance; deterministic semantic 90% recall/100% precision/0 FP; MRR 0.883→0.911 and Recall@3 90.0%→96.7%. Keep fixture labels/caveats visible. |
| 2:42–2:52 | Sanitized MemoryAgent-only Alibaba proof, then repo/MIT end card | Active ECS + self-hosted pgvector topology, public TLS URL, real Qwen model ids, and one-line portable-product close. |

### Video quality gate

- [ ] Final file is strictly under 175 seconds and 1080p or better.
- [ ] Prefer the caption-led path: no voice, no TTS, no third-party music, generated
      digital silence, burned English captions, and a green final build manifest. If
      narrated source footage is used, set the workflow's separate ElevenLabs and
      edge-tts publication-rights attestations only for independently authorized
      paths; otherwise do not run the synthesizer.
- [ ] Text is readable at normal YouTube playback size.
- [ ] Burned captions and the uploaded exact SRT are enabled; names/model ids are
      spelled correctly and the ten windows match the measured final.
- [ ] No API key, reviewer token, Authorization header, shell history secret, email, or cloud credential is visible in any frame, thumbnail, caption, or description. Clear the Judge token field before any beauty shot.
- [ ] Claims match [`../docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).
- [ ] The description includes live URL, public repo, Track 1, and architecture/code-proof links.
- [ ] Test the public URL in an incognito window with audio enabled. For the preferred
      build, confirm the generated-silence track remains silent and captions are on.

**Public video URL:** `____________________________________________`

## 2. Screenshot set

Run the fail-closed [`MEDIA_CAPTURE_RUNBOOK.md`](./MEDIA_CAPTURE_RUNBOOK.md).
Canonical Devpost images are clean 1500×1000 (3:2); each maps deterministically to
a no-crop 1920×1080 proof frame for video. Hide bookmarks, personal tabs, tokens,
and terminal history. Use the canonical filenames, upload order and ready-to-paste
English captions in [`SCREENSHOT_MANIFEST.md`](./SCREENSHOT_MANIFEST.md).

- [ ] Hero: Explorer loaded at the live HTTPS URL with Track 1/product name visible.
- [ ] Grounded recall: answer plus numbered citations in the same frame.
- [ ] Feedback persistence: Session-A stored correction plus fresh Session-B cited application; label persistence, not weight learning.
- [ ] Field self-audit: `INV-5521`, both values, and the recency recommendation visible.
- [ ] Semantic self-audit: meaning-level pair and read-only resolution visible; clear/crop out the Judge token field and all auth details.
- [ ] Qwen-VL canary: original synthetic payroll-register + bank-confirmation PNG pair, response-reported `qwen-vl-max`, one fused event, zero writes, unchanged count and exact-prefix absence.
- [ ] Lifecycle: exactly one synthetic candidate previewed and one deleted; protected seed/correction unchanged and cleanup residue zero.
- [ ] Architecture: use the canonical 16:9 [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg)
      for video/custom architecture upload; upload the generated 3:2
      [`gallery/07-qwen-memoryagent-architecture.png`](./gallery/07-qwen-memoryagent-architecture.png)
      to the Devpost gallery, not a screenshot of raw Mermaid. Keep
      [`../docs/architecture.png`](../docs/architecture.png) only as the dense technical appendix.
- [ ] Live proof: `/ready` and `/health` showing ready + real Qwen model ids.
- [ ] Alibaba proof: ECS/container service and live endpoint in one safe frame; redact account IDs/IP metadata not needed for proof.
- [ ] Repository proof: public repo landing page with latest commit and GitHub's MIT
      license detection visible from the repository page, not only a raw `LICENSE` file.

Store sensitive originals only in the ignored repo-local folder `demo/private-originals/` so every agent shares one project boundary without risking a commit. Redact there, then add only sanitized final images under `demo/gallery/`. Before staging, run `git status --ignored --short demo/` and verify no private original is tracked.

- [ ] `demo/gallery/CAPTURE_REVIEW.json` is `passed`, records the exact runtime SHA,
      exact strict/fallback deploy-evidence mode, producer `invocationId` and
      `commandId`, plus status/output path, length and SHA-256, measured SRT timing
      source, current model ids, vision/feedback/lifecycle gates and SHA-256 for
      every final.
- [ ] [`final-media/youtube-thumbnail.png`](./final-media/youtube-thumbnail.png) is
      exactly 1280×720 and [`final-media/memoryagent-demo.en.srt`](./final-media/memoryagent-demo.en.srt)
      is regenerated from final measured windows, not the canonical fallback.

## 3. Public posts

- [ ] Publish the technical article from [`BLOG.md`](./BLOG.md); remove its publisher-only HTML checklist, resolve only public video/Devpost placeholders, and keep its absolute architecture image URL and Qwen Cloud build journey intact.
- [ ] Open the published article, architecture image, live CTA, repository CTA, and optional video/Devpost links in a signed-out/private browser; require every page to load without a login or access request.
- [ ] Publish at least one social post from [`POST_DRAFTS.md`](./POST_DRAFTS.md).
- [ ] Confirm each post is public in an incognito window.
- [ ] Add the public blog/social URL to the Devpost submission for the optional bonus.

**Blog URL:** `____________________________________________`
**Social URL:** `____________________________________________`

## 4. Devpost copy/paste fields

Use [`DEVPOST_STAGING.md`](./DEVPOST_STAGING.md) as the single field-by-field
operator sheet and stop on Devpost's final step without clicking **Submit project**.

- [ ] Team: add every actual teammate (or leave solo); if entering as a team or
      organization, confirm the authorized representative in section 5 below.
- [ ] Project name: **Archon MemoryAgent — a memory that audits itself**
- [ ] Tagline (under 140 characters): **Persistent Qwen memory that recalls, cites, and surfaces its own cross-session contradictions.**
- [ ] Thumbnail: upload [`thumbnail.png`](./thumbnail.png) (PNG, 1500×1000, 3:2,
      below 5 MB), rendered from the original [`thumbnail.svg`](./thumbnail.svg).
      Preview the actual gallery crop; the hook and both conflicting values must remain readable.
- [ ] Built with tags: **Qwen Cloud, Alibaba Cloud, Qwen, Model Context Protocol
      (MCP), TypeScript, Fastify, PostgreSQL, pgvector, Docker, OpenAI SDK**.
- [ ] Track: **Track 1 — MemoryAgent**
- [ ] Project Story: paste the canonical body between separators in [`SUBMISSION.md`](./SUBMISSION.md); do not substitute the long-form evidence story.
- [ ] Try it out: <https://memory.43.106.13.19.sslip.io>
- [ ] Image Gallery: upload the sanitized hero, cited recall, field audit, semantic
      audit, lifecycle, architecture, health/readiness, Alibaba, and repository
      images approved in section 2; add short English captions.
- [ ] Public repository: <https://github.com/upgradedev/archon-qwen-memoryagent>
- [ ] Live app: <https://memory.43.106.13.19.sslip.io>
- [ ] Alibaba/Qwen code proof: Qwen Cloud API
      <https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts>
      plus live ECS redeploy path
      <https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/deploy/redeploy.sh>.
- [ ] Architecture: upload the canonical 16:9 [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg).
- [ ] Public video: paste the URL recorded above.
- [ ] Blog/social: paste the public URL recorded above.
- [ ] Testing instructions: paste the safe public block from
      [`DEVPOST_PRIVATE_TESTING.md`](./DEVPOST_PRIVATE_TESTING.md). Before adding any
      credential, confirm with the actual form/organizer whether that field is
      judge-only; Devpost gallery visibility must not be assumed.
- [ ] Use only a dedicated low-privilege, tenant-scoped, quota-bounded judging credential. Preview the saved submission logged out; rotate immediately if exposed, otherwise keep it working through judging and revoke/rotate after judging ends.
- [ ] Keep the live app, public video, repository, and reviewer credential
      working without payment/login friction through the end of judging; schedule
      an operator check before July 28 and during the July 28–August 11 judging window.
- [ ] Explain uniqueness if both entries are submitted: MemoryAgent is persistent recall/self-audit; Autopilot is a bounded AP decision/action workflow. They are separate, substantially different entries.
- [ ] Preview every link while logged out.
- [ ] Submit before the deadline and save the confirmation email/page as the receipt.

**Devpost submission URL:** `____________________________________________`
**Submission confirmation saved:** `[ ]`

## 5. Entrant and rights sign-off

These are human attestations required by the detailed rules; repository automation
cannot decide them.

Complete the expanded release gate in
[`RIGHTS_RELEASE_CHECKLIST.md`](./RIGHTS_RELEASE_CHECKLIST.md); the short list below
is only the final summary.

- [ ] Every entrant is at least the local age of majority, eligible in their
      jurisdiction, not a restricted party, and has no sponsor/judge/promotion-entity
      conflict described by the rules.
- [ ] If entering as a team or organization, the submitting person is its authorized
      representative and every listed member has approved the entry.
- [ ] The entry is owned by the entrant; all third-party SDKs, APIs, data, fonts,
      marks, music, voices, images, and open-source components are used under terms
      that permit this public submission and the organizer's judging/promotion use.
- [ ] The existing Archon context and the work added during the competition window
      are disclosed in [`SUBMISSION.md`](./SUBMISSION.md); no reused work is presented
      as newly created evidence.
- [ ] The MemoryAgent and Autopilot entries remain unique and substantially different,
      and neither received disqualifying financial/preferential sponsor support.
- [ ] Every submitted artifact and testing instruction is English or includes an
      English translation, and the final form is complete before the deadline because
      substantive edits are not allowed after it closes.
