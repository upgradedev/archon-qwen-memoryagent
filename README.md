# Archon MemoryAgent — Qwen × Alibaba Cloud

**Entry for the [Global AI Hackathon Series with Qwen Cloud](https://qwencloud-hackathon.devpost.com/) — `MemoryAgent` track.**

[![CI](https://github.com/upgradedev/archon-qwen-memoryagent/actions/workflows/ci.yml/badge.svg)](https://github.com/upgradedev/archon-qwen-memoryagent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Alibaba%20Cloud-ff6a00?logo=alibabacloud&logoColor=white)](https://memory.43.106.13.19.sslip.io)
[![Demo Video](https://img.shields.io/badge/Demo%20Video-CI%20build-ff0000?logo=youtube)](https://github.com/upgradedev/archon-qwen-memoryagent/actions/workflows/demo-video.yml)
[![Tests](https://img.shields.io/badge/Tests-140%20node%3Atest%20%2B%20Playwright-brightgreen)](tests)
[![Project Story](https://img.shields.io/badge/Project%20Story-Devpost-003e54)](demo/PROJECT_STORY.md)
<!-- TODO after YouTube upload: point the Demo Video badge at the YouTube URL -->


> **Track: MemoryAgent** — an agent with *persistent, queryable memory that retains and recalls information across sessions*.

> **Live:** [`https://memory.43.106.13.19.sslip.io`](https://memory.43.106.13.19.sslip.io) — open the URL for the memory explorer (recall + self-audit + a P&L / pipeline context panel), `/docs` for the API, `/health` for liveness.

## What it is

Archon MemoryAgent gives a small business's financial-intelligence pipeline a **memory**.

Every fused financial event, validation finding, and narrated insight is embedded with **Qwen `text-embedding-v4`** (Alibaba Cloud Model Studio / DashScope) and stored in a **pgvector** memory layer.

On any later run — a different session, a different process, a fresh container — the agent **recalls the relevant prior facts by meaning** and grounds a **Qwen `qwen-plus`** answer in them. It reasons with continuity instead of starting cold on every request.

## What Archon is

Archon is a **unified financial-intelligence platform**.

It ingests *all* of a business's financial documents and data into one environment — sales and purchase invoices, orders, receipts, payments, bank transfers and statements, expenses, and workforce costs. From that it produces a consolidated, period-over-period view: **P&L, EBITDA, cash, sales targets, and per-period metrics**.

It also **cross-checks the whole picture for missing or inconsistent information**. For example: *a bank payment appears with no matching invoice — did the vendor never send it, did the accountant never register it, or is the payment wrong?*

This MemoryAgent gives that pipeline a memory. It remembers each consolidated figure and each cross-check finding across sessions, and can answer questions about them on any later run.

## Platform context — where the memories come from

The MemoryAgent is the headline: it **recalls** grounded, cited answers and **self-audits** its own memory for cross-session contradictions. But an agent's memory is only as real as what feeds it — so this entry ships the **productized upstream** that produces those memories: a document-ingestion pipeline (`src/pipeline/`), ported from the Archon extraction + analysis agents.

```
raw documents ──▶ Extractor (qwen-vl-max vision / qwen-plus text)   normalize each doc
              ──▶ Classifier      rule-based doc-type refinement (no LLM)
              ──▶ EventLinker     fuse the payroll triplet into one accurate event
              ──▶ Validator       R1–R4 cross-document consistency checks
              ──▶ P&L math        employer cost · cash-out · per-employee analytics
              ──▶ MemoryAgent.ingestEvent()   WRITE the fused event + findings to pgvector
```

A single payroll event is told by three documents that each carry a *different part of the truth*: the **bank confirmation** (net cash that left the account), the **payroll register** (the full employer cost, including employer social-security), and the **payslips** (per-employee detail). The bank confirmation alone **understates** the true cost of employing the team. The pipeline fuses all three, computes the accurate P&L, and hands the result to the **unchanged** MemoryAgent to remember.

The pipeline is **supporting cast** — it exists to make the memory demonstrably fed by a real productization path. The agent core (recall, self-audit, consolidation, forgetting) is untouched; `POST /ingest/documents` runs the pipeline and writes through the same `ingestEvent()` the agent already exposed, and `GET /pnl` reads a P&L back **over the memories the agent holds**. Everything stays offline-testable: `qwen-vl-max`/`qwen-plus` are auto-selected only when `DASHSCOPE_API_KEY` is set, and a deterministic Fake extractor drives the whole path in CI (same seam as `FakeEmbedder`/`FakeNarrator`).

The financial picture it remembers is broad: one memory might be a sales invoice, the next a cash position, the next a completeness anomaly. Among them is the **true cost of employing a team** — a bank salary transfer understates it, because it never shows employer social-security contributions — but that is just *one* business aspect among many.

## Why this is a MemoryAgent

| Track requirement | How this entry meets it |
|---|---|
| **Persistent memory** | Memories are embedded and written to pgvector on Alibaba Cloud PostgreSQL — durable, not in-process. |
| **Queryable memory** | Recall is semantic ANN search (`ORDER BY embedding <=> $q`) over an HNSW cosine index, with `kind`/`company` pre-filters. |
| **Across sessions** | The headline e2e test (`tests/e2e/cross-session.test.ts`) proves it. Session A writes and tears down completely; a fresh session B — no shared in-process state — recalls those memories and answers from them. The only thing shared is the database. |
| **Increasingly accurate over time** | Each ingested event adds recallable facts. Later questions retrieve the accumulated memory, not just the current request's context. |

## What makes the memory strong (not just present)

A MemoryAgent lives or dies on **recall quality** and **memory hygiene**. This entry treats both as first-class, engineered, and *measured*.

It also adds a capability most memory demos skip: the agent **audits its own memory**.

### ⭐ Self-auditing memory (the headline)

A cross-session agent accumulates facts from many separate write events. Nothing stops two of them from **contradicting**.

Say session A records a payroll event's employer cost at **€18,000**, and a later session B records **€19,000** for the same event. Plain recall just returns whichever ranked higher and stays silent.

`POST /consistency` (`src/memory/consistency.ts`) does not. It scans the agent's own memories, groups them by the record they describe, and flags two things:

- **Cross-session contradictions** — same record and attribute, different value across write events.
- **Dangling references** — a memory points at a record that no memory stores.

It is a **pure, domain-neutral** engine, not a finance rulebook. And it is *measured*: on a labelled dataset it detects **5/5 injected problems with 0 false positives** on a consistent control set (100% precision).

This is memory you can *trust*, because it tells you when it disagrees with itself.

**It doesn't just detect — it recommends.** For every contradiction it recommends which side to trust:

```
resolution: { recommendedMemoryId, recommendedValue, rule, confidence, rationale }
```

The recommendation follows a fixed, domain-neutral priority ladder — **importance → source-authority → recency (later write wins)** — over signals already on the memories.

It is a *recommender, not ground truth*. It **never mutates memory**, and it is measured too: **4/4 correct** on a labelled resolution set (`npm run bench:resolution`).

**What's genuinely new here** (positioned against the literature, honestly):

- Classic RAG and the pgvector default just **rank and return**.
- **Mem0** resolves conflicts by letting an LLM *silently mutate* memory at write time (ADD / UPDATE / DELETE).
- **Zep / Graphiti** resolves by *mutating* its temporal graph (invalidating the stale edge by time).
- **Ours never mutates.** It is a read-only, deterministic, domain-neutral pure function that surfaces the contradiction and hands back a *recommendation* — `rule + confidence + rationale` over a fixed importance → source-authority → recency ladder — for the agent or a human to accept or override.

The claim is not "we detect and they can't" (Zep does). It is **"we recommend without mutating, explainably and portably"** — a memory layer that stays honest about what it holds.

Full method + honesty caveats: **[BENCHMARK.md](./BENCHMARK.md)**.

### Hybrid retrieval (dense + lexical, RRF) + a cross-encoder re-ranker

Agent memories are full of exact tokens that dense embeddings blur: document numbers (`INV-2043`, `PINV-771`), euro figures, company names, period codes.

Recall handles both meaning and exact tokens:

1. Fuse `text-embedding-v4` cosine search with BM25 / full-text lexical search using **Reciprocal Rank Fusion (RRF)**.
2. Refine the top of the list with a **cross-encoder re-rank stage** (`qwen-plus` scoring each query/memory pair jointly).

### Measured against baselines — honestly, and against the field default

A frozen, labelled benchmark (`bench/`) scores retrieval with Recall@k / MRR / nDCG on **real `text-embedding-v4`**.

The `naive-vector` baseline is **not a strawman**. A single-vector cosine ANN search is the default retrieval mode of LangChain's `VectorStoreRetriever` and virtually every pgvector RAG demo. Beating it is beating **what the field ships by default**.

Findings, stated honestly:

- **Hybrid is the *robust* retriever.** It never recalls worse than dense (Recall@3 90.0% → 93.3%) and far beats lexical-only.
- **Hybrid alone doesn't beat a strong dense embedder on top-rank** — so we added the cross-encoder re-ranker, which does.
- **`reranked-hybrid` wins on top-rank** over dense: MRR **0.883 → 0.911**, nDCG@5 **0.903 → 0.938**, Recall@3 **90.0% → 96.7%**.

Reproducible offline from committed fixtures (no key, no spend), **gated in CI**, and shipped with a **sensitivity control** — a meaning-shuffled retriever that must score near chance, proving the benchmark actually discriminates.

Full method + honest caveats: **[BENCHMARK.md](./BENCHMARK.md)**.

### A real head-to-head vs Mem0 (run), with Zep cited

We installed **Mem0 (`mem0ai==2.0.11`)** and drove it with the **same Qwen models and the same cross-session conflict pairs** our own audit is measured on (`bench/external/`, evidence committed as `mem0-evidence.json`).

Two honest findings:

- **Retrieval is at parity.** Mem0 put the gold figure in its top-5 on 5/5. We claim *parity, not a retrieval win*.
- **Mem0 exposes no contradiction/resolution API** (empirically, an empty method list). Fed two disagreeing writes, it stores both and returns both ranked by similarity — no conflict flag, no resolution recommendation.

**Zep / Graphiti _does_ handle contradictions** — its temporal graph invalidates the stale edge by time. We say so plainly. The difference: Zep *mutates* graph state and resolves by time, whereas ours is a **read-only, deterministic, portable audit that recommends without ever mutating**.

Full capability matrix + caveats: **[BENCHMARK.md](./BENCHMARK.md#head-to-head-vs-mem0-and-zep)**.

### A measured accuracy number on our own pipeline

On 11 labelled number-bearing questions, we replay one committed `qwen-plus` pass over the shipped hybrid recall and grade **by number presence, not prose** (`npm run bench:accuracy`, gated in CI):

- **Gold-memory recall@5: 100%**
- **Answer correctness: 100%**
- **Answer grounding / faithfulness: 90.9%** — every euro figure in the answer traces to a recalled memory.

The one grounding miss is a *derived* figure (€2,800 = €41,200 − €38,400) that the metric correctly flags. We report 90.9%, not a suspicious 100%.

### Consolidation + forgetting

The agent doesn't just append.

- `consolidate()` collapses near-duplicate memories (re-ingested facts) into one canonical memory.
- `forget()` drops superseded and stale low-importance memories while protecting high-importance insights.

So recall stays sharp as the memory grows across sessions.

### Recall + self-audit, in pseudocode

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
| **Alibaba Cloud deployment** | The HTTP backend (`src/server.ts`) ships as a container (`Dockerfile`) and runs **live on Alibaba Cloud ECS** (`ecs.e-c1m2.large`, ap-southeast-1) via docker-compose — the backend plus a self-hosted **pgvector container** as the memory store. A **Function Compute + managed ApsaraDB RDS** path is also provided (`deploy/s.yaml`, `deploy/deploy-fc.sh`) as a serverless alternative. See [`deploy/`](./deploy). |

## Architecture

The **MemoryAgent is the centre** (recall + self-audit). The document-ingestion **pipeline is the supporting upstream** that *produces* the memories the agent remembers.

```mermaid
flowchart TB
    Agent["AI agent / HTTP caller"]
    Docs["Raw financial documents<br/>(scanned images · pdf · text)"]
    MCPClient["MCP client — Claude Desktop / IDE / agent"]

    subgraph ECS["Alibaba Cloud · ECS ap-southeast-1 · docker-compose"]
        direction TB
        subgraph API["backend container — Fastify · src/server.ts"]
            direction LR
            H["GET /health · /docs · /pnl"]
            I["POST /ingest · /ingest/documents"]
            R["POST /recall"]
            C["POST /consistency"]
        end
        subgraph PIPE["Ingestion pipeline — src/pipeline (supporting cast)"]
            direction LR
            EX["Extractor<br/>(qwen-vl-max / qwen-plus)"]
            CL["Classifier"]
            EL["EventLinker<br/>fuse triplet"]
            VA["Validator R1–R4"]
            PN["P&amp;L math"]
            EX --> CL --> EL --> VA --> PN
        end
        subgraph MCPSURF["MCP surface — src/mcp/* + src/skills/*"]
            direction LR
            MT["4 MCP tools<br/>recall · ingest · audit · count"]
            SK["SkillDispatcher (shared)<br/>+ qwen-plus function-calling skills"]
        end
        MA["★ MemoryAgent — embedder · store · narrator (all injectable)<br/>ingestEvent → remember() · recallAnswer → recall() → narrate()<br/>+ self-audit (contradictions · dangling refs)"]
        DB["pgvector container · PostgreSQL — THE MEMORY<br/>agent_memory(embedding vector(1024)) + HNSW cosine index<br/>recall = ORDER BY embedding &lt;=&gt; $query"]
    end

    subgraph QWEN["Model Studio / DashScope — Qwen Cloud"]
        direction TB
        VL["qwen-vl-max (vision extraction)"]
        EMB["text-embedding-v4 (1024-d)"]
        LLM["qwen-plus (RAG narrator · function-calling)"]
    end

    RDS["Managed ApsaraDB RDS / AnalyticDB for PostgreSQL<br/>same pg-wire code · DATABASE_URL swap"]

    Agent -->|HTTP / JSON| API
    Docs -->|POST /ingest/documents| API
    API --> PIPE
    API --> MA
    PIPE -->|fused events + findings| MA
    EX -->|vision / text| VL
    MCPClient -->|MCP · stdio / Streamable HTTP| MT
    MT --> SK
    SK --> MA
    MA -->|embed| EMB
    MA -->|chat| LLM
    MA -->|SQL · pg-wire| DB
    DB -. drop-in swap .-> RDS
```

Both surfaces — the HTTP routes and the MCP tools / custom skills — go through the **same injectable `MemoryAgent`** via the shared `SkillDispatcher`. There is one implementation of recall / ingest / audit / count, exposed three ways (REST, MCP, and Qwen function-calling), so the protocol layer never duplicates the memory logic.

**Live deployment** = ECS + docker-compose (backend + pgvector container). Because the store is pg-wire, the identical code runs unchanged on a managed ApsaraDB RDS / AnalyticDB for PostgreSQL instance (the Function Compute alternative in `deploy/`).

**Offline / CI:** no `DASHSCOPE_API_KEY` → `FakeEmbedder` + `FakeNarrator` (deterministic); pgvector runs as a docker service. Same code path, zero credentials.

### Write path (`remember`)

An agent states a fact in natural language. For example:

> *"Completeness check for Helios Retail 2026-02: a €3,200 bank payment to Pallas Freight has no matching purchase invoice (high severity)…"*
>
> *"P&L for ByteCraft Software 2026-05: revenue €210,000, operating profit €41,200"*

Qwen `text-embedding-v4` embeds it. The text, structured metadata, and the 1024-dim vector are then stored in `agent_memory`.

### Read path (`recall` → `narrate`)

A question is embedded and run as an ANN search over the HNSW cosine index (`ORDER BY embedding <=> $query`).

The top-k memories are handed to the **narrator** (`qwen-plus`), which writes a grounded answer that **cites the exact memories** it used. It is RAG over the agent's own persistent memory.

## The memory store — decision & tradeoff

**Chosen: pgvector on PostgreSQL, running on Alibaba Cloud.**

The live deployment self-hosts the `pgvector/pgvector` container on an ECS instance, alongside the backend, via docker-compose. Because it is pg-wire, the identical `pg` driver + SQL also runs against a managed **ApsaraDB RDS / AnalyticDB for PostgreSQL** instance with the `pgvector` extension (the Function Compute alternative in [`deploy/`](./deploy)).

**Why the ECS + pgvector-container topology for the live box:**

- It delivers a single, always-reachable public URL on Alibaba Cloud fastest and most reliably — no FC↔RDS VPC wiring or ACR console steps in the critical path.
- Because the store is pg-wire, the same `pg` driver + SQL runs unchanged across local docker, CI, and production.
- It stands up a real vector index in CI with **zero Alibaba credentials** (stock `pgvector/pgvector` docker).
- It is the best Alibaba-narrative × short-deadline tradeoff. The managed-RDS + Function Compute path is a drop-in `DATABASE_URL` swap.

**Consciously deferred alternative:** Alibaba's fully-managed **DashVector** (or **Tair** vector) is an arguably *stronger pure-Alibaba* story. But it is a new non-pg API needing its own offline test double — the wrong trade at this deadline. The `MemoryStore` interface (`src/memory/store.ts`) is the seam a `DashVectorStore` would slot into next, with no change to the agent.

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
├── bench/                        # frozen retrieval + accuracy + consistency datasets, metrics, runners, committed fixtures (embeddings + re-rank + answers)
│   └── external/                 # real head-to-head vs Mem0 (mem0ai) — export + harness + committed evidence
├── load/                         # k6 load/performance test (manual workflow; reads-only by default)
├── scripts/{apply-schema.ts,demo-memory.ts}
├── tests/{unit,integration,e2e}/  # the testing pyramid
├── deploy/{redeploy.sh,DEPLOY_STATE.md}  # LIVE path: ECS + docker-compose (backend + pgvector container)
│   └── {s.yaml,deploy-fc.sh}       # alternative: Alibaba Function Compute + managed RDS
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

Once the backend is running, open **`http://localhost:9000/docs`** for the interactive API explorer (Swagger UI), or fetch the raw spec at `/openapi.json`.

### HTTP API

| Method + path | Purpose |
|---|---|
| `GET /docs` | Interactive API explorer (Swagger UI). |
| `GET /openapi.json` | Machine-readable OpenAPI 3 spec. |
| `GET /health` | Liveness; reports the live embedder/narrator model ids + dim. |
| `GET /memory/count` | How many memories the agent holds. |
| `POST /ingest` | `{ event }` → write memories for a fused financial event. |
| `POST /ingest/documents` | `{ documents[] }` → run the ingestion **pipeline** (Extractor → Classifier → EventLinker → Validator → P&L) over raw documents and write the fused events + findings into memory. Returns the events, per-event P&L, validation, and the ids of every memory written. |
| `GET /pnl` | `?company=&period=` → payroll-cost **P&L** aggregated over the pipeline-fed memories (employer cost, cash-out, off-bank cost gap, by company). |
| `POST /recall` | `{ question, company?, kind?, limit?, hybrid? }` → grounded, cited answer (hybrid on by default) + a best-effort self-audit over the recalled memories. |
| `POST /consistency` | `{ company?, period?, kind? }` → **self-audit**: cross-session contradictions (each with a `resolution` recommending which value to trust) + dangling references across stored memories (read-only, no schema change). |
| `POST /consolidate` | `{ company?, threshold? }` → collapse near-duplicate memories. |
| `POST /forget` | `{ company?, deleteSuperseded?, olderThanDays?, maxImportance? }` → prune memories. |

Without a `DASHSCOPE_API_KEY`, the demo and backend run with deterministic offline `FakeEmbedder` + `FakeNarrator`. The full pgvector write + vector-recall path still executes. Set the key to switch to real Qwen — same interface, same 1024 dimensions.

**Open demo + rate limit.** The live deployment is intentionally **open (no login)** so judges can test it end to end. Because `POST /ingest/documents` is the only path that spends Qwen vision-model calls, document upload is metered in two UTC-daily tiers to protect the shared Qwen API budget: a **per-IP cap** (`INGEST_DAILY_LIMIT`, default **100** — generous headroom so a judge never hits 429 on their first ingest) under a **hard global backstop** (`INGEST_DAILY_LIMIT_GLOBAL`, default **500** — bounds total spend across all clients, which a per-IP cap alone cannot). Per-IP bucketing keys on the real client address via the fronting proxy's `X-Forwarded-For` (Fastify `trustProxy`); with no proxy it degrades safely to a single shared counter. Recall, self-audit, and the P&L view stay open and unmetered.

## MCP integration & custom skills

Beyond the REST API, the same memory is exposed two more ways for *sophisticated QwenCloud API use* (Technical Depth & Engineering): a **Model Context Protocol (MCP) server** and a **Qwen function-calling custom-skills layer**. Both wrap the identical injectable `MemoryAgent` through one shared `SkillDispatcher` ([`src/skills/dispatcher.ts`](./src/skills/dispatcher.ts)) — the exact code the HTTP routes run — so there is no duplicated memory logic. The schemas ([`src/skills/schemas.ts`](./src/skills/schemas.ts)) are the single source of truth reused verbatim as both MCP `inputSchema` and OpenAI function `parameters`.

### The four skills / MCP tools

| Skill / MCP tool | Args | What it does |
|---|---|---|
| `recall_memory` | `{ question, company?, kind?, limit? }` | Hybrid semantic recall → Qwen-narrated **grounded, cited answer** + a best-effort self-audit (same path as `POST /recall`). |
| `ingest_memory` | `{ content, kind, company?, period?, sourceRef?, metadata? }` | Embeds (`text-embedding-v4`) and writes a single fact into persistent memory. |
| `audit_memory` | `{ company?, period?, kind? }` | Read-only cross-session **self-audit**: contradictions (with a resolution recommendation) + dangling references. |
| `memory_count` | `{ company? }` | How many memories the agent holds. |

`kind` is a validated JSON-Schema `enum` (`document \| payroll_event \| validation \| insight`), so both an MCP client and qwen-plus get a sharp typed choice, not free text.

### 1. MCP server ([`src/mcp/server.ts`](./src/mcp/server.ts))

A real MCP server built on the official `@modelcontextprotocol/sdk`. **stdio** transport is the primary (the standard MCP client transport used by Claude Desktop); an optional **Streamable HTTP** transport is available for remote clients (`MCP_TRANSPORT=http`, default port `9100`, endpoint `/mcp`).

```bash
# Launch the MCP server on stdio (offline Fakes with no key; real Qwen + pgvector when configured)
npm run mcp
# or, from an MCP client config, launch it directly:
npx tsx src/mcp/server.ts
```

Connect an MCP client (e.g. Claude Desktop `claude_desktop_config.json`) over stdio:

```json
{
  "mcpServers": {
    "archon-memoryagent": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/path/to/archon-qwen-memoryagent",
      "env": {
        "DASHSCOPE_API_KEY": "sk-…",
        "DATABASE_URL": "postgresql://user:pass@host:5432/db"
      }
    }
  }
}
```

For a **remote** MCP client against the live Alibaba Cloud box, the operator redeploys the container with `MCP_TRANSPORT=http` (the live `43.106.13.19:9000` currently serves the Fastify HTTP API; the MCP HTTP transport comes up on the configured port after that redeploy) and the client points at the Streamable HTTP endpoint:

```json
{ "mcpServers": { "archon-memoryagent": { "url": "http://43.106.13.19:9100/mcp" } } }
```

### 2. Custom-skills layer for qwen-plus ([`src/skills/loop.ts`](./src/skills/loop.ts))

The same skills are handed to **`qwen-plus` as OpenAI-compatible function tools**, so the model itself decides which memory operation to call. `runSkillLoop()` runs the standard tool-calling cycle — model proposes a skill call → the `SkillDispatcher` executes it against memory → the result is fed back → the model continues until it produces a final grounded answer. This is the agentic counterpart to the REST API: instead of a caller choosing an endpoint, qwen-plus chooses a skill.

Both surfaces are covered by offline unit tests ([`tests/unit/mcp.test.ts`](./tests/unit/mcp.test.ts) exercises the server over the real MCP protocol via the SDK's in-memory transport + a `Client`; [`tests/unit/skills.test.ts`](./tests/unit/skills.test.ts) exercises the dispatcher and the function-calling loop with a canned client) — no network, no key, no DB.

## Deploy to Alibaba Cloud

### Live path — ECS + docker-compose (backend + pgvector container)

This is how the entry actually runs on Alibaba Cloud. A single ECS instance (`ecs.e-c1m2.large`, ap-southeast-1) runs docker-compose with the backend container plus a self-hosted `pgvector/pgvector` container as the memory store, behind one public URL.

[`deploy/redeploy.sh`](./deploy/redeploy.sh) is an idempotent, schema-first redeploy (health + ingest/recall smoke, optional `--truncate`). [`deploy/DEPLOY_STATE.md`](./deploy/DEPLOY_STATE.md) is the full runbook.

```bash
# On the ECS box (source synced via rsync — the box has no git checkout):
cd /root/memoryagent
bash deploy/redeploy.sh            # or: --truncate for a clean demo slate
curl http://<public-ip>:9000/health
```

Set `DATABASE_URL`, `DASHSCOPE_API_KEY`, and `DASHSCOPE_BASE_URL` via the compose env — never commit them. Without a `DASHSCOPE_API_KEY` the box runs the deterministic Fakes (the pgvector round-trip still executes).

### Alternative — Function Compute + managed RDS (serverless)

For a fully-serverless topology, the same container deploys to Alibaba Cloud Function Compute (custom-container HTTP function) with a managed **ApsaraDB RDS / AnalyticDB for PostgreSQL** memory store. See [`deploy/deploy-fc.sh`](./deploy/deploy-fc.sh) and [`deploy/s.yaml`](./deploy/s.yaml).

```bash
# Prereqs: Alibaba Cloud account + ACR namespace (same region), Serverless Devs (`s`)
REGION=ap-southeast-1 ACR_NAMESPACE=<your-ns> \
  ACR_REGISTRY=registry.ap-southeast-1.aliyuncs.com \
  bash deploy/deploy-fc.sh
# → builds linux/amd64 image, pushes to ACR, deploys the FC function, prints the HTTP URL
curl <trigger-url>/health
```

Because the store is pg-wire, switching between the two is a `DATABASE_URL` swap — no application change.

## Proof of Alibaba Cloud Deployment

This backend runs **live on Alibaba Cloud**. Two halves of proof:

**1. Recording** — a short terminal capture ([`demo/alibaba-proof.mp4`](./demo/alibaba-proof.mp4), ~35s, silent, 1080p) showing the ECS instance `Running` in `ap-southeast-1` and both apps answering `GET /health` with the real Qwen model ids over HTTPS:

```text
$ aliyun ecs DescribeInstances --RegionId ap-southeast-1 --InstanceIds "['i-t4ngalzjr5nwtuowbv7y']"
  InstanceId: i-t4ngalzjr5nwtuowbv7y   Region: ap-southeast-1 (ap-southeast-1c)   Status: Running
  PublicIP: 43.106.13.19   Type: ecs.e-c1m2.large   Image: ubuntu_22_04_x64_20G_alibase_20260615.vhd

$ curl https://memory.43.106.13.19.sslip.io/health
  {"status":"ok","embedder":"text-embedding-v4","narrator":"qwen-plus","embedDim":1024}
$ curl https://autopilot.43.106.13.19.sslip.io/health
  {"status":"ok","embedder":"text-embedding-v4","decider":"qwen-plus","store":"pgvector"}
```

**2. Code that uses Alibaba Cloud services & APIs** — direct links:

| Alibaba Cloud service | Code file | What it does |
|---|---|---|
| **ECS** (live deploy) | [`deploy/redeploy.sh`](./deploy/redeploy.sh) | Syncs source and (re)starts the docker-compose stack (backend + pgvector container) on the ECS instance behind one public HTTPS URL. |
| **Function Compute** (serverless alternative) | [`deploy/s.yaml`](./deploy/s.yaml) | Serverless Devs spec for the custom-container HTTP function + managed ApsaraDB RDS memory store. |
| **Model Studio / DashScope** (Qwen inference) | [`src/qwen/client.ts`](./src/qwen/client.ts) | OpenAI-compatible client to Alibaba Cloud Model Studio; calls `text-embedding-v4` (embeddings) and `qwen-plus` (narration). |

Full proof doc with every service mapping: [`demo/ALIBABA_PROOF.md`](./demo/ALIBABA_PROOF.md).

## Testing & CI

Full testing pyramid, all green in GitHub Actions (`.github/workflows/ci.yml`), fully offline. No Qwen/Alibaba credentials are needed — the Fakes auto-engage.

| Tier | File(s) | What it proves |
|---|---|---|
| **Unit** | `tests/unit/*` | Embedder + narrator (Qwen canned + Fake), memory logic, **retrieval primitives** (BM25, RRF, MMR, hybrid, **re-rank**), **IR metrics**, **consolidation + forgetting**, **self-audit consistency** (contradiction + absence detection, precision on a control set), and the **MCP server + custom-skills layer** (`mcp.test.ts` drives the server over the real MCP protocol via the SDK in-memory transport; `skills.test.ts` covers the dispatcher + qwen-plus function-calling loop) — all over `InMemoryStore`, no infra. |
| **Integration** | `tests/integration/pgvector-store.test.ts` | Real pgvector SQL: `::vector` insert, `<=>` cosine recall, filters, count, **hybrid dense+FTS fusion**, **consolidate → supersede → forget**. |
| **E2E** | `tests/e2e/cross-session.test.ts` | **Cross-session persistence** — session A writes + tears down, session B recalls. |
| **Benchmark gates** | `bench/*` | **Retrieval regression gate** (hybrid ≥ dense) + **discrimination gate** (shuffled control near chance) + **grounded-answer accuracy gate** (`bench:accuracy`: correctness 100%, grounding ≥ 90%) + **self-audit gate** (`bench:consistency`: 100% detection, 0 false positives) + **resolution gate** (`bench:resolution`: structural invariants + winner-accuracy on the labelled policy). Re-rank delta vs dense and the Mem0 head-to-head are reported (not gated). All replay committed fixtures — no key, no spend. |
| **Load / performance** | `load/recall-load.js` (k6) | Ramps concurrent `/recall` + `/health` against a target box and asserts p95 latency + error-rate SLOs. Runs on demand via the `load-test` workflow (manual only — it hits the live box), reads-only by default. |

CI stages:

1. **secret-scan** — gitleaks (pinned v8.18.4, redacted). Fails fast on any committed secret.
2. **dep-audit** — `npm audit` (fails on high/critical).
3. **build-test** — typecheck → schema apply (stands up real pgvector) → unit → integration → e2e → offline demo smoke.
4. **benchmark** — `npm run bench -- --gate` (retrieval regression + discrimination), `npm run bench:accuracy -- --gate` (grounded-answer correctness + faithfulness), `npm run bench:consistency -- --gate` (self-audit detection/precision), and `npm run bench:resolution -- --gate` (contradiction-resolution invariants + policy-conformance). All over committed fixtures — no key, no spend.
5. **CodeQL** (`.github/workflows/codeql.yml`) — SAST for the TypeScript source.

Every stage runs **fully offline**. There are no DashScope / Alibaba credentials in CI, because the Qwen embedder/narrator auto-fall back to deterministic Fakes and the benchmark replays cached vectors.

## How this maps to the judging rubric

| Criterion (weight) | Where to look |
|---|---|
| **Technical Depth & Engineering (30%)** | Sophisticated QwenCloud API use on **three surfaces over one shared core**: an **MCP server** (`@modelcontextprotocol/sdk`, stdio + Streamable HTTP, four tools) and a **qwen-plus custom-skills function-calling layer** (`src/skills/*`), both wrapping the same injectable `MemoryAgent` as the REST API — no duplicated logic. Plus hybrid dense+lexical retrieval with RRF + cross-encoder re-rank; consolidation/forgetting lifecycle; injectable Qwen/Fake seams; full test pyramid + **four benchmark gates** (retrieval regression + discrimination, grounded-answer accuracy, self-audit detection, resolution policy) + CodeQL; real pgvector on Alibaba. A *measured* memory system, not a wrapper — including a real **head-to-head vs Mem0** (`bench/external/`) and a **measured 100% correctness / 90.9% grounding** number on its own answers. |
| **Innovation & AI Creativity (30%)** | **Self-auditing memory that detects _and_ resolves without ever mutating.** The agent flags when two of its own cross-session writes contradict (100% detection / 0 false positives, measured) and recommends which side to trust (importance → source-authority → recency; a recommender that never mutates memory; 4/4 correct on a labelled set). Positioned honestly against the field: Mem0 resolves by silent LLM mutation, Zep by mutating its temporal graph — ours is the read-only, deterministic, portable recommender (measured head-to-head: Mem0 exposes no such API, retrieval at parity). Plus memory that fuses meaning + exact tokens, is refined by a cross-encoder re-ranker (a measured top-rank win over the field-default dense baseline: MRR 0.883 → 0.911), prunes its own duplicates, and proves quality with reproducible, sensitivity-controlled benchmarks. |
| **Problem Value & Impact (25%)** | A real, recurring SMB pain: consolidated financial facts and cross-check findings that must be remembered across sessions — from an unbilled sales order, to a payment with no matching invoice, to the true cost of employing a team. |
| **Presentation & Documentation (15%)** | This README + architecture diagram + [BENCHMARK.md](./BENCHMARK.md) (method + honest caveats) + the interactive `/docs` API explorer + the ~3-min demo + the live Alibaba URL. |

## Provenance / reuse

Archon is our own product. This entry reuses our public Archon builds freely and ports the memory layer to Qwen + Alibaba Cloud. The `memory/` layer, the `MemoryStore` abstraction, `QwenEmbedder` / `QwenNarrator`, and the cross-session e2e are built for this hackathon.

## License

MIT — see [LICENSE](./LICENSE).
