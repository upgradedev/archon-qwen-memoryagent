# Archon MemoryAgent — Qwen × Alibaba Cloud

**Entry for the [Global AI Hackathon Series with Qwen Cloud](https://qwencloud-hackathon.devpost.com/) — `MemoryAgent` track.**

[![CI](https://github.com/upgradedev/archon-qwen-memoryagent/actions/workflows/ci.yml/badge.svg)](https://github.com/upgradedev/archon-qwen-memoryagent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Alibaba%20Cloud-ff6a00?logo=alibabacloud&logoColor=white)](https://memory.43.106.13.19.sslip.io)
![Demo Video](https://img.shields.io/badge/Demo%20Video-pending%20upload-lightgrey?logo=youtube)
[![Tests](https://img.shields.io/badge/Tests-298%20total%20%7C%20283%20pass%20%7C%2015%20DB%20skips-brightgreen)](tests)
[![Coverage](https://img.shields.io/badge/Coverage-91.96%25%20statements-brightgreen)](tests)
[![Project Story](https://img.shields.io/badge/Project%20Story-Devpost-003e54)](demo/PROJECT_STORY.md)
<!-- USER: replace with YouTube URL before submit — make the Demo Video badge a link to the uploaded video -->


> **Track: MemoryAgent** — an agent with *persistent, queryable memory that retains and recalls information across sessions*.

> **Live:** [`https://memory.43.106.13.19.sslip.io`](https://memory.43.106.13.19.sslip.io) — open the URL for the memory explorer (public recall + field audit + P&L). Judges can paste the private Devpost reviewer token into the password-type **Judge token** field to run the protected semantic audit; the token is never published in this repo.

> **Judges:** [`docs/JUDGE-GUIDE.md`](docs/JUDGE-GUIDE.md) is a 2-minute click path — see a cross-session contradiction recalled *and resolved* in ~60 seconds.

## Three things that make this stand out

1. **★ Read-only self-auditing memory (the innovation).** A cross-session agent accumulates facts from many separate writes — and nothing stops two of them from **contradicting**. The agent **audits its own memory** (`POST /consistency`, [`src/memory/consistency.ts`](./src/memory/consistency.ts)): it detects same-record contradictions + dangling references and **recommends which value to trust** (`{rule, confidence, rationale}` over a fixed importance → source-authority → recency ladder) — but it is a **pure function that never mutates memory**. The measured differentiator is deliberately narrow: our Mem0 run exposed no contradiction/resolution API and returned both conflicting writes, while Graphiti uses temporal graph updates; this project instead exposes an explicit, read-only recommendation surface. Measured: **5/5 contradictions/dangling-refs detected, 0 false positives** on the control set, and **4/4 resolutions correct** on the labelled policy. → [details](#-self-auditing-memory-the-headline) · [BENCHMARK.md](./BENCHMARK.md#head-to-head-vs-mem0-and-zep)

2. **Recall measured head-to-head — beats the field-default retriever.** A frozen, labelled benchmark on **real `text-embedding-v4`** embeddings scores our `reranked-hybrid` retriever (dense + BM25 RRF fusion + a `qwen-plus` cross-encoder re-rank) against `naive-vector`, the single-vector cosine ANN that LangChain's `VectorStoreRetriever` and virtually every pgvector RAG demo ship **by default**:

   | Metric (vs field-default dense) | naive-vector | **reranked-hybrid (ours)** |
   |---|---:|---:|
   | Recall@3 | 90.0% | **96.7%** |
   | MRR | 0.883 | **0.911** |
   | nDCG@5 | 0.903 | **0.938** |

   Plus a **measured accuracy number on our own answers**: 100% gold recall@5, 100% correctness, **90.9% grounding** (we report the one honest grounding miss, not a suspicious 100%). All reproducible offline from committed fixtures, gated in CI. → [BENCHMARK.md](./BENCHMARK.md)

3. **One memory core, exposed three ways — including a real MCP server.** The same injectable `MemoryAgent` is reachable over **REST**, a **Model Context Protocol server** ([`src/mcp/server.ts`](./src/mcp/server.ts), official `@modelcontextprotocol/sdk`, **stdio + Streamable HTTP**, four typed tools), and a **`qwen-plus` function-calling skills layer** ([`src/skills/`](./src/skills)) — all through one shared `SkillDispatcher`, so the protocol layer never duplicates the memory logic. → [MCP integration & custom skills](#mcp-integration--custom-skills)

## What it is

Archon MemoryAgent gives a small business's financial-intelligence pipeline a **memory**.

Every fused financial event, validation finding, and narrated insight is embedded with **Qwen `text-embedding-v4`** (Alibaba Cloud Model Studio / DashScope) and stored in a **pgvector** memory layer.

On any later run — a different session, a different process, a fresh container — the agent **recalls the relevant prior facts by meaning** and grounds a **Qwen `qwen-plus`** answer in them. It reasons with continuity instead of starting cold on every request.

## Shipped product scope

This submission implements two concrete financial input paths:

- a document pipeline for a **payroll register + bank confirmation + payslips**, fused into one payroll event and validated with R1–R4; and
- a strict JSON contract for **purchase and sales invoices**, with explicit currency and idempotent retry semantics.

Over the resulting memories it produces a **currency-separated P&L** for payroll, purchases, sales, known/unknown cash movement, and net profit. Mixed currencies are never silently summed. The broader Archon product direction includes more document classes and metrics, but this entry does **not** claim shipped extraction for orders, receipts, general bank statements, EBITDA, or sales targets.

The MemoryAgent remembers the shipped events, findings, corrections, and insights across sessions and can answer later questions with citations.

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

The concrete demo memories cover payroll evidence, purchase/sales invoices, validation findings, and narrated insights. The payroll example highlights the **true cost of employing a team**: a bank salary transfer omits employer social-security contributions, so it understates employer cost.

## Why this is a MemoryAgent

| Track requirement | How this entry meets it |
|---|---|
| **Persistent memory** | Memories are embedded and written to pgvector on Alibaba Cloud PostgreSQL — durable, not in-process. |
| **Queryable memory** | Recall is semantic ANN search (`ORDER BY embedding <=> $q`) over an HNSW cosine index, with `kind`/`company` pre-filters. |
| **Across sessions** | The headline e2e test (`tests/e2e/cross-session.test.ts`) proves it. Session A writes and tears down completely; a fresh session B — no shared in-process state — recalls those memories and answers from them. The only thing shared is the database. |
| **Limited context windows** | Recall retrieves a bounded, relevant slice (`limit` is capped at 20) and narrates only from the returned, cited memories rather than replaying the whole store. |
| **Increasingly accurate over time** | Authenticated `POST /feedback` can protect a correct memory or atomically supersede an incorrect one with a high-importance correction; later recall uses the active corrected state. This is explicit feedback, not an unmeasured claim of automatic learning. |
| **Timely forgetting** | `POST /consolidate` and `POST /forget` provide tenant-scoped hygiene. Both preview by default; `confirm=true` is required before any mutation/deletion. |

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
- **Mem0** supports LLM-selected ADD / UPDATE / DELETE operations at write time; in our pinned comparison run it exposed no separate contradiction/resolution API and returned both conflicting writes.
- **Zep / Graphiti** models temporal validity by updating graph state and invalidating stale edges over time.
- **Ours never mutates.** It is a read-only, deterministic, domain-neutral pure function that surfaces the contradiction and hands back a *recommendation* — `rule + confidence + rationale` over a fixed importance → source-authority → recency ladder — for the agent or a human to accept or override.

**Meaning-level contradictions, too** — `POST /consistency/semantic` ([`src/memory/semantic-consistency.ts`](./src/memory/semantic-consistency.ts)). The rule-based audit above compares metadata fields, so it is blind to memories that oppose each other in *meaning* while sharing no comparable key — e.g. *"vendor always pays on time"* vs *"vendor is chronically late"*. A companion **semantic** audit closes that gap: it embeds each memory (the same `text-embedding-v4` path recall uses), keeps only same-subject pairs by cosine, then asks a judge whether they contradict — **qwen-plus** online, a deterministic polarity/negation heuristic offline (so it runs in CI with no key). It reuses the **same read-only resolution ladder** and, like the rule-based path, **never mutates memory**. It runs *alongside* the rule-based engine — additive, neither replaces the other. And it is **measured, not asserted**: on a labelled corpus (`bench/semantic-consistency-dataset.ts`, `npm run bench:semantic`) of opposed pairs + a hard control (agreeing / negation-agreeing / complementary / different-subject) the offline judge scores **90% recall, 100% precision, 0 false positives** — and on that same corpus the field-level audit catches **0**, so the meaning-level self-audit **surfaces 9 contradictions a naive store would serve as truth**. The one honest miss is a *cue-free* pair (no lexical polarity signal) — exactly what the online qwen-plus judge exists to close. → [BENCHMARK.md](./BENCHMARK.md#meaning-level-semantic-self-audit--measured-on-a-labelled-set)

The claim is not "we detect and they cannot." It is **"we recommend without mutating, explainably and portably"** — a memory layer that stays honest about what it holds.

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
| **Qwen models** | `text-embedding-v4` (1024-d embeddings) + `qwen-plus` (RAG narration, rerank, semantic judge, function calling) + `qwen-vl-max` (payroll-document vision extraction). |
| **Qwen Cloud / DashScope** | Called via the OpenAI-compatible endpoint `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` with the standard `openai` Node SDK. Key = `DASHSCOPE_API_KEY`. |
| **Alibaba Cloud deployment** | The HTTP backend (`src/server.ts`) ships as a container (`Dockerfile`) and runs **live on Alibaba Cloud ECS** (`ecs.e-c1m2.large`, ap-southeast-1) via docker-compose — the backend plus a self-hosted **pgvector container** as the memory store. A **Function Compute + managed ApsaraDB RDS** path is also provided (`deploy/s.yaml`, `deploy/deploy-fc.sh`) as a serverless alternative. See [`deploy/`](./deploy). |

## Architecture

The **MemoryAgent is the centre** (recall + self-audit). The document-ingestion **pipeline is the supporting upstream** that *produces* the memories the agent remembers.

In standard-pattern terms this is three well-understood pieces, not a novel framework: an **agent** (the recall/RAG loop over persistent memory), **MCP** in its canonical role as the coordination + context-sharing standard, and self-audit workflows over the agent's stored state. The field-level audit is deterministic; the separate meaning-level audit uses `qwen-plus` online and a deterministic polarity judge offline. Both remain read-only and return reproducible provenance/status rather than silently editing memory. Because the Track-4 **Autopilot** entry consumes the same memory abstraction and both entries expose MCP, an external orchestrator can compose them without speculative multi-agent debate machinery.

```mermaid
flowchart TB
    Agent["AI agent / HTTP caller"]
    Docs["Raw financial documents<br/>(scanned images · pdf · text)"]
    MCPClient["MCP client — Claude Desktop / IDE / agent"]

    subgraph ECS["Alibaba Cloud · ECS ap-southeast-1 · docker-compose"]
        direction TB
        subgraph API["backend container — Fastify · src/server.ts"]
            direction LR
            H["Public health / schema<br/>GET /health · /ready · /docs"]
            I["Authenticated tenant writes<br/>/ingest · /feedback · lifecycle"]
            R["Public-tenant reads<br/>/recall (quota) · /pnl · rule audit"]
            C["Authenticated heavy audit<br/>/consistency/semantic"]
        end
        subgraph PIPE["Ingestion pipeline — src/pipeline (supporting cast)"]
            direction LR
            EX["Extractor<br/>(qwen-vl-max / qwen-plus)"]
            CL["Classifier"]
            EL["EventLinker<br/>company + period + event_ref"]
            VA["Validator R1–R4"]
            PN["Currency-separated P&amp;L<br/>mixed totals never combined"]
            EX --> CL --> EL --> VA --> PN
        end
        subgraph MCPSURF["MCP surface — src/mcp/* + src/skills/*"]
            direction LR
            MT["4 MCP tools<br/>recall · ingest · audit(+semantic) · count"]
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

    Agent -->|HTTP / JSON · Bearer for protected routes| API
    Docs -->|POST /ingest/documents| API
    API --> PIPE
    API --> MA
    PIPE -->|fused events + findings| MA
    EX -->|vision / text| VL
    MCPClient -->|local stdio · authenticated Streamable HTTP| MT
    MT --> SK
    SK --> MA
    MA -->|embed| EMB
    MA -->|chat| LLM
    MA -->|SQL · pg-wire| DB
    DB -. drop-in swap .-> RDS
```

Submission-ready rendered assets: [`docs/architecture.svg`](./docs/architecture.svg) · [`docs/architecture.png`](./docs/architecture.png) · source [`docs/architecture.mmd`](./docs/architecture.mmd).

Both surfaces — the HTTP routes and the MCP tools / custom skills — go through the **same injectable `MemoryAgent`** via the shared `SkillDispatcher`. There is one implementation of recall / ingest / audit / count, exposed three ways (REST, MCP, and Qwen function-calling), so the protocol layer never duplicates the memory logic.

**Live deployment** = ECS + docker-compose (backend + pgvector container). Because the store is pg-wire, the identical code runs unchanged on a managed ApsaraDB RDS / AnalyticDB for PostgreSQL instance (the Function Compute alternative in `deploy/`).

**Offline / CI:** no `DASHSCOPE_API_KEY` → deterministic Fake embedder, narrator, reranker, semantic judge, and extractor; pgvector runs as a docker service for DB-backed CI slices. Same interfaces, zero cloud credentials. Production does not silently use this mode.

### Write path (`remember`)

An agent states a fact in natural language. For example:

> *"Payroll event for ByteCraft Software 2026-05: bank cash-out €10,000; true employer cost €15,800."*
>
> *"Purchase invoice PINV-771 from Pallas Freight: EUR 3,200; paid amount unknown."*

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
│   │   ├── semantic-consistency.ts # SELF-AUDIT (meaning): embedding-gated + judge (qwen-plus / offline polarity) — read-only
│   │   ├── consolidation.ts     # consolidate (dedup) + forget planners (pure)
│   │   ├── store.ts             # MemoryStore: PgVectorStore + InMemoryStore (hybrid + lifecycle + audit)
│   │   └── memory.ts            # remember() / recall() — embed ↔ store orchestration
│   ├── agents/
│   │   ├── narrator.ts          # QwenNarrator (qwen-plus RAG) + offline FakeNarrator
│   │   └── memory-agent.ts      # MemoryAgent: ingestEvent · recallAnswer · auditConsistency · auditSemanticConsistency · consolidate · forget
│   ├── pipeline/                # document-ingestion pipeline (supporting cast): extractor · classifier · event-linker · validator · pnl · vision
│   ├── mcp/{server.ts,tools.ts}   # Model Context Protocol server — the four memory tools over stdio + Streamable HTTP
│   ├── skills/                  # qwen-plus function-calling skills + shared SkillDispatcher (schemas = single source of truth)
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
cp .env.example .env
# Generate URL-safe random DB + judge secrets, then edit .env. Set
# POSTGRES_PASSWORD and build BOTH URLs with the same value:
#   DATABASE_URL=postgresql://memoryagent:<password>@localhost:5432/memoryagent
#   COMPOSE_DATABASE_URL=postgresql://memoryagent:<password>@db:5432/memoryagent
# Also set JUDGE_API_KEY (32+ chars). DASHSCOPE_API_KEY may stay empty only for
# local Fake-backed development; production requires real Qwen.
set -a; . ./.env; set +a
npm ci

# 1. Start local pgvector + create the schema
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
npm run db:schema

# 2. Run the end-to-end agent-memory demo (write fused events, recall by meaning)
npm run memory:demo

# 3. Run the HTTP backend
npm start                       # open http://localhost:9000

# 4. Reproduce the benchmarks (replay committed fixtures — no key, no spend)
npm run bench                   # retrieval: Recall@k / MRR / nDCG (incl. re-rank + shuffled control)
npm run bench:consistency       # self-audit (rule-based): detection rate + false positives on the control set
npm run bench:semantic          # self-audit (meaning-level): recall / precision / FP-rate on the labelled semantic corpus

# Tests
npm run test:unit               # no infra, no key (logic, retrieval, metrics, consolidation)
npm run test:integration        # real pgvector (needs DATABASE_URL)
npm run test:e2e                # cross-session persistence (needs DATABASE_URL)
```

Once the backend is running, open **`http://localhost:9000/docs`** for the interactive API explorer (Swagger UI), or fetch the raw spec at `/openapi.json`.

### HTTP API

| Method + path | Access | Purpose |
|---|---|---|
| `GET /docs` | Public | Interactive API explorer (Swagger UI). |
| `GET /openapi.json` | Public | Machine-readable OpenAPI 3 spec. |
| `GET /health` | Public | Liveness; reports embedder/narrator model ids + dimension. |
| `GET /ready` | Public | Dependency readiness; verifies database/schema, real Qwen provider, and production judge-auth configuration. |
| `GET /memory/count` | Public tenant, or credential tenant | Count memories in the server-selected tenant. |
| `GET /memory/list` | Public tenant, or credential tenant | `?company=&kind=&limit=` → recent `{ id, kind, company, period, snippet, createdAt }` rows. |
| `POST /demo/seed` | Public fixed payload; ingest quota | Idempotently seed the built-in payroll + field/meaning contradiction demo. It accepts no caller-controlled memory content. |
| `POST /ingest` | Authenticated; ingest quota | `{ event }` → tenant-scoped memories for a fused payroll event. |
| `POST /ingest/invoice` | Authenticated; ingest quota | Currency-explicit purchase/sales invoice. Exact retries are idempotent; a changed payload for the same logical invoice returns `409`. |
| `POST /ingest/documents` | Authenticated; ingest quota | Payroll evidence pipeline (Extractor → Classifier → EventLinker by company/period/event_ref → Validator → P&L), then atomic tenant-scoped writes. The aggregate JSON body is capped at 10 MiB by default (`MAX_JSON_BODY_BYTES`); decoded images and text have stricter extraction limits. |
| `GET /pnl` | Public tenant, or credential tenant | `?company=&period=` → payroll + purchase/sales-invoice P&L. `currency_status` and `by_currency` prevent mixed-currency totals. |
| `POST /recall` | Public tenant, or credential tenant; recall quota | Grounded, cited answer (hybrid + rerank by default) plus best-effort self-audit over recalled memories. |
| `POST /feedback` | Authenticated; incorrect correction uses ingest quota | Protect a correct memory or atomically supersede an incorrect one with a high-importance correction. |
| `POST /consistency` | Public tenant, or credential tenant | Deterministic field-level contradictions + dangling references, each with a read-only recommendation. |
| `POST /consistency/semantic` | Authenticated; semantic quota | Meaning-level contradiction audit using stored embeddings + qwen-plus online (offline judge in CI). Read-only. |
| `POST /consolidate` | Authenticated | Preview near-duplicate consolidation by default; `confirm=true` applies it. |
| `POST /forget` | Authenticated | Preview tenant-scoped retention by default; `confirm=true` is required to delete. |

**Currency contract.** Payroll records without an explicit currency are reported under `UNSPECIFIED`; invoices require one. With a single currency, top-level monetary totals are populated. With mixed currencies, `currency_status="mixed"`, top-level monetary totals are `null`, and complete independent totals are returned in `by_currency`. Purchase cash can be `unpaid`, `partial`, `paid`, `refund`, or `unknown`; unknown paid amounts are reported separately rather than guessed.

**Local Fakes vs production.** With no `DASHSCOPE_API_KEY`, local development and tests use deterministic Fake clients while still exercising the pgvector path. In `NODE_ENV=production`, Qwen-heavy routes fail closed when only Fakes are available (unless the explicit non-qualifying `ALLOW_FAKE_QWEN=true` override is set), and `/ready` does not report ready. A qualifying live deployment therefore requires real Qwen.

**Auth, tenant isolation, and spend bounds.** The no-login judge path is intentionally limited to the fixed public demo and public-tenant reads. Production mutations, feedback, lifecycle operations, and the semantic audit require `Authorization: Bearer …` or `x-api-key`; the matched credential selects the tenant server-side, so a request cannot choose another tenant. A coarse per-client limiter bounds the complete HTTP surface at **300 requests/minute** by default (`HTTP_RATE_LIMIT_MAX`), including readiness and cheap database reads. Qwen-heavy routes additionally use atomic UTC-daily per-subject/IP plus global quotas: recall defaults to **200 / 2,000**, ingest (including seed) to **100 / 500**, and semantic audit to **20 / 100**. Cheap reads such as count, list, P&L, and field-level audit do not spend Qwen quota. Invalid credentials fail rather than falling back to the public tenant.

The Explorer exposes a password-type **Judge token** field and a **Run semantic audit** button for the protected judge path. Paste only the credential supplied in Devpost's private testing instructions; clear it before screenshots/recording cuts and never place it in source, URLs, posts, or public video descriptions.

### Resilience

A live model service will blip; the memory layer should not fail with it. Three measures keep `/recall` and `/ingest` responsive when Qwen (DashScope) is slow or unreachable:

- **Bounded model calls.** Every call to DashScope goes through one OpenAI-compatible client configured with a **per-request timeout** (`QWEN_TIMEOUT_MS`, default 20s) and a small **automatic retry budget** (`QWEN_MAX_RETRIES`, default 2). Without these a single upstream stall would hang a recall until the socket eventually gave up — the exact failure a judge would see mid-demo. Both are env-tunable.
- **Graceful narrator degradation.** By the time the answer narrator (`qwen-plus`) runs, the memories have **already been retrieved** from pgvector. So if narration fails, the recall is not thrown away: `/recall` still returns the retrieved memories as citations plus a plain fallback answer composed from them, with a `"degraded": "narrator unavailable — returning raw recalled memories"` flag — a soft, still-useful, still-grounded result instead of a hard 500. (Retrieval itself needs the query embedding, so an *embedder* outage surfaces as a clear error rather than a silent empty answer — you can't recall without the query vector.)
- **Structured error envelope.** A Fastify `setErrorHandler` turns any unhandled server-side fault into a typed `{ "error": … }` with a **503** (service temporarily unavailable) — never a leaked stack. Client mistakes keep their own `4xx` (the request-validation guards are unaffected).

All three are covered by offline unit tests (timeout/retry config, the degraded-recall path, and the 503-vs-preserved-4xx envelope) — no key, no network.

## MCP integration & custom skills

Beyond the REST API, the same memory is exposed two more ways for the rubric's *sophisticated QwenCloud API / MCP / custom-skills* dimension: a **Model Context Protocol (MCP) server** and a **Qwen function-calling custom-skills layer**. Both wrap the identical injectable `MemoryAgent` through one shared `SkillDispatcher` ([`src/skills/dispatcher.ts`](./src/skills/dispatcher.ts)) — the exact code the HTTP routes run — so there is no duplicated memory logic. The schemas ([`src/skills/schemas.ts`](./src/skills/schemas.ts)) are the single source of truth reused verbatim as both MCP `inputSchema` and OpenAI function `parameters`.

### The four skills / MCP tools

| Skill / MCP tool | Args | What it does |
|---|---|---|
| `recall_memory` | `{ question, company?, kind?, limit? }` | Hybrid semantic recall → Qwen-narrated **grounded, cited answer** + a best-effort self-audit (same path as `POST /recall`). |
| `ingest_memory` | `{ content, kind, company?, period?, sourceRef?, metadata? }` | Embeds (`text-embedding-v4`) and writes a single fact into persistent memory. |
| `audit_memory` | `{ company?, period?, kind? }` | Read-only cross-session **self-audit**: contradictions (with a resolution recommendation) + dangling references. |
| `memory_count` | `{ company? }` | How many memories the agent holds. |

There are exactly **four skills/tools**, while `kind` is a separate validated six-value JSON-Schema enum: `document | payroll_event | validation | insight | invoice | action`. Both an MCP client and qwen-plus therefore get a sharp typed choice, not free text.

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

**Remote clients.** stdio is the local/trusted MCP transport. Streamable HTTP is deliberately **always authenticated and fail-closed**: configure `MCP_API_KEY` + `MCP_TENANT_ID` (or let it reuse `JUDGE_API_KEY` + `JUDGE_TENANT_ID`), terminate TLS at the trusted edge, and send Bearer or `x-api-key` credentials. The credential selects the tenant server-side; HTTP tool calls are also protected by per-principal + global daily quotas.

```json
{
  "mcpServers": {
    "archon-memoryagent": {
      "url": "https://<trusted-host>/mcp",
      "headers": { "Authorization": "Bearer <private-mcp-token>" }
    }
  }
}
```

(The public REST/UI deployment does not imply that port `9100` is exposed. Publish the HTTP MCP transport only behind the authenticated TLS edge.)

### 2. Custom-skills layer for qwen-plus ([`src/skills/loop.ts`](./src/skills/loop.ts))

The same skills are handed to **`qwen-plus` as OpenAI-compatible function tools**, so the model itself decides which memory operation to call. `runSkillLoop()` runs the standard tool-calling cycle — model proposes a skill call → the `SkillDispatcher` executes it against memory → the result is fed back → the model continues until it produces a final grounded answer. This is the agentic counterpart to the REST API: instead of a caller choosing an endpoint, qwen-plus chooses a skill.

Both surfaces are covered by offline unit tests ([`tests/unit/mcp.test.ts`](./tests/unit/mcp.test.ts) exercises the server over the real MCP protocol via the SDK's in-memory transport + a `Client`; [`tests/unit/skills.test.ts`](./tests/unit/skills.test.ts) exercises the dispatcher and the function-calling loop with a canned client) — no network, no key, no DB.

## Deploy to Alibaba Cloud

### Live path — ECS + docker-compose (backend + pgvector container)

This is how the entry actually runs on Alibaba Cloud. A single ECS instance (`ecs.e-c1m2.large`, ap-southeast-1) runs docker-compose with the backend container plus a self-hosted `pgvector/pgvector` container as the memory store, behind one public URL.

[`deploy/redeploy.sh`](./deploy/redeploy.sh) is the schema-first redeploy helper. Treat [`deploy/DEPLOY_STATE.md`](./deploy/DEPLOY_STATE.md) as an operational history, not current proof; the release contract is `/ready` 200, real-model `/health`, and the final OpenAPI smoke in [`demo/FINAL_MEDIA_CHECKLIST.md`](./demo/FINAL_MEDIA_CHECKLIST.md).

```bash
# On the ECS box:
cd /root/memoryagent
git pull --ff-only
bash deploy/redeploy.sh
curl -fsS http://127.0.0.1:9000/ready
```

The destructive clean-slate option is intentionally harder to invoke:
`bash deploy/redeploy.sh --truncate --confirm-truncate`. It is not part of the
normal judge/demo flow. Public traffic reaches the service through the HTTPS
reverse proxy; Compose binds port 9000 to loopback only.

Set the PostgreSQL credentials/URLs, `DASHSCOPE_API_KEY`, `DASHSCOPE_BASE_URL`, and a long random `JUDGE_API_KEY`/tenant mapping via the compose environment — never commit them. Production is fail-closed: a qualifying box must use real Qwen, authentication enabled, and `/ready` returning `200`; deterministic Fakes are for local/CI only.

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

This backend's qualifying path runs on **Alibaba Cloud ECS**. Two halves of proof:

**1. Runtime recording** — refresh [`demo/alibaba-proof.mp4`](./demo/alibaba-proof.mp4) after the final deploy. It must show the ECS instance `Running`, MemoryAgent `/ready` passing, and `/health` returning the real Qwen model ids over HTTPS. The checked-in pre-hardening capture is reference media until replaced.

```text
$ aliyun ecs DescribeInstances --RegionId ap-southeast-1 --InstanceIds "['<redacted-instance-id>']"
  Region: ap-southeast-1   Status: Running

$ curl https://memory.43.106.13.19.sslip.io/ready
  {"status":"ready","checks":{"database":"ok","qwen":"configured","judgeAuth":"configured"}}

$ curl https://memory.43.106.13.19.sslip.io/health
  {"status":"ok","embedder":"text-embedding-v4","narrator":"qwen-plus","embedDim":1024}
```

**2. Code that uses Alibaba Cloud services & APIs** — direct links:

| Alibaba Cloud service | Code file | What it does |
|---|---|---|
| **ECS** (live deploy) | [`deploy/redeploy.sh`](./deploy/redeploy.sh) | Syncs source and (re)starts the docker-compose stack (backend + pgvector container) on the ECS instance behind one public HTTPS URL. |
| **Function Compute** (serverless alternative) | [`deploy/s.yaml`](./deploy/s.yaml) | Serverless Devs spec for the custom-container HTTP function + managed ApsaraDB RDS memory store. |
| **Model Studio / DashScope** (Qwen inference) | [`src/qwen/client.ts`](./src/qwen/client.ts) + [`src/pipeline/vision.ts`](./src/pipeline/vision.ts) | OpenAI-compatible client used for `text-embedding-v4`, `qwen-plus` narration/rerank/judging/skills, and `qwen-vl-max` vision extraction. |

Full proof doc with every service mapping: [`demo/ALIBABA_PROOF.md`](./demo/ALIBABA_PROOF.md).

## Testing & CI

Verified full test/coverage run: **300 total, 285 pass, 0 fail, 15 intentional real-DB skips** when no integration database is supplied. Coverage is **91.96% statements, 84.96% branches, 91.25% functions, 91.96% lines**. Qwen/Alibaba credentials are not needed for CI; deterministic Fakes and committed fixtures exercise the model seams without external spend.

| Tier | File(s) | What it proves |
|---|---|---|
| **Unit** | `tests/unit/*` | Embedder + narrator (Qwen canned + Fake), memory logic, **retrieval primitives** (BM25, RRF, MMR, hybrid, **re-rank**), **IR metrics**, **consolidation + forgetting**, **self-audit consistency** (contradiction + absence detection, precision on a control set), and the **MCP server + custom-skills layer** (`mcp.test.ts` drives the server over the real MCP protocol via the SDK in-memory transport; `skills.test.ts` covers the dispatcher + qwen-plus function-calling loop) — all over `InMemoryStore`, no infra. |
| **Integration** | `tests/integration/*` | Real pgvector SQL and pipeline writes: `::vector` insert, `<=>` cosine recall, filters, count, hybrid dense+FTS fusion, idempotency, and consolidate → supersede → forget. These tests skip explicitly when no real DB is supplied. |
| **E2E** | `tests/e2e/*` | **Cross-session persistence** (session A writes + tears down, session B recalls) plus a broad **offline journey suite** (`full-journey.test.ts` + http / mcp / templates / robustness): seed → recall → cited answer → rule-audit → semantic-audit → MCP round-trip → P&L → provenance, and the error/edge journeys (empty store, no-contradiction, judge-guide chips). 50+ journeys over `InMemoryStore` + Fakes — no infra, no key. |
| **Security (pen-test)** | `tests/security/*` | Automated app-security suite over the real HTTP + MCP surface: **authorization + daily-spend budget** (429 when exhausted), **prompt-injection resistance** (a genuine contradiction is still flagged despite an injected "report consistent" instruction — the read-only audit is unswayable), **MCP tool-boundary / excessive-agency** (reads never mutate; unknown tools fail safe; no prototype pollution), **sensitive-data exposure** (no stack/path/secret leaks), and **store-injection** (a `DROP TABLE` payload and NaN/Inf embeddings stay inert). Runs as the `pen-test` CI job; the SQL-parameterization case runs against real pgvector. |
| **Benchmark gates** | `bench/*` | **Retrieval regression gate** (hybrid ≥ dense) + **discrimination gate** (shuffled control near chance) + **grounded-answer accuracy gate** (`bench:accuracy`: correctness 100%, grounding ≥ 90%) + **self-audit gate** (`bench:consistency`: 100% detection, 0 false positives) + **semantic self-audit gate** (`bench:semantic`: 90% recall, 100% precision, 0 FP on the labelled meaning-level corpus) + **resolution gate** (`bench:resolution`: structural invariants + winner-accuracy on the labelled policy). Re-rank delta vs dense and the Mem0 head-to-head are reported (not gated). All replay committed fixtures — no key, no spend. |
| **Load / performance** | `load/recall-load.js` (k6) | Drives concurrent `/health` + `/recall` + `/consistency` and asserts **p95 latency + error-rate SLOs** as k6 thresholds (the run fails on a regression). Two profiles: an **offline smoke** that runs on **every push** via the `load` CI job (boots the backend on deterministic Fakes against a real pgvector, seeds, then holds tight local SLOs — free, no spend), and a manual, arrival-rate-bounded `load-test` workflow that exercises the **live box** (real Qwen) without overrunning its production HTTP or Qwen quotas. |

CI stages:

1. **secret-scan** — gitleaks (pinned v8.18.4, redacted). Fails fast on any committed secret.
2. **dep-audit** — `npm audit` (fails on high/critical).
3. **build-test** — typecheck → schema apply (stands up real pgvector) → unit → integration → e2e → offline demo smoke.
4. **benchmark** — `npm run bench -- --gate` (retrieval regression + discrimination), `npm run bench:accuracy -- --gate` (grounded-answer correctness + faithfulness), `npm run bench:consistency -- --gate` (self-audit detection/precision), `npm run bench:semantic -- --gate` (meaning-level self-audit: 90% recall, 100% precision, 0 FP), and `npm run bench:resolution -- --gate` (contradiction-resolution invariants + policy-conformance). All over committed fixtures — no key, no spend.
5. **pen-test** — `npm run test:security` (authz + daily-spend budget, prompt-injection resistance, MCP tool-boundary, sensitive-data exposure, SQL-parameterization against real pgvector).
6. **load** — boots the backend offline, seeds, runs the bounded k6 smoke; the p95 + error-rate **SLO thresholds gate the job**.
7. **readiness** — `npm run readiness -- --gate`: the weighted rubric completeness (≥ 95%) **and** the new **assurance dimension** (security / load / e2e layers all wired) must both be green.
8. **CodeQL** (`.github/workflows/codeql.yml`) — SAST for the TypeScript source.

Every stage runs **fully offline**. There are no DashScope / Alibaba credentials in CI, because the Qwen embedder/narrator auto-fall back to deterministic Fakes and the benchmark replays cached vectors.

### Load SLOs

The k6 thresholds are the contract — a run **fails** if any is breached. The offline CI smoke (`OFFLINE=true`, deterministic Fakes over real pgvector) holds the tight local targets; the manual live-box run holds the looser real-Qwen targets.

| Metric | Offline CI smoke (Fakes) | Live box (real Qwen) |
|---|---|---|
| `/health` p95 / p99 | < 300 ms / < 600 ms | < 500 ms / < 800 ms |
| `/recall` p95 / p99 | < 1500 ms / < 2500 ms | < 2500 ms / < 4000 ms |
| `/consistency` p95 / p99 | < 1500 ms / < 2500 ms | (opt-in) < 2500 ms |
| Error rate (`http_req_failed`) | < 1% | < 1% |
| Checks passing | > 99% | > 99% |

## How this maps to the judging rubric

| Criterion (weight) | Where to look |
|---|---|
| **Technical Depth & Engineering (30%)** | Clean, modular boundaries (`MemoryAgent`, `MemoryStore`, provider interfaces, shared `SkillDispatcher`), tenant isolation, auth, atomic idempotent writes, durable quotas, mixed-currency safety, bounded model calls/fallbacks, pgvector indexes, lifecycle dry-runs, structured errors, CodeQL, and the verified test/coverage pyramid. The architecture scales from the live ECS compose stack to a pg-wire managed-store/Function Compute alternative without changing the core. |
| **Innovation & AI Creativity (30%)** | **Self-auditing memory that recommends without mutating**, measured at 5/5 field-level problems with 0 false positives and 4/4 labelled policy resolutions. The additive semantic audit is measured at **90% recall, 100% precision, 0 false positives** offline. Sophisticated Qwen use spans `text-embedding-v4`, `qwen-plus` narration/rerank/semantic judging/function calling, and `qwen-vl-max`, exposed through REST, four MCP tools, and a shared custom-skills layer. This wording explicitly covers both the detailed rules' Qwen/MCP emphasis and the overview rubric's broader innovation language. |
| **Problem Value & Impact (25%)** | A real SMB risk: durable financial facts and corrections must remain queryable without hiding conflicts. The shipped proof uses payroll evidence plus purchase/sales invoices, currency-separated P&L, cited recall, and explicit correction/forgetting—not unimplemented order/receipt/EBITDA claims. |
| **Presentation & Documentation (15%)** | This README + architecture diagram + [BENCHMARK.md](./BENCHMARK.md) (method + honest caveats) + [JUDGE_REVIEW.md](./demo/JUDGE_REVIEW.md) (rules check & strict review) + the interactive `/docs` API explorer + the ~3-min demo + the live Alibaba URL. |

## Provenance / reuse

Archon is our own product. This entry reuses our public Archon builds freely and ports the memory layer to Qwen + Alibaba Cloud. The `memory/` layer, the `MemoryStore` abstraction, `QwenEmbedder` / `QwenNarrator`, and the cross-session e2e are built for this hackathon.

## License

MIT — see [LICENSE](./LICENSE).
