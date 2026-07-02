# Archon MemoryAgent — Qwen × Alibaba Cloud

**Entry for the [Global AI Hackathon Series with Qwen Cloud](https://qwencloud-hackathon.devpost.com/) — `MemoryAgent` track.**

> **Track: MemoryAgent** — an agent with *persistent, queryable memory that retains and recalls information across sessions*.

An agent that gives a small business's financial-intelligence pipeline a **memory**. Every fused financial event, validation finding, and narrated insight is embedded with **Qwen `text-embedding-v4`** (Alibaba Cloud Model Studio / DashScope) and stored in a **pgvector** memory layer. On any later run — a different session, a different process, a fresh container — the agent **recalls the relevant prior facts by meaning** and grounds a **Qwen `qwen-plus`** answer in them. It reasons with continuity instead of starting cold on every request.

Archon itself is a **unified financial-intelligence platform** — it ingests *all* of a business's financial documents and data (sales and purchase invoices, orders, receipts, payments, bank transfers and statements, expenses, and workforce costs) into one environment and produces a consolidated, period-over-period view: **P&L, EBITDA, cash, sales targets, and per-period metrics**, while **cross-checking the whole picture for missing or inconsistent information** — for example, *a bank payment that appears with no matching invoice: did the vendor never send it, did the accountant never register it, or is the payment wrong?* This MemoryAgent gives that pipeline a **memory**: it remembers each consolidated figure and each cross-check finding across sessions and can answer questions about them on any later run. The financial picture it remembers is broad — one memory might be a sales invoice, the next a cash position, the next a completeness anomaly, and among them the **true cost of employing a team** (a bank salary transfer understates it, because it never shows employer social-security contributions) as *one* business aspect among many.

## Why this is a MemoryAgent

| Track requirement | How this entry meets it |
|---|---|
| **Persistent memory** | Memories are embedded and written to pgvector on Alibaba Cloud PostgreSQL — durable, not in-process. |
| **Queryable memory** | Recall is semantic ANN search (`ORDER BY embedding <=> $q`) over an HNSW cosine index, with `kind`/`company` pre-filters. |
| **Across sessions** | The headline e2e test (`tests/e2e/cross-session.test.ts`) proves it: **session A writes and tears down completely; a fresh session B — no shared in-process state — recalls those memories and answers from them.** The only thing shared is the database. |
| **Increasingly accurate over time** | Each ingested event adds recallable facts; later questions retrieve the accumulated memory, not just the current request's context. |

## What makes the memory strong (not just present)

A MemoryAgent lives or dies on **recall quality** and **memory hygiene**. This
entry treats both as first-class, engineered, and *measured* — and adds a
capability most memory demos skip: the agent **audits its own memory**.

- **⭐ Self-auditing memory (the headline).** A cross-session agent accumulates
  facts from many separate write events, and nothing stops two of them from
  **contradicting**: session A stores invoice `INV-2043` at €18,400; a later
  session B stores €18,900 for the same record. Plain recall just returns whichever
  ranked higher and stays silent. `POST /consistency` (`src/memory/consistency.ts`)
  scans the agent's own memories, groups them by the record they describe, and
  flags **cross-session contradictions** (same record + attribute, different value
  across write events) and **dangling references** (a memory points at a record no
  memory stores). It's a **pure, domain-neutral** engine — not a finance rulebook —
  and it's *measured*: on a labelled dataset it detects **5/5 injected problems
  with 0 false positives** on a consistent control set (100% precision). This is
  memory you can *trust*, because it tells you when it disagrees with itself.
  And it doesn't just detect — for every contradiction it **recommends which side
  to trust** (`resolution: { recommendedMemoryId, recommendedValue, rule,
  confidence, rationale }`) via a fixed, domain-neutral priority ladder —
  **importance → source-authority → recency (later write wins)** — over signals
  already on the memories. It's a *recommender, not ground truth*: it **never
  mutates memory**, and it is measured too (**4/4 correct** on a labelled
  resolution set; `npm run bench:resolution`). Full method + honesty caveats:
  **[BENCHMARK.md](./BENCHMARK.md)**.
- **Hybrid retrieval (dense + lexical, RRF) + a cross-encoder re-ranker.** Agent
  memories are full of exact tokens dense embeddings blur — document numbers
  (`INV-2043`, `PINV-771`), euro figures, company names, period codes. Recall fuses
  `text-embedding-v4` cosine search with BM25/full-text lexical search using
  **Reciprocal Rank Fusion**, then a **cross-encoder re-rank stage** (`qwen-plus`
  scoring each query/memory pair jointly) refines the top of the list.
- **Measured against baselines — honestly, and against the field default.** A
  frozen, labelled benchmark (`bench/`) scores retrieval with Recall@k / MRR / nDCG
  on **real `text-embedding-v4`**. The `naive-vector` baseline is **not a strawman**:
  a single-vector cosine ANN search is the default retrieval mode of LangChain's
  `VectorStoreRetriever` and virtually every pgvector RAG demo, so beating it is
  beating **what the field ships by default** — and it points the same way the
  strongest stacks are already moving: **Mem0 (multi-signal) and Zep (hybrid/graph)
  have both moved _beyond_ pure dense** toward dense + lexical **fusion** (we did
  *not* run any product head-to-head; the dense-baseline attribution is to
  LangChain's default retriever + stock pgvector demos, and Mem0/Zep are cited only
  as evidence of where the field is heading). Hybrid
  is the **robust** retriever (never recalls worse than dense: Recall@3 90.0% →
  93.3%; far beats lexical-only). Hybrid *alone* doesn't beat a strong dense embedder
  on top-rank — so we added the cross-encoder re-ranker, which **does**:
  `reranked-hybrid` lifts **MRR 0.883 → 0.911**,
  **nDCG@5 0.903 → 0.938**, **Recall@3 90.0% → 96.7%** over dense. Reproducible
  offline from committed fixtures (no key, no spend), **gated in CI**, and shipped
  with a **sensitivity control** (a meaning-shuffled retriever that must score near
  chance — proof the benchmark discriminates). Full method + honest caveats:
  **[BENCHMARK.md](./BENCHMARK.md)**.
- **Consolidation + forgetting.** The agent doesn't just append. `consolidate()`
  collapses near-duplicate memories (re-ingested facts) into one canonical memory;
  `forget()` drops superseded and stale low-importance memories while protecting
  high-importance insights. So recall stays sharp as the memory grows across
  sessions.

```
recall(question):
  q  = text-embedding-v4(question)
  D  = dense ANN over pgvector      (ORDER BY embedding <=> q)   ── meaning
  L  = lexical full-text / BM25     (ts_rank over content)       ── exact tokens
  pool = RRF(D, L)                  rank-fusion, superseded hidden
  hits = rerank(qwen-plus, q, pool) cross-encoder top-rank refine (optional)
  answer = qwen-plus(question, hits)   grounded, citing [n]

consistency(scope):                 ── the agent audits its OWN memory
  M = active memories in scope
  flag contradictions (same record, same attribute, different value / session)
  flag absences       (a memory references a record no memory stores)
```

## Required stack (all three, confirmed against the hackathon rules)

| Requirement | This entry |
|---|---|
| **Qwen models** | `text-embedding-v4` (embeddings, 1024-dim default) + `qwen-plus` (RAG narration). |
| **Qwen Cloud / DashScope** | Called via the OpenAI-compatible endpoint `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` with the standard `openai` Node SDK. Key = `DASHSCOPE_API_KEY`. |
| **Alibaba Cloud deployment** | The HTTP backend (`src/server.ts`) ships as a container (`Dockerfile`) deployed to **Function Compute** (custom container, HTTP trigger) — see [`deploy/`](./deploy). Memory store = **AnalyticDB / ApsaraDB RDS for PostgreSQL (pgvector)**. |

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Alibaba Cloud                                                              │
│                                                                             │
│  ┌──────────────────────────────┐        ┌──────────────────────────────┐  │
│  │ Function Compute             │        │ Model Studio / DashScope      │  │
│  │ (custom container, HTTP)     │        │ (Qwen Cloud)                  │  │
│  │  src/server.ts (Fastify)     │        │                               │  │
│  │   GET  /health               │ embed  │  text-embedding-v4 (1024-d)   │  │
│  │   POST /ingest ─┐            │───────▶│  qwen-plus (RAG narrator)     │  │
│  │   POST /recall ─┤            │◀───────│                               │  │
│  └─────────────────┼────────────┘  chat  └──────────────────────────────┘  │
│                    │                                                        │
│         MemoryAgent │ (embedder · store · narrator — all injectable)        │
│   ingestEvent() → remember()      recallAnswer() → recall() → narrate()     │
│                    │ SQL (pg-wire)                                          │
│                    ▼                                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ AnalyticDB / ApsaraDB RDS for PostgreSQL  (pgvector) — THE MEMORY      │ │
│  │  agent_memory(embedding vector(1024)) + HNSW cosine index             │ │
│  │  recall = ORDER BY embedding <=> $query  (semantic, cross-session)     │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘

Offline / CI: no DASHSCOPE_API_KEY → FakeEmbedder + FakeNarrator (deterministic);
pgvector runs as a docker service. Same code path, zero credentials.
```

### Write path (`remember`)
An agent states a fact in natural language (`"Completeness check for Helios Retail 2026-02: a €3,200 bank payment to Pallas Freight has no matching purchase invoice (high severity)…"`, or `"P&L for ByteCraft Software 2026-05: revenue €210,000, operating profit €41,200"`) → Qwen `text-embedding-v4` embeds it → the text, structured metadata, and the 1024-dim vector are stored in `agent_memory`.

### Read path (`recall` → `narrate`)
A question is embedded and run as an ANN search over the HNSW cosine index (`ORDER BY embedding <=> $query`). The top-k memories are handed to the **narrator** (`qwen-plus`), which writes a grounded answer that **cites the exact memories** it used — RAG over the agent's own persistent memory.

## The memory store — decision & tradeoff

**Chosen: pgvector on Alibaba Cloud PostgreSQL** (AnalyticDB for PostgreSQL, or ApsaraDB RDS for PostgreSQL with the `pgvector` extension).

- **Why:** it is a genuine Alibaba-native data service *and* pg-wire compatible, so the same `pg` driver + SQL runs unchanged across local docker, CI, and production. It let us reuse Archon's proven vector-memory design and stand up a real vector index in CI with **zero Alibaba credentials** (stock `pgvector/pgvector` docker). Best Alibaba-narrative × 8-day-deadline tradeoff.
- **Consciously deferred alternative:** Alibaba's fully-managed **DashVector** (or **Tair** vector) is an arguably *stronger pure-Alibaba* story, but it is a new non-pg API needing its own offline test double — the wrong trade at this deadline. The `MemoryStore` interface (`src/memory/store.ts`) is the seam a `DashVectorStore` would slot into next, with no change to the agent.

## Repository layout

```
repos/qwen-memoryagent/
├── src/
│   ├── qwen/client.ts          # OpenAI-compatible Qwen/DashScope client + injectable seams
│   ├── memory/
│   │   ├── embeddings.ts        # QwenEmbedder (text-embedding-v4) + offline FakeEmbedder
│   │   ├── retrieval.ts         # BM25 + cosine + RRF + MMR + hybrid + rerank retrievers (pure)
│   │   ├── rerank.ts            # cross-encoder re-rank: LlmReranker (qwen-plus) + offline FakeReranker
│   │   ├── consistency.ts       # SELF-AUDIT: cross-session contradiction + dangling-ref DETECT + RESOLVE (pure)
│   │   ├── consolidation.ts     # consolidate (dedup) + forget planners (pure)
│   │   ├── store.ts             # MemoryStore: PgVectorStore + InMemoryStore (hybrid + lifecycle + audit)
│   │   └── memory.ts            # remember() / recall() — embed ↔ store orchestration
│   ├── agents/
│   │   ├── narrator.ts          # QwenNarrator (qwen-plus RAG) + offline FakeNarrator
│   │   └── memory-agent.ts      # MemoryAgent: ingestEvent · recallAnswer · auditConsistency · consolidate · forget
│   ├── db/{client.ts,schema.sql}  # pg pool + pgvector schema (vector(1024) + HNSW + FTS + lifecycle)
│   ├── types.ts                 # PayrollEvent domain types
│   └── server.ts                # Fastify HTTP backend (the Alibaba Cloud deploy target)
├── bench/                        # frozen retrieval + consistency datasets, metrics, runners, committed fixtures (embeddings + re-rank scores)
├── scripts/{apply-schema.ts,demo-memory.ts}
├── tests/{unit,integration,e2e}/  # the testing pyramid
├── deploy/{s.yaml,deploy-fc.sh}   # Alibaba Function Compute (custom container)
├── Dockerfile · docker-compose.yml
├── BENCHMARK.md                   # retrieval benchmark: method, numbers, honest caveats
└── .github/workflows/{ci.yml,codeql.yml}  # secret-scan → dep-audit → build/test → benchmark → SAST
```

## Quickstart

Requires Node ≥ 20 and Docker (for local pgvector).

```bash
cd repos/qwen-memoryagent
cp .env.example .env            # fill DASHSCOPE_API_KEY for real Qwen (optional for the demo)
npm install

# 1. Start local pgvector + create the schema
docker compose up -d db
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
npm run db:schema

# 2. Run the end-to-end agent-memory demo (write fused events, recall by meaning)
npm run memory:demo

# 3. Run the HTTP backend
npm start                       # /health · /ingest · /recall · /consistency · /consolidate · /forget

# 4. Reproduce the benchmarks (replay committed fixtures — no key, no spend)
npm run bench                   # retrieval: Recall@k / MRR / nDCG (incl. re-rank + shuffled control)
npm run bench:consistency       # self-audit: detection rate + false positives on the control set

# Tests
npm run test:unit               # no infra, no key (logic, retrieval, metrics, consolidation)
npm run test:integration        # real pgvector (needs DATABASE_URL)
npm run test:e2e                # cross-session persistence (needs DATABASE_URL)
```

### HTTP API

| Method + path | Purpose |
|---|---|
| `GET /health` | Liveness; reports the live embedder/narrator model ids + dim. |
| `GET /memory/count` | How many memories the agent holds. |
| `POST /ingest` | `{ event }` → write memories for a fused financial event. |
| `POST /recall` | `{ question, company?, kind?, limit?, hybrid? }` → grounded, cited answer (hybrid on by default) + a best-effort self-audit over the recalled memories. |
| `POST /consistency` | `{ company?, period?, kind? }` → **self-audit**: cross-session contradictions (each with a `resolution` recommending which value to trust) + dangling references across stored memories (read-only, no schema change). |
| `POST /consolidate` | `{ company?, threshold? }` → collapse near-duplicate memories. |
| `POST /forget` | `{ company?, deleteSuperseded?, olderThanDays?, maxImportance? }` → prune memories. |

Without a `DASHSCOPE_API_KEY` the demo + backend run with deterministic offline `FakeEmbedder` + `FakeNarrator`, so the full pgvector write + vector-recall path still executes. Set the key to switch to real Qwen — same interface, same 1024 dimensions.

## Deploy to Alibaba Cloud (Function Compute)

The backend is a custom-container HTTP function. See [`deploy/deploy-fc.sh`](./deploy/deploy-fc.sh) and [`deploy/s.yaml`](./deploy/s.yaml).

```bash
# Prereqs: Alibaba Cloud account + ACR namespace (same region), Serverless Devs (`s`)
REGION=ap-southeast-1 ACR_NAMESPACE=<your-ns> \
  ACR_REGISTRY=registry.ap-southeast-1.aliyuncs.com \
  bash deploy/deploy-fc.sh
# → builds linux/amd64 image, pushes to ACR, deploys the FC function, prints the HTTP URL
curl <trigger-url>/health
```

Set `DATABASE_URL` (Alibaba PostgreSQL), `DASHSCOPE_API_KEY`, and `DASHSCOPE_BASE_URL` as function environment variables at deploy time — never commit them.

## Testing & CI

Full testing pyramid, all green in GitHub Actions (`.github/workflows/ci.yml`), fully offline (no Qwen/Alibaba credentials — the Fakes auto-engage):

| Tier | File(s) | What it proves |
|---|---|---|
| **Unit** | `tests/unit/*` | Embedder + narrator (Qwen canned + Fake), memory logic, **retrieval primitives** (BM25, RRF, MMR, hybrid, **re-rank**), **IR metrics**, **consolidation + forgetting**, **self-audit consistency** (contradiction + absence detection, precision on a control set) — all over `InMemoryStore`, no infra. |
| **Integration** | `tests/integration/pgvector-store.test.ts` | Real pgvector SQL: `::vector` insert, `<=>` cosine recall, filters, count, **hybrid dense+FTS fusion**, **consolidate → supersede → forget**. |
| **E2E** | `tests/e2e/cross-session.test.ts` | **Cross-session persistence** — session A writes + tears down, session B recalls. |
| **Benchmark gates** | `bench/*` | **Retrieval regression gate** (hybrid ≥ dense) + **discrimination gate** (shuffled control near chance) + **self-audit gate** (`bench:consistency`: 100% detection, 0 false positives) + **resolution gate** (`bench:resolution`: structural invariants + winner-accuracy on the labelled policy). Re-rank delta vs dense reported (not gated). All replay committed fixtures — no key, no spend. |

CI stages:
1. **secret-scan** — gitleaks (pinned v8.18.4, redacted). Fails fast on any committed secret.
2. **dep-audit** — `npm audit` (fails on high/critical).
3. **build-test** — typecheck → schema apply (stands up real pgvector) → unit → integration → e2e → offline demo smoke.
4. **benchmark** — `npm run bench -- --gate` (retrieval regression + discrimination), `npm run bench:consistency -- --gate` (self-audit detection/precision) and `npm run bench:resolution -- --gate` (contradiction-resolution invariants + policy-conformance), all over committed fixtures (no key, no spend).
5. **CodeQL** (`.github/workflows/codeql.yml`) — SAST for the TypeScript source.

Every stage runs **fully offline** — no DashScope / Alibaba credentials — because the Qwen embedder/narrator auto-fall back to deterministic Fakes and the benchmark replays cached vectors.

## How this maps to the judging rubric

| Criterion (weight) | Where to look |
|---|---|
| **Technical Depth & Engineering (30%)** | Hybrid dense+lexical retrieval with RRF, consolidation/forgetting lifecycle, injectable Qwen/Fake seams, full test pyramid + benchmark gate + CodeQL, real pgvector on Alibaba. A *measured* memory system, not a wrapper. |
| **Innovation & AI Creativity (30%)** | **Self-auditing memory that detects _and_ resolves**: the agent flags when two of its own cross-session writes *contradict* (100% detection / 0 false positives, measured) **and recommends which side to trust** (importance → source-authority → recency; a recommender that never mutates memory; 4/4 correct on a labelled set) — memory you can trust, not just retrieve. Plus memory that fuses meaning + exact tokens, is refined by a cross-encoder re-ranker (a *measured* top-rank win over the field-default dense baseline: MRR 0.883 → 0.911), prunes its own duplicates, and proves quality with a reproducible, sensitivity-controlled benchmark. |
| **Problem Value & Impact (25%)** | A real, recurring SMB pain: consolidated financial facts and cross-check findings that must be remembered across sessions — from an unbilled sales order to a payment with no matching invoice to the true cost of employing a team. |
| **Presentation & Documentation (15%)** | This README + architecture diagram + [BENCHMARK.md](./BENCHMARK.md) (method + honest caveats) + the ~3-min demo + live Alibaba URL. |

## Provenance / reuse

Archon is our own product; this entry reuses our public Archon builds freely and ports the memory layer to Qwen + Alibaba Cloud. The `memory/` layer, `MemoryStore` abstraction, `QwenEmbedder`/`QwenNarrator`, and the cross-session e2e are built for this hackathon.

## License

MIT — see [LICENSE](./LICENSE).
