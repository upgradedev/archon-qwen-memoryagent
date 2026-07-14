# Archon MemoryAgent — final media and submission checklist

This is the human handoff. Once the final deployment release gate is green, no source-code work should remain.

**Deadline:** July 20, 2026 at 2:00 PM PDT (July 21, 00:00 EEST). Aim to submit at least six hours early.

## 0. One non-negotiable pre-recording gate

- [ ] `GET https://memory.43.106.13.19.sslip.io/ready` returns `200` and shows database/Qwen/auth ready.
- [ ] `/health` reports `text-embedding-v4` and `qwen-plus`, not Fake providers.
- [ ] `/openapi.json` contains `/ready`, `/ingest/invoice`, `/feedback`, `/consistency/semantic`, `/consolidate`, and `/forget`.
- [ ] Public seed → recall → field audit works without a key.
- [ ] Protected semantic audit works with the reviewer token.
- [ ] Browser console is clean and the final repository changes are pushed to `main`.

Stop if any box is red. Do not record a stale deployment.

## 1. Public demo video — target 165–175 seconds

Accepted safe hosts under the detailed rules: **YouTube, Vimeo, or Youku**. Set the video to Public (not private, not login-gated) and keep the final duration below 3:00.

### Recommended shot list

| Time | Visual | Narration point |
|---:|---|---|
| 0:00–0:12 | Title, live URL, Track 1 | “A persistent Qwen memory that tells you when its own memories disagree.” |
| 0:12–0:28 | `docs/architecture.png` | Alibaba ECS, pgvector, Qwen models, public/auth trust boundary, four MCP tools. |
| 0:28–0:42 | `/ready` then `/health` | Real deployment and real model ids. Never show environment variables. |
| 0:42–1:12 | Explorer → **Run demo** → cited recall | Fixed idempotent seed, bounded recall, numbered evidence citations. |
| 1:12–1:40 | **Run self-audit** | `INV-5521`, `8400` vs `8900`, recency recommendation, no mutation. |
| 1:40–2:05 | Paste private token in the Explorer's password field → **Run semantic audit** → crop to result | “Pays on time” vs “chronically late”; never reveal the token or browser request header. |
| 2:05–2:28 | Feedback/lifecycle/OpenAPI or prepared result | Explicit correction loop; dry-run/confirm forgetting; tenant-scoped protected routes. |
| 2:28–2:48 | Benchmark/evidence card | 90% semantic recall/100% precision/0 FP; reranked retrieval metrics; 298-test result. State offline semantic caveat. |
| 2:48–2:56 | Repo + MIT + closing URL | Repo, live URL, Track 1. End before 3:00. |

### Video quality gate

- [ ] Final file is under 180 seconds and 1080p or better.
- [ ] Text is readable at normal YouTube playback size.
- [ ] Captions are enabled and names/model ids are spelled correctly.
- [ ] No API key, reviewer token, Authorization header, shell history secret, email, or cloud credential is visible in any frame, thumbnail, caption, or description. Clear the Judge token field before any beauty shot.
- [ ] Claims match [`../docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).
- [ ] The description includes live URL, public repo, Track 1, and architecture/code-proof links.
- [ ] Test the public URL in an incognito window with audio enabled.

**Public video URL:** `____________________________________________`

## 2. Screenshot set

Capture clean 16:9 or high-resolution browser images; hide bookmarks, personal tabs, tokens, and terminal history.

- [ ] Hero: Explorer loaded at the live HTTPS URL with Track 1/product name visible.
- [ ] Grounded recall: answer plus numbered citations in the same frame.
- [ ] Field self-audit: `INV-5521`, both values, and the recency recommendation visible.
- [ ] Semantic self-audit: meaning-level pair and read-only resolution visible; clear/crop out the Judge token field and all auth details.
- [ ] Feedback/lifecycle: correction result or dry-run preview with `confirm` semantics visible.
- [ ] Architecture: export/use [`../docs/architecture.png`](../docs/architecture.png), not a screenshot of raw Mermaid.
- [ ] Live proof: `/ready` and `/health` showing ready + real Qwen model ids.
- [ ] Alibaba proof: ECS/container service and live endpoint in one safe frame; redact account IDs/IP metadata not needed for proof.
- [ ] Repository proof: public repo landing page with MIT license detection and latest commit.

Store originals outside the repo if they include any cloud-console metadata. Add only the sanitized final gallery images.

## 3. Public posts

- [ ] Publish the technical article from [`BLOG.md`](./BLOG.md); replace relative image links with the hosted architecture image.
- [ ] Publish at least one social post from [`POST_DRAFTS.md`](./POST_DRAFTS.md).
- [ ] Confirm each post is public in an incognito window.
- [ ] Add the public blog/social URL to the Devpost submission for the optional bonus.

**Blog URL:** `____________________________________________`
**Social URL:** `____________________________________________`

## 4. Devpost copy/paste fields

- [ ] Project name: **Archon MemoryAgent — a memory that audits itself**
- [ ] Track: **Track 1 — MemoryAgent**
- [ ] Description: paste [`SUBMISSION.md`](./SUBMISSION.md) / [`PROJECT_STORY.md`](./PROJECT_STORY.md) as appropriate.
- [ ] Public repository: <https://github.com/upgradedev/archon-qwen-memoryagent>
- [ ] Live app: <https://memory.43.106.13.19.sslip.io>
- [ ] Alibaba/Qwen code proof: <https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts>
- [ ] Architecture: upload [`../docs/architecture.png`](../docs/architecture.png).
- [ ] Public video: paste the URL recorded above.
- [ ] Blog/social: paste the public URL recorded above.
- [ ] Testing instructions: paste the public click path from [`../docs/JUDGE-GUIDE.md`](../docs/JUDGE-GUIDE.md), then add the reviewer token **only in Devpost's private testing-instructions/credentials area**.
- [ ] Explain uniqueness if both entries are submitted: MemoryAgent is persistent recall/self-audit; Autopilot is a bounded AP decision/action workflow. They are separate, substantially different entries.
- [ ] Preview every link while logged out.
- [ ] Submit before the deadline and save the confirmation email/page as the receipt.

**Devpost submission URL:** `____________________________________________`
**Submission confirmation saved:** `[ ]`
