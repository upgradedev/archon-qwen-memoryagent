# Final screenshot manifest and captions

Capture only from the verified release described in
[`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md). Raw captures stay in ignored
`demo/private-originals/`; only reviewed, sanitized files belong in
`demo/gallery/`. Do not fabricate a result, hand-edit a response value, or combine
screens from different releases into one claimed live journey.

## Primary Devpost gallery — upload in this order

| Order | Canonical file | Required visible proof | English gallery caption |
|---:|---|---|---|
| 1 | `demo/gallery/01-grounded-cross-session-recall.png` | Live hostname, grounded answer, numbered memory citations | **A fresh session recalls a bounded slice of durable pgvector memory and grounds the Qwen answer in numbered evidence.** |
| 2 | `demo/gallery/02-read-only-field-self-audit.png` | `INV-5521`, `8400`, `8900`, recency recommendation, no secret field value | **The read-only audit keeps both cross-session values visible and recommends a policy winner without rewriting history.** |
| 3 | `demo/gallery/03-qwen-semantic-self-audit.png` | “always pays on time” vs “chronically late”, configured model/completion provenance; token fully absent/cropped | **Qwen catches a meaning-level contradiction with no shared numeric field; the result remains a recommendation, not an automatic edit.** |
| 4 | `demo/gallery/04-human-resolution-control.png` | Accept/Override/Defer or equivalent response, provenance preserved | **A separate authenticated human decision can accept, override or defer the recommendation through one atomic, idempotent action.** |
| 5 | `demo/gallery/05-safe-memory-lifecycle.png` | Preview plus confirmed consolidation/forgetting result, reason and tenant-safe status; no token | **Memory hygiene is explicit: preview first, then authenticated confirmation and reason, with an auditable state transition.** |
| 6 | `demo/final-media/judge-architecture.jpg` | Canonical readable 16:9 architecture | **Qwen embeddings and narration, hybrid pgvector recall, read-only self-audit and human control are separated by explicit trust boundaries.** |

If the gallery has fewer slots, keep **1, 2, 3 and 6** in that order. The thumbnail
is a separate 3:2 asset and should not consume a gallery slot.

## Secondary proof captures

Keep these ready for the video, Devpost story or organizer request; upload them to
the gallery only if they improve rather than crowd the primary sequence.

| Canonical file | Required visible proof | Caption |
|---|---|---|
| `demo/gallery/06-live-health-readiness.png` | `/health` and `/ready`, real model ids, database/Qwen/auth ready; never imply these endpoints prove a Git SHA | **Independent live probes show the real Qwen model configuration and database/auth readiness.** |
| `demo/gallery/07-alibaba-runtime-proof.png` | Sanitized MemoryAgent ECS/container evidence and live hostname; no account, instance, IP/security-group or credential details | **The qualifying live path runs on Alibaba Cloud ECS with a self-hosted PostgreSQL/pgvector container and real Qwen.** |
| `demo/gallery/08-public-repository-license.png` | Repository landing page, public status, MIT detection, current main | **Public MIT-licensed source, deployment instructions and reproducible evidence are available for judging.** |

## Capture and sanitization contract

- Use a clean browser profile at 1440×900 or larger, 100% zoom, English UI, no
  personal tabs, bookmarks bar, avatar, extensions, notifications or autofill.
- Capture at least 1600×900 PNG. Preserve enough browser chrome to prove the live
  HTTPS hostname when the caption calls a frame live.
- Never show `.env`, token values, Authorization headers, request headers, shell
  history, email, cloud ids, private IPs, real customer/financial data or browser
  profile metadata.
- A blurred secret is still a disclosed secret. Rotate it, recapture, and keep only
  the clean frame.
- Do not use the architecture raster as evidence of runtime behavior; it explains
  design. Do not use `/health` or `/ready` as source-commit attestation.
- Compare every visible metric and model id with
  [`docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).
- View every final at 100% and at a small gallery-card size; critical text must be
  readable in both.
- Before staging, run `git status --ignored --short demo/` and
  `git ls-files demo/private-originals/`; the second command must print nothing.
