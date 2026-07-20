# Archon MemoryAgent — strict final judge review

This is a claim audit for **Track 1: MemoryAgent** only. The Autopilot entry has its own repository and evidence; duplicating its status here previously created drift. Eligibility and packaging are checked against the [official detailed rules](https://qwencloud-hackathon.devpost.com/rules), which control over summary-page wording.

## Rules readiness

| Requirement | Evidence | Honest status |
|---|---|---|
| Public source repository | <https://github.com/upgradedev/archon-qwen-memoryagent> | Ready after final changes are pushed |
| Detectable open-source license | Root [`LICENSE`](../LICENSE) | Ready (MIT) |
| Alibaba/Qwen code proof | [`src/qwen/client.ts`](../src/qwen/client.ts) and [`ALIBABA_PROOF.md`](./ALIBABA_PROOF.md) | Ready |
| Working Alibaba deployment | [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md), project-contained controller evidence, public `/health` + `/ready` | **Ready for current runtime source:** `0910ab7…` is live-verified from attempt 27 under the reviewed `terminal-success-truncated-output` mode; the canonical final-media artifact passed against that exact evidence in [run 29742958323](https://github.com/upgradedev/archon-qwen-memoryagent/actions/runs/29742958323) |
| Architecture diagram | [`docs/judge-architecture.svg`](../docs/judge-architecture.svg) / [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg) | Ready |
| Organizer PPT/PDF deck (strict-union artifact) | Only if a separate organizer flow requests it | **Not required by the current Devpost form:** no placeholder deck is attached; build and review the strict-union PPT/PDF only if separately requested |
| Text description + track | [`SUBMISSION.md`](./SUBMISSION.md) and [`PROJECT_STORY.md`](./PROJECT_STORY.md) | Ready |
| Public video under three minutes | [Public YouTube demo](https://www.youtube.com/watch?v=pvfe8ZDfMfM) plus [run 29742958323](https://github.com/upgradedev/archon-qwen-memoryagent/actions/runs/29742958323) | **Ready:** the canonical 172-second, 1080p MP4 is public with the reviewed thumbnail, exact English SRT, visible synthetic-audio disclosure and no copyright-check issues |
| Free/unrestricted judging access | Public no-login path plus dedicated low-privilege reviewer credential in Devpost testing instructions | Ready as instructions; entrant must verify field visibility, preview logged out, and rotate after judging |
| Optional public blog post | [`BLOG.md`](./BLOG.md) | **Pending dev.to publication; a draft is not bonus-eligible** |
| Entrant eligibility, ownership, third-party rights | Human sign-off in [`FINAL_MEDIA_CHECKLIST.md`](./FINAL_MEDIA_CHECKLIST.md#5-entrant-and-rights-sign-off) | **Pending human attestation; cannot be inferred from repository automation** |

## Why it is competitive

### Innovation & Qwen use (30%)

- The rule audit detects conflicting cross-session memories and recommends a value without mutation: **5/5 injected problems, 0 false positives; 4/4 declared-policy conformance**. Authenticated human application is a separate atomic action.
- The additive semantic audit detects opposition without a shared field. Its live Explorer proof visibly limits Qwen to at most one eligible, highest-similarity `insight` pair (`maxPairs: 1`); the separate offline fixture is measured at **90% recall, 100% precision, 0 false positives**. A historical frozen 48-pair developer-labelled synthetic run reports **97.92% accuracy, 100% precision, 95.83% recall** per stability repetition, retaining one embedding timeout as an inconclusive false negative; its dirty-tree metadata is not final release provenance.
- Qwen is used across `text-embedding-v4`, `qwen-plus` narration/one-call bounded listwise reranking/function calling, the health-visible configured semantic judge (`qwen-plus` rollback baseline; candidate only after promotion), and `qwen-vl-max` document extraction. The final release-bound gate requires response-reported qwen-vl provenance on an original synthetic two-PNG dry-run plus zero writes/count delta/marker residue. Four typed MCP/custom skills share one dispatcher and accept six validated memory kinds.
- Feedback evidence is cross-session and falsifiable: Session A stores a correction; a separately authenticated fresh Session B must recall, cite and apply it. This is durable state, not autonomous training or model-weight learning.

### Technical depth (30%)

- Persistent pgvector memory, hybrid dense + lexical RRF, one bounded listwise Qwen rerank/fallback, provenance, and cross-session teardown/restart tests. Retrieval gains and hybrid≥dense gates are explicitly limited to the disclosed fixture.
- Server-owned tenant mapping, protected mutations/heavy semantic audit, durable two-tier quotas, exact invoice idempotency, dry-run/confirm lifecycle, and HTTP MCP fail-closed authentication.
- Currency-safe P&L never combines mixed currencies; unknown/partial/refund cash states remain explicit.
- Exact suite and coverage values come from the final immutable CI artifact; real-DB skips are explicit. A real-PostgreSQL integration slice verifies document `dryRun` executes the pipeline while adding zero rows.
- Published historical live load evidence records a rate-bounded, read-only ramp of
  342 HTTP requests with 42 grounded Qwen recalls and zero HTTP failures. It is
  stability/latency evidence for exact release `e4b208a…`, not saturation,
  maximum-throughput or current-source attestation.

### Value (25%)

The entry addresses a concrete failure mode: a long-lived agent can recall two incompatible facts and remain confidently silent. It turns that hidden conflict into a cited, reviewable recommendation. The shipped financial proof is deliberately bounded to payroll evidence plus purchase/sales invoices and currency-separated P&L.

### Presentation (15%)

The README leads with the differentiator, the judge guide separates public and authenticated paths, the architecture exposes trust boundaries, and every numerical claim maps to committed evidence in [`docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).

## Strict remaining caveats

1. Both semantic sets are synthetic and developer-labelled; the 48-pair online result is a frozen-set evaluation, not production prevalence or an independent expert annotation study.
2. The Mem0 evidence supports only the pinned version/configuration and disclosed `dir()`/search probe. The honest conclusion is retrieval parity plus no separately named contradiction/resolution method matched there—not absence of internal/differently named behavior or universal superiority.
3. Payroll source documents are the implemented vision/text pipeline. Purchase/sales invoices use a strict JSON endpoint. Orders, receipts, general bank statements, EBITDA, and sales targets are outside the shipped claim.
4. Public seed and recall are quota-bounded; protected features require the dedicated judge credential. The final video must show both paths without exposing it.
5. Exact runtime source `0910ab7…` is live-verified from attempt 27 under the
   reviewed `terminal-success-truncated-output` evidence mode. Final media still
   requires a fresh SHA-bound capture review, including public and
   protected journeys; endpoint health alone does not attest a commit or media file.
6. The human-control gallery frame intentionally proves **Defer only** with zero API
   call and zero mutation. Accept/Override are protected product actions with separate
   tests, not live actions claimed by that frame. The lifecycle row is
   feedback-superseded/retention-eligible, not age-expired.

## Final verdict

The source and exact-runtime release gate are **green** for
`0910ab7fe03631321d37e73002054ae7bb740c49`. Remaining gates are SHA-bound gallery
and video capture, public media/post hosting, platform fields, eligibility/rights
sign-off, judging-window monitoring and—only after separate entrant authorization—the
eventual submission receipt. Deadline: **2026-07-20, 2:00 PM PDT**.
