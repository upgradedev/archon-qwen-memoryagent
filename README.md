# Archon MemoryAgent — Qwen × Alibaba Cloud

**Entry for the [Global AI Hackathon Series with Qwen Cloud](https://qwencloud-hackathon.devpost.com/) — `MemoryAgent` track.**

> **Track: MemoryAgent** — an agent with *persistent, queryable memory that retains and recalls information across sessions*.

An agent that gives a small business's financial-intelligence pipeline a **memory**. Every fused financial event, validation finding, and narrated insight is embedded with **Qwen `text-embedding-v4`** (Alibaba Cloud Model Studio / DashScope) and stored in a **pgvector** memory layer. On any later run — a different session, a different process, a fresh container — the agent **recalls the relevant prior facts by meaning** and grounds a **Qwen `qwen-plus`** answer in them. It reasons with continuity instead of starting cold on every request.

The headline domain insight it remembers: *the bank salary transfer understates the true employer payroll cost by ~28%*, because the bank confirmation never sees employer social-security (IKA) contributions. Archon fuses bank confirmation + payroll register + payslips into one accurate event and **remembers the €22,800 hidden-cost wedge** so it can answer questions about it across sessions.

## Why this is a MemoryAgent

| Track requirement | How this entry meets it |
|---|---|
| **Persistent memory** | Memories are embedded and written to pgvector on Alibaba Cloud PostgreSQL — durable, not in-process. |
| **Queryable memory** | Recall is semantic ANN search (`ORDER BY embedding <=> $q`) over an HNSW cosine index, with `kind`/`company` pre-filters. |
| **Across sessions** | The headline e2e test (`tests/e2e/cross-session.test.ts`) proves it: **session A writes and tears down completely; a fresh session B — no shared in-process state — recalls those memories and answers from them.** The only thing shared is the database. |
| **Increasingly accurate over time** | Each ingested event adds recallable facts; later questions retrieve the accumulated memory, not just the current request's context. |

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
An agent states a fact in natural language (`"Hidden payroll cost at Acme for 2026-03: the bank transfer of €41,000 understates true employer cost by €22,800 (28.8%)…"`) → Qwen `text-embedding-v4` embeds it → the text, structured metadata, and the 1024-dim vector are stored in `agent_memory`.

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
│   │   ├── store.ts             # MemoryStore: PgVectorStore + InMemoryStore
│   │   └── memory.ts            # remember() / recall() — embed ↔ store orchestration
│   ├── agents/
│   │   ├── narrator.ts          # QwenNarrator (qwen-plus RAG) + offline FakeNarrator
│   │   └── memory-agent.ts      # MemoryAgent: ingestEvent → recallAnswer
│   ├── db/{client.ts,schema.sql}  # pg pool + pgvector schema (vector(1024) + HNSW)
│   ├── types.ts                 # PayrollEvent domain types
│   └── server.ts                # Fastify HTTP backend (the Alibaba Cloud deploy target)
├── scripts/{apply-schema.ts,demo-memory.ts}
├── tests/{unit,integration,e2e}/  # the testing pyramid
├── deploy/{s.yaml,deploy-fc.sh}   # Alibaba Function Compute (custom container)
├── Dockerfile · docker-compose.yml
└── .github/workflows/ci.yml       # gitleaks → typecheck → unit → integration → e2e
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
npm start                       # GET /health · POST /ingest · POST /recall

# Tests
npm run test:unit               # no infra, no key
npm run test:integration        # real pgvector (needs DATABASE_URL)
npm run test:e2e                # cross-session persistence (needs DATABASE_URL)
```

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
| **Unit** | `tests/unit/*` | Embedder (Qwen canned + Fake), narrator (Qwen canned + Fake), memory logic + top-k ranking over `InMemoryStore`. |
| **Integration** | `tests/integration/pgvector-store.test.ts` | Real pgvector SQL: `::vector` insert, `<=>` cosine recall, filters, count. |
| **E2E** | `tests/e2e/cross-session.test.ts` | **Cross-session persistence** — session A writes + tears down, session B recalls. |

CI order: **gitleaks (pinned v8.18.4)** → typecheck → schema apply → unit → integration → e2e → offline demo smoke.

## Provenance / reuse

Archon is our own product; this entry reuses our public Archon builds freely and ports the memory layer to Qwen + Alibaba Cloud. The `memory/` layer, `MemoryStore` abstraction, `QwenEmbedder`/`QwenNarrator`, and the cross-session e2e are built for this hackathon.

## License

MIT — see [LICENSE](./LICENSE).
