# Archon MemoryAgent — strict final judge review

This is a claim audit for **Track 1: MemoryAgent** only. The Autopilot entry has its own repository and evidence; duplicating its status here previously created drift.

## Rules readiness

| Requirement | Evidence | Honest status |
|---|---|---|
| Public source repository | <https://github.com/upgradedev/archon-qwen-memoryagent> | Ready after final changes are pushed |
| Detectable open-source license | Root [`LICENSE`](../LICENSE) | Ready (MIT) |
| Alibaba/Qwen code proof | [`src/qwen/client.ts`](../src/qwen/client.ts) and [`ALIBABA_PROOF.md`](./ALIBABA_PROOF.md) | Ready |
| Architecture diagram | [`docs/architecture.svg`](../docs/architecture.svg) / [`architecture.png`](../docs/architecture.png) | Ready |
| Text description + track | [`SUBMISSION.md`](./SUBMISSION.md) and [`PROJECT_STORY.md`](./PROJECT_STORY.md) | Ready |
| Public video under three minutes | Final recording must be hosted on an accepted public platform | **Pending user upload; a local MP4 is not a pass** |
| Free/unrestricted judging access | Public no-login path plus private reviewer credential in Devpost testing instructions | Ready as instructions; credential must be pasted privately |
| Optional public blog/social post | [`BLOG.md`](./BLOG.md) and [`POST_DRAFTS.md`](./POST_DRAFTS.md) | **Pending publication; a draft is not bonus-eligible** |

## Why it is competitive

### Innovation & Qwen use (30%)

- The rule audit explicitly detects conflicting cross-session memories and recommends a winner without mutating either record: **5/5 injected problems, 0 false positives; 4/4 labelled policy resolutions**.
- The additive semantic audit detects opposition without a shared field and is measured offline at **90% recall, 100% precision, 0 false positives**. This is an offline deterministic-judge result, not a live-Qwen accuracy claim.
- Qwen is used across `text-embedding-v4`, `qwen-plus` narration/reranking/semantic judging/function calling, and `qwen-vl-max` document extraction. Four typed MCP/custom skills share one dispatcher and accept six validated memory kinds.

### Technical depth (30%)

- Persistent pgvector memory, hybrid dense + lexical RRF, bounded reranking/fallback, provenance, and cross-session teardown/restart tests.
- Server-owned tenant mapping, protected mutations/heavy semantic audit, durable two-tier quotas, exact invoice idempotency, dry-run/confirm lifecycle, and HTTP MCP fail-closed authentication.
- Currency-safe P&L never combines mixed currencies; unknown/partial/refund cash states remain explicit.
- Verified suite: **300 total, 285 pass, 0 fail, 15 real-DB skips**; coverage **91.96% statements, 84.96% branches, 91.25% functions, 91.96% lines**.

### Value (25%)

The entry addresses a concrete failure mode: a long-lived agent can recall two incompatible facts and remain confidently silent. It turns that hidden conflict into a cited, reviewable recommendation. The shipped financial proof is deliberately bounded to payroll evidence plus purchase/sales invoices and currency-separated P&L.

### Presentation (15%)

The README leads with the differentiator, the judge guide separates public and authenticated paths, the architecture exposes trust boundaries, and every numerical claim maps to committed evidence in [`docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).

## Strict remaining caveats

1. The semantic benchmark's offline polarity judge is small and misses one cue-free pair; future work needs a larger live-Qwen-labelled evaluation.
2. The Mem0 evidence supports only the pinned version/configuration and the tested API surface. The honest conclusion is retrieval parity plus no exposed contradiction/resolution API in that run—not universal superiority.
3. Payroll source documents are the implemented vision/text pipeline. Purchase/sales invoices use a strict JSON endpoint. Orders, receipts, general bank statements, EBITDA, and sales targets are outside the shipped claim.
4. Public seed and recall are quota-bounded; protected features require the private judge token. The final video must show both paths without exposing the token.
5. Deployment claims are valid only after the final image passes `/ready`, real-model `/health`, and OpenAPI-route smoke checks.

## Final verdict

The engineering and evidence package is submission-ready once the final deployment smoke is green. The remaining user-owned work is the public video, screenshots, public posts, Devpost credential/URL entry, and final submission receipt. Deadline: **2026-07-20, 2:00 PM PDT**.
