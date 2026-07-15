# Archon MemoryAgent — strict final judge review

This is a claim audit for **Track 1: MemoryAgent** only. The Autopilot entry has its own repository and evidence; duplicating its status here previously created drift. Eligibility and packaging are checked against the [official detailed rules](https://qwencloud-hackathon.devpost.com/rules), which control over summary-page wording.

## Rules readiness

| Requirement | Evidence | Honest status |
|---|---|---|
| Public source repository | <https://github.com/upgradedev/archon-qwen-memoryagent> | Ready after final changes are pushed |
| Detectable open-source license | Root [`LICENSE`](../LICENSE) | Ready (MIT) |
| Alibaba/Qwen code proof | [`src/qwen/client.ts`](../src/qwen/client.ts) and [`ALIBABA_PROOF.md`](./ALIBABA_PROOF.md) | Ready |
| Working Alibaba deployment | [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md), public `/health` + `/ready` | Exact runtime source `e4b208a63e1768409e5b94fe305a3672c4c96dcd` verified live, including v4 idempotent reconciliation |
| Architecture diagram | [`docs/judge-architecture.svg`](../docs/judge-architecture.svg) / [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg) | Ready |
| Text description + track | [`SUBMISSION.md`](./SUBMISSION.md) and [`PROJECT_STORY.md`](./PROJECT_STORY.md) | Ready |
| Public video under three minutes | Final recording must be hosted on an accepted public platform | **Pending user upload; a local MP4 is not a pass** |
| Free/unrestricted judging access | Public no-login path plus dedicated low-privilege reviewer credential in Devpost testing instructions | Ready as instructions; entrant must verify field visibility, preview logged out, and rotate after judging |
| Optional public blog/social post | [`BLOG.md`](./BLOG.md) and [`POST_DRAFTS.md`](./POST_DRAFTS.md) | **Pending publication; a draft is not bonus-eligible** |
| Entrant eligibility, ownership, third-party rights | Human sign-off in [`FINAL_MEDIA_CHECKLIST.md`](./FINAL_MEDIA_CHECKLIST.md#5-entrant-and-rights-sign-off) | **Pending human attestation; cannot be inferred from repository automation** |

## Why it is competitive

### Innovation & Qwen use (30%)

- The rule audit detects conflicting cross-session memories and recommends a value without mutation: **5/5 injected problems, 0 false positives; 4/4 declared-policy conformance**. Authenticated human application is a separate atomic action.
- The additive semantic audit detects opposition without a shared field and is measured offline at **90% recall, 100% precision, 0 false positives**. A historical frozen 48-pair developer-labelled synthetic run reports **97.92% accuracy, 100% precision, 95.83% recall** per stability repetition, retaining one embedding timeout as an inconclusive false negative; its dirty-tree metadata is not final release provenance.
- Qwen is used across `text-embedding-v4`, `qwen-plus` narration/reranking/function calling, the health-visible configured semantic judge (`qwen-plus` rollback baseline; candidate only after promotion), and `qwen-vl-max` document extraction. Four typed MCP/custom skills share one dispatcher and accept six validated memory kinds.

### Technical depth (30%)

- Persistent pgvector memory, hybrid dense + lexical RRF, bounded reranking/fallback, provenance, and cross-session teardown/restart tests.
- Server-owned tenant mapping, protected mutations/heavy semantic audit, durable two-tier quotas, exact invoice idempotency, dry-run/confirm lifecycle, and HTTP MCP fail-closed authentication.
- Currency-safe P&L never combines mixed currencies; unknown/partial/refund cash states remain explicit.
- Exact suite and coverage values come from the final immutable CI artifact; real-DB skips are explicit.

### Value (25%)

The entry addresses a concrete failure mode: a long-lived agent can recall two incompatible facts and remain confidently silent. It turns that hidden conflict into a cited, reviewable recommendation. The shipped financial proof is deliberately bounded to payroll evidence plus purchase/sales invoices and currency-separated P&L.

### Presentation (15%)

The README leads with the differentiator, the judge guide separates public and authenticated paths, the architecture exposes trust boundaries, and every numerical claim maps to committed evidence in [`docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).

## Strict remaining caveats

1. Both semantic sets are synthetic and developer-labelled; the 48-pair online result is a frozen-set evaluation, not production prevalence or an independent expert annotation study.
2. The Mem0 evidence supports only the pinned version/configuration and disclosed `dir()`/search probe. The honest conclusion is retrieval parity plus no separately named contradiction/resolution method matched there—not absence of internal/differently named behavior or universal superiority.
3. Payroll source documents are the implemented vision/text pipeline. Purchase/sales invoices use a strict JSON endpoint. Orders, receipts, general bank statements, EBITDA, and sales targets are outside the shipped claim.
4. Public seed and recall are quota-bounded; protected features require the dedicated judge credential. The final video must show both paths without exposing it.
5. Deployment claims are valid only after the final image passes `/ready`, real-model `/health`, and OpenAPI-route smoke checks.

## Final verdict

The code, evidence, and exact-runtime release gate are green at `e4b208a63e1768409e5b94fe305a3672c4c96dcd`. Remaining user-owned work is final video production/publication, screenshots, public posts, Devpost field/credential entry and eligibility/rights sign-off, availability monitoring through judging, and the submission receipt. Deadline: **2026-07-20, 2:00 PM PDT**.
