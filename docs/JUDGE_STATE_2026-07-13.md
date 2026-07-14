# Historical judge-state filename — superseded 2026-07-15

This file keeps its dated name so old links do not break. Its former July 13 snapshot is superseded; it contained pre-hardening test counts, an obsolete claim that semantic audit lacked a labelled benchmark, and deployment assumptions that should not be used as evidence.

The canonical current sources are:

- [`CLAIM_EVIDENCE_MATRIX.md`](./CLAIM_EVIDENCE_MATRIX.md) for every judge-facing claim and caveat;
- [`JUDGE-GUIDE.md`](./JUDGE-GUIDE.md) for the public and authenticated click paths;
- [`architecture.svg`](./architecture.svg) / [`architecture.png`](./architecture.png) for the submission diagram; and
- [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md) for the remaining human-owned work.

## Current verified engineering evidence

| Evidence | Verified result |
|---|---|
| Full Node test/coverage surface | **300 total · 285 pass · 0 fail · 15 intentional real-DB skips** |
| Coverage | **91.96% statements · 84.96% branches · 91.25% functions · 91.96% lines** |
| Field-level self-audit | **5/5 injected problems detected · 0 false positives** |
| Resolution policy | **4/4 winners and 4/4 rules correct** on the labelled policy set |
| Meaning-level self-audit | **90% recall · 100% precision · 0 false positives** on the committed offline labelled set |
| Reranked hybrid retrieval | **MRR 0.911 · nDCG@5 0.938 · Recall@3 96.7%** |
| Grounded-answer evaluation | **100% correctness · 90.9% grounding/faithfulness** |

The semantic figures measure the deterministic offline judge, not live-Qwen accuracy. The 15 skipped tests are the real-PostgreSQL slices when no integration database is supplied; they are not failures.

## Current trust and scope contract

- Production mutations, feedback, lifecycle operations, and `/consistency/semantic` require a judge credential and are tenant-scoped by the server-owned credential mapping.
- The fixed `/demo/seed` and public-tenant read path need no login. Qwen-spending public seed/recall calls remain bounded by per-IP plus global quotas.
- Streamable HTTP MCP is always authenticated/fail-closed; stdio is the local trusted transport.
- There are exactly four MCP/custom-skill operations and six `MemoryKind` values: `document`, `payroll_event`, `validation`, `insight`, `invoice`, and `action`.
- The shipped financial scope is payroll evidence plus strict purchase/sales invoice ingestion and currency-separated P&L. Orders, receipts, general bank statements, EBITDA, and sales targets are not shipped claims.

## Submission state rule

Do not freeze a live-deployment assertion in this dated file. A release is current only after `/ready` returns `200`, `/health` reports real Qwen model ids, and `/openapi.json` contains the protected invoice, feedback, semantic, and lifecycle routes. The final public video and screenshots must be recorded only after that smoke test.

Deadline: **2026-07-20 at 2:00 PM PDT**. A draft video or blog is not a completed rule/bonus item until it is publicly hosted and its URL is entered in Devpost.
