# Archon MemoryAgent — claim/evidence matrix

Use this file as the single source of truth while writing the Devpost page, recording narration, taking screenshots, or answering judges. A claim not listed here should be treated as unverified until evidence is added.

## Core track and product claims

| Judge-facing claim | Evidence | Exact supported wording / caveat |
|---|---|---|
| Persistent memory survives sessions | `src/memory/store.ts`, `src/db/schema.sql`, `tests/e2e/cross-session.test.ts` | Session A writes and closes; a fresh Session B recalls from PostgreSQL. The database is the only shared state. |
| Queryable under limited context | `src/memory/memory.ts`, `src/memory/store.ts`, `src/server.ts` | Hybrid dense + lexical recall supports company/kind filters and a bounded result count (HTTP maximum 20). Do not claim the whole store fits in one prompt. |
| Memory improves through explicit feedback | `src/agents/memory-agent.ts`, `POST /feedback`, unit/e2e tests | A reviewer can protect a correct memory or supersede an incorrect memory with a high-importance correction. Say “explicit feedback loop,” not autonomous self-learning. |
| Timely forgetting / hygiene | `src/memory/consolidation.ts`, `src/db/schema.sql`, `POST /consolidate`, `POST /forget` | Tenant-scoped consolidation and retention preview by default; `confirm=true` is required to mutate/delete. Every call requires an operation id + explicit reason; confirmed results and server-derived actor/reason are persisted atomically for replay/audit, while dry-runs explicitly report `persisted=false`. |
| Six memory kinds, four tools | `src/memory/store.ts`, `src/skills/schemas.ts` | Kinds: `document`, `payroll_event`, `validation`, `insight`, `invoice`, `action`. Tools: `recall_memory`, `ingest_memory`, `audit_memory`, `memory_count`. Do not conflate kind count with tool count. |

## Differentiator and measured quality

| Claim | Evidence / reproduction | Verified result | Caveat |
|---|---|---:|---|
| Field-level self-audit detects conflicts/absence | `npm run bench:consistency -- --gate`; `bench/consistency-*`; `src/memory/consistency.ts` | **5/5 injected problems, 0 false positives** | Labelled committed fixture, not every possible domain conflict. |
| Resolution recommender follows policy | `npm run bench:resolution -- --gate`; `bench/resolution-*` | **4/4 declared-policy conformance (selected memory + rule)** | Policy-conformance, not proof that importance → authority → recency is universally optimal. The audit is read-only; a separate authenticated endpoint applies a human selection atomically. |
| Meaning-level audit | `npm run bench:semantic -- --gate`; `bench/semantic-consistency-*`; `src/memory/semantic-consistency.ts` | **90% recall, 100% precision, 0 false positives** | Measures the deterministic offline judge. It is not a live-`qwen-plus` accuracy estimate; one cue-free pair is missed. |
| Historical online meaning-level frozen-set evidence | `bench/results/semantic-heldout-qwen-v1.1.json`; protocol SHA in `BENCHMARK.md` | **Per repetition: 97.92% accuracy, 100% precision, 95.83% recall, 100% specificity, 97.87% F1** | Frozen 48-pair developer-labelled synthetic set, not independent human evaluation or production prevalence; three stability repetitions reuse one frozen embedding pass. One embedding timeout is conservatively one inconclusive false negative in every repetition. The immutable metadata says `gitDirty: true` and contains a host-specific command, so cite it as historical evidence only; use the clean-source same-commit A/B promotion artifact for the final model decision. |
| Reranked hybrid beats dense top-rank baseline | `npm run bench -- --gate`; `bench/golden.json`; `BENCHMARK.md` | **MRR 0.883 → 0.911; nDCG@5 0.903 → 0.938; Recall@3 90.0% → 96.7%** | Frozen labelled fixture with committed real `text-embedding-v4` vectors. |
| Answer fixture EUR-token checks | `npm run bench:accuracy -- --gate`; `BENCHMARK.md` | **11/11 gold-memory recall@5; 11/11 developer-labelled gold EUR-token hit; 10/11 complete EUR-labelled amount traceability** | Literal token/provenance checks only: `€`/`EUR` may appear on either side. They do not grade prose, truth, arithmetic, semantic equivalence, or general answer quality. The historical fixture predates the current stricter narrator guard; one derived amount is retained as untraceable. |
| Mem0 comparison | historical `bench/external/mem0-evidence.json`; versioned v2 protocol/runner; `BENCHMARK.md` | Historical probe records gold-figure top-5 on 5/5 for both and no separately named contradiction/resolution method matched its disclosed `dir()` filter | Pinned `mem0ai==2.0.11`, tiny tested configuration only. Historical JSON lacks v2 clean-tree/source/provider attestation. The name probe does not exclude internal, undocumented, differently named, or newer behavior. Do not claim universal inferiority. |

## Qwen, Alibaba, and protocol claims

| Claim | Evidence | Safe wording |
|---|---|---|
| Qwen models are genuinely used | `src/qwen/client.ts`, `src/memory/embeddings.ts`, `src/agents/narrator.ts`, `src/memory/rerank.ts`, `src/memory/semantic-consistency.ts`, `src/pipeline/vision.ts` | `text-embedding-v4` for embeddings; `qwen-plus` for narration, rerank, and skills; health-visible `QWEN_JUDGE_MODEL` for semantic judging (`qwen-plus` rollback baseline, candidate only after promotion); `qwen-vl-max` for document vision extraction. |
| Alibaba deployment | `Dockerfile`, `docker-compose.yml`, `deploy/DEPLOY_STATE.md`, `demo/ALIBABA_PROOF.md`, live `/health` and `/ready` | The live topology is Alibaba ECS compose with PostgreSQL/pgvector, but current-source attestation is pending. Previous runtime `e4b208a…` passed the full release gate; current candidate `aee7897…` contains a runtime UI fix and is not yet claimed as deployed. Function Compute + managed pg-wire store remains an alternative artifact. |
| Competition build window | Repository history, earliest commit `6ec9389` dated 2026-07-01 | The entry was materially built during the competition window. The repository history begins after the 2026-05-26 opening, but establishes only recorded repository timing; history alone is not proof of authorship, originality, or completeness. |
| REST + MCP + Qwen skills share one core | `src/server.ts`, `src/mcp/*`, `src/skills/*`, `src/agents/memory-agent.ts` | Four typed operations dispatch through the shared `SkillDispatcher`/`MemoryAgent`; no duplicated memory implementation. |
| MCP transports are bounded | `src/mcp/server.ts`, `src/mcp/stdio-policy.ts`, `tests/security/mcp-boundary.test.ts`, `tests/security/mcp-stdio-boundary.test.ts` | Streamable HTTP always fails closed without Bearer/`x-api-key`, maps credentials to tenants, bounds bodies, and applies atomic per-principal/global quotas. stdio is trusted-local but not unmetered: provider tools use the operator tenant, the same admission + durable `mcp:judge:*` quota pool, bounded text-only results, and generic correlated errors. Real-Qwen stdio requires PostgreSQL; production is explicit opt-in; serverless rejects stdio. |
| Production uses real Qwen | `src/server.ts` provider guard, `GET /ready`, `.env.example` | Production Qwen-heavy routes fail closed with Fake providers unless an explicit non-qualifying override is enabled. A qualifying release requires `/ready` 200 and real model ids in `/health`. |

## Security, data integrity, and financial scope

| Claim | Evidence | Exact contract |
|---|---|---|
| Tenant isolation | `src/server/auth.ts`, `src/server.ts`, `src/memory/store.ts`, `tests/security/authz.test.ts` | Credentials map to a tenant server-side; caller bodies/headers cannot select another tenant. Public no-credential reads use only `PUBLIC_TENANT_ID`. Invalid credentials fail. |
| Protected mutations | Route `preHandler` declarations in `src/server.ts` | `/ingest`, `/ingest/invoice`, `/ingest/documents`, `/feedback`, `/resolve-conflict`, `/consistency/semantic`, `/consolidate`, and `/forget` require auth in production. Public fixed seed/recall/rule-audit/P&L/list/count remain confined to the public tenant. |
| Bounded Qwen spend | `src/server/quota.ts`, `src/server.ts`, `src/mcp/server.ts`, `src/mcp/stdio-policy.ts`, `src/server/admission.ts` | Atomic UTC-daily per-subject/IP + global pools meter disclosed preflight policy weights across HTTP and both MCP transports—not provider billing or transport-attempt counts. REST/MCP recall reserves four worst-case logical model operations; HTTP document batches reserve a fixed five per document; MCP single-fact ingest reserves one; semantic audit reserves its bounded pair fan-out. Oversized first-use charges fail before mutation, multi-tier reservations are all-or-nothing, and operational counters expire after 30 days (they are not a permanent audit log). Canonical MCP validation runs before reservation, so malformed calls debit zero. Independent public/reviewer in-flight pools reject saturation without starting provider work; real-Qwen stdio cannot fall back to a per-process quota. |
| Invoice idempotency | `POST /ingest/invoice`, store atomic-write tests | Exact retry returns the original logical write; a changed payload for the same invoice identity returns `409`. Do not say every arbitrary ingest route has the same business-key contract. |
| Currency safety | `src/pipeline/currency.ts`, `src/pipeline/pnl.ts`, `tests/unit/pnl.test.ts` | Invoice currency is mandatory and validated against supported ISO 4217 values. Payroll without supported currency evidence increments `unknown_currency_records` and is excluded from monetary aggregation; it is never silently EUR or combined as an `UNSPECIFIED` pseudo-currency. Mixed/unknown evidence yields `null` top-level monetary totals; `by_currency` contains independent evidenced-currency totals only. |
| Cash status is honest | `src/pipeline/pnl.ts` | Purchase cash may be `unpaid`, `partial`, `paid`, `refund`, or `unknown`; unknown paid amounts are separated rather than assumed. |
| Shipped financial inputs | `src/pipeline/models.ts`, `src/pipeline/event-linker.ts`, `POST /ingest/invoice` | Document pipeline: payroll register, bank confirmation, payslip supplied as scanned-image data URL, caller-extracted PDF text, or text. The API does not parse raw PDF bytes. Structured path: purchase/sales invoice. Each fused event is atomically committed; do not claim a multi-event request is one transaction or claim shipped order/receipt/general-bank-statement extraction, EBITDA, or sales targets. |

## Verification and submission evidence

| Item | Verified value / artifact |
|---|---|
| Full test run and coverage | Use the immutable artifacts from the final CI run; do not hand-copy counts into submission text. |
| Docs consistency | `npm run test:docs` |
| Judge architecture hero | [`judge-architecture.svg`](./judge-architecture.svg) and [`demo/final-media/judge-architecture.jpg`](../demo/final-media/judge-architecture.jpg) |
| Dense technical architecture | [`architecture.mmd`](./architecture.mmd), [`architecture.svg`](./architecture.svg), [`architecture.png`](./architecture.png) |
| Public repo / license | <https://github.com/upgradedev/archon-qwen-memoryagent> · root `LICENSE` (MIT) |
| Code proof URL | <https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts> |
| Live URL | <https://memory.43.106.13.19.sslip.io> |
| Exact deployed runtime source | **No current-source claim yet.** Previous verified live source [`e4b208a63e1768409e5b94fe305a3672c4c96dcd`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/e4b208a63e1768409e5b94fe305a3672c4c96dcd) is historical. Current candidate [`aee7897d4d436501fc9b0dc1ed28e3757131f559`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/aee7897d4d436501fc9b0dc1ed28e3757131f559) is undeployed/unverified until the new exact release record is completed · [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) |
| Judge steps | [`JUDGE-GUIDE.md`](./JUDGE-GUIDE.md) |

Real-PostgreSQL slices skip when no integration database is supplied; the final CI artifact must show the exact executed/skipped counts. A draft/local video and an unpublished blog are not complete submission/bonus evidence. Public hosting URLs belong in [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md) and Devpost after publication.
