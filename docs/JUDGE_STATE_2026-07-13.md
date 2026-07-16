# Historical judge-state filename — superseded 2026-07-15

This file keeps its dated name so old links do not break. Its former July 13 snapshot is superseded; it contained pre-hardening test counts, an obsolete claim that semantic audit lacked a labelled benchmark, and deployment assumptions that should not be used as evidence.

The canonical current sources are:

- [`CLAIM_EVIDENCE_MATRIX.md`](./CLAIM_EVIDENCE_MATRIX.md) for every judge-facing claim and caveat;
- [`JUDGE-GUIDE.md`](./JUDGE-GUIDE.md) for the public and authenticated click paths;
- [`judge-architecture.svg`](./judge-architecture.svg) / [`demo/final-media/judge-architecture.jpg`](../demo/final-media/judge-architecture.jpg) for the submission hero; and
- [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md) for the remaining human-owned work.

## Current verified engineering evidence

| Evidence | Verified result |
|---|---|
| Full Node test/coverage surface | Exact values come from the final immutable CI artifact; real-DB skips are explicit. |
| Field-level self-audit | **5/5 injected problems detected · 0 false positives** |
| Resolution policy | **4/4 declared-policy conformance (selected memory + rule)** |
| Meaning-level self-audit | **90% recall · 100% precision · 0 false positives** on the committed offline labelled set |
| Historical online meaning-level evidence | **97.92% accuracy · 100% precision · 95.83% recall** per frozen developer-labelled synthetic-set stability repetition; one embedding timeout retained as an inconclusive false negative; immutable metadata records a dirty tree. No candidate score/promotion is claimed; `qwen-plus` remains the runtime baseline unless a clean same-commit A/B artifact passes the frozen gate. |
| Reranked hybrid retrieval | **MRR 0.911 · nDCG@5 0.938 · Recall@3 96.7%** |
| Answer fixture EUR-token checks | **11/11 gold EUR-token hit · 10/11 complete EUR-labelled amount traceability** |

The 90%/100% semantic figures measure the deterministic offline judge; the
separate online row is the frozen `text-embedding-v4` + `qwen-plus` result. None
is a production-prevalence estimate. Real-PostgreSQL slices skip when no
integration database is supplied; they are not failures.

## Current trust and scope contract

- Production mutations, feedback, lifecycle operations, and `/consistency/semantic` require a judge credential and are tenant-scoped by the server-owned credential mapping.
- The fixed `/demo/seed` and public-tenant read path need no login. Qwen-spending public seed/recall calls remain bounded by per-IP plus global quotas.
- Streamable HTTP MCP is always authenticated/fail-closed; stdio is the local trusted transport.
- There are exactly four MCP/custom-skill operations and six `MemoryKind` values: `document`, `payroll_event`, `validation`, `insight`, `invoice`, and `action`.
- The shipped financial scope is payroll evidence plus strict purchase/sales invoice ingestion and currency-separated P&L. Orders, receipts, general bank statements, EBITDA, and sales targets are not shipped claims.

## Submission state rule

Do not freeze a live-deployment assertion in this dated file. A release is current only after `/ready` returns `200`, `/health` reports real Qwen model ids, and `/openapi.json` contains the protected invoice, feedback, semantic, and lifecycle routes. The final public video and screenshots must be recorded only after that smoke test.

Deadline: **2026-07-20 at 2:00 PM PDT**. A draft video or blog is not a completed rule/bonus item until it is publicly hosted and its URL is entered in Devpost.
