# Archon MemoryAgent — claim/evidence matrix

Use this file as the single source of truth while writing the Devpost page, recording narration, taking screenshots, or answering judges. A claim not listed here should be treated as unverified until evidence is added.

## Core track and product claims

| Judge-facing claim | Evidence | Exact supported wording / caveat |
|---|---|---|
| Persistent memory survives sessions | `src/memory/store.ts`, `src/db/schema.sql`, `tests/e2e/cross-session.test.ts` | Session A writes and closes; a fresh Session B recalls from PostgreSQL. The database is the only shared state. |
| Queryable under limited context | `src/memory/memory.ts`, `src/memory/store.ts`, `src/server.ts` | Hybrid dense + lexical recall supports company/kind filters and a bounded result count (HTTP maximum 20). Do not claim the whole store fits in one prompt. |
| Memory improves through explicit feedback | `src/agents/memory-agent.ts`, `POST /feedback`, unit/e2e tests | A reviewer can protect a correct memory or supersede an incorrect memory with a high-importance correction. Say “explicit feedback loop,” not autonomous self-learning. |
| Timely forgetting / hygiene | `src/memory/consolidation.ts`, `POST /consolidate`, `POST /forget` | Tenant-scoped consolidation and retention preview by default; `confirm=true` is required to mutate/delete. |
| Six memory kinds, four tools | `src/memory/store.ts`, `src/skills/schemas.ts` | Kinds: `document`, `payroll_event`, `validation`, `insight`, `invoice`, `action`. Tools: `recall_memory`, `ingest_memory`, `audit_memory`, `memory_count`. Do not conflate kind count with tool count. |

## Differentiator and measured quality

| Claim | Evidence / reproduction | Verified result | Caveat |
|---|---|---:|---|
| Field-level self-audit detects conflicts/absence | `npm run bench:consistency -- --gate`; `bench/consistency-*`; `src/memory/consistency.ts` | **5/5 injected problems, 0 false positives** | Labelled committed fixture, not every possible domain conflict. |
| Resolution recommender follows policy | `npm run bench:resolution -- --gate`; `bench/resolution-*` | **4/4 winners, 4/4 rules correct** | Policy-conformance, not proof that importance → authority → recency is universally optimal. Read-only recommendation. |
| Meaning-level audit | `npm run bench:semantic -- --gate`; `bench/semantic-consistency-*`; `src/memory/semantic-consistency.ts` | **90% recall, 100% precision, 0 false positives** | Measures the deterministic offline judge. It is not a live-`qwen-plus` accuracy estimate; one cue-free pair is missed. |
| Reranked hybrid beats dense top-rank baseline | `npm run bench -- --gate`; `bench/golden.json`; `BENCHMARK.md` | **MRR 0.883 → 0.911; nDCG@5 0.903 → 0.938; Recall@3 90.0% → 96.7%** | Frozen labelled fixture with committed real `text-embedding-v4` vectors. |
| Answer quality | `npm run bench:accuracy -- --gate`; `BENCHMARK.md` | **100% correctness; 90.9% grounding/faithfulness; gold recall@5 100%** | Fixture evaluation; one derived number is intentionally not credited as grounded. |
| Mem0 comparison | `bench/external/`, `BENCHMARK.md` | Gold retrieval in top 5 on 5/5 for both; tested Mem0 surface exposed no contradiction/resolution API | Pinned `mem0ai==2.0.11`, tested configuration only. Do not claim universal inferiority or “destructive” behaviour. |

## Qwen, Alibaba, and protocol claims

| Claim | Evidence | Safe wording |
|---|---|---|
| Qwen models are genuinely used | `src/qwen/client.ts`, `src/memory/embeddings.ts`, `src/agents/narrator.ts`, `src/memory/rerank.ts`, `src/memory/semantic-consistency.ts`, `src/pipeline/vision.ts` | `text-embedding-v4` for embeddings; `qwen-plus` for narration, rerank, semantic judging, and skills; `qwen-vl-max` for document vision extraction. |
| Alibaba deployment | `Dockerfile`, `docker-compose.yml`, `deploy/`, `demo/ALIBABA_PROOF.md`, live `/health` and `/ready` | The qualifying live path is an Alibaba Cloud ECS compose stack with PostgreSQL/pgvector. Function Compute + managed pg-wire store is an alternative artifact, not the claimed active topology. |
| REST + MCP + Qwen skills share one core | `src/server.ts`, `src/mcp/*`, `src/skills/*`, `src/agents/memory-agent.ts` | Four typed operations dispatch through the shared `SkillDispatcher`/`MemoryAgent`; no duplicated memory implementation. |
| Remote MCP is protected | `src/mcp/server.ts`, `tests/security/mcp-boundary.test.ts` | Streamable HTTP always fails closed without Bearer/`x-api-key`, maps credentials to tenants, limits request bodies, and applies per-principal/global quotas. stdio is the local trusted transport. |
| Production uses real Qwen | `src/server.ts` provider guard, `GET /ready`, `.env.example` | Production Qwen-heavy routes fail closed with Fake providers unless an explicit non-qualifying override is enabled. A qualifying release requires `/ready` 200 and real model ids in `/health`. |

## Security, data integrity, and financial scope

| Claim | Evidence | Exact contract |
|---|---|---|
| Tenant isolation | `src/server/auth.ts`, `src/server.ts`, `src/memory/store.ts`, `tests/security/authz.test.ts` | Credentials map to a tenant server-side; caller bodies/headers cannot select another tenant. Public no-credential reads use only `PUBLIC_TENANT_ID`. Invalid credentials fail. |
| Protected mutations | Route `preHandler` declarations in `src/server.ts` | `/ingest`, `/ingest/invoice`, `/ingest/documents`, `/feedback`, `/consistency/semantic`, `/consolidate`, and `/forget` require auth in production. Public fixed seed/recall/rule-audit/P&L/list/count remain available in the public tenant. |
| Bounded Qwen spend | `src/server/quota.ts`, `src/server.ts`, `src/mcp/server.ts` | Atomic UTC-daily per-subject/IP + global defaults: recall **200/2,000**, ingest/seed **100/500**, semantic **20/100**, MCP **500/2,000**. One accepted request is one quota unit regardless of model fan-out. |
| Invoice idempotency | `POST /ingest/invoice`, store atomic-write tests | Exact retry returns the original logical write; a changed payload for the same invoice identity returns `409`. Do not say every arbitrary ingest route has the same business-key contract. |
| Currency safety | `src/pipeline/pnl.ts`, `tests/unit/pnl.test.ts` | Invoice currency is required. Payroll without currency is `UNSPECIFIED`. Mixed currencies yield `currency_status="mixed"`, `null` top-level monetary totals, and independent `by_currency` totals. |
| Cash status is honest | `src/pipeline/pnl.ts` | Purchase cash may be `unpaid`, `partial`, `paid`, `refund`, or `unknown`; unknown paid amounts are separated rather than assumed. |
| Shipped financial inputs | `src/pipeline/models.ts`, `src/pipeline/event-linker.ts`, `POST /ingest/invoice` | Document pipeline: payroll register, bank confirmation, payslip. Structured path: purchase/sales invoice. Do not claim shipped order/receipt/general-bank-statement extraction, EBITDA, or sales targets. |

## Verification and submission evidence

| Item | Verified value / artifact |
|---|---|
| Full test run | **300 total · 285 pass · 0 fail · 15 intentional real-DB skips** |
| Coverage | **91.96% statements · 84.96% branches · 91.25% functions · 91.96% lines** |
| Docs consistency | `npm run test:docs` |
| Architecture source | [`architecture.mmd`](./architecture.mmd) |
| Architecture renders | [`architecture.svg`](./architecture.svg) and [`architecture.png`](./architecture.png) |
| Public repo / license | <https://github.com/upgradedev/archon-qwen-memoryagent> · root `LICENSE` (MIT) |
| Code proof URL | <https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts> |
| Live URL | <https://memory.43.106.13.19.sslip.io> |
| Judge steps | [`JUDGE-GUIDE.md`](./JUDGE-GUIDE.md) |

The 15 skipped cases are real-PostgreSQL slices when no integration database is supplied. A draft/local video and an unpublished blog are not complete submission/bonus evidence. Public hosting URLs belong in [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md) and Devpost after publication.
