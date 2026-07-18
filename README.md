# Archon MemoryAgent: self-auditing memory on Qwen and Alibaba Cloud

**Our entry for the [Global AI Hackathon Series with Qwen Cloud](https://qwencloud-hackathon.devpost.com/), `MemoryAgent` track.**

[![CI](https://github.com/upgradedev/archon-qwen-memoryagent/actions/workflows/ci.yml/badge.svg)](https://github.com/upgradedev/archon-qwen-memoryagent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Alibaba%20Cloud-ff6a00?logo=alibabacloud&logoColor=white)](https://memory.43.106.13.19.sslip.io)
![Demo Video](https://img.shields.io/badge/Demo%20Video-pending%20upload-lightgrey?logo=youtube)
[![Project Story](https://img.shields.io/badge/Project%20Story-Devpost-003e54)](demo/SUBMISSION.md)
<!-- USER: replace with YouTube URL before submit. Make the Demo Video badge a link to the uploaded video. -->

**Documentation map:** judges can start with the
[`2-minute guide`](docs/JUDGE-GUIDE.md), the
[`measured evidence`](BENCHMARK.md), and the
[`16:9 architecture`](demo/final-media/judge-architecture.jpg). Release operators
use [`FINAL_MEDIA_CHECKLIST.md`](demo/FINAL_MEDIA_CHECKLIST.md) as the single entry
point; the only publication pipeline is
[`REAL_MOTION_VIDEO.md`](demo/REAL_MOTION_VIDEO.md), and the checklist links every
capture, rights, and publication runbook in execution order. Those `demo/*.md` files
are internal operating guides, not competing project stories. Security and private
reporting guidance lives in [`SECURITY.md`](SECURITY.md).

> **Track 1 only: MemoryAgent.** This is an agent with *persistent, queryable memory that retains, recalls, audits, corrects, consolidates, and forgets information across sessions*. This entry is intentionally independent from the separate Autopilot submission: it neither executes accounts-payable actions nor contains an approval workflow; its product boundary is trustworthy long-term memory.

> **Live:** [`https://memory.43.106.13.19.sslip.io`](https://memory.43.106.13.19.sslip.io). Open the URL for the memory explorer (public recall + field audit + P&L) and click **Run demo** once to seed and submit the canonical bounded recall automatically. Judges can paste the dedicated Devpost reviewer credential into the password-type **Reviewer token (protected audit/feedback)** field, then click **Run bounded Qwen insight scan**. That visible judge path checks at most one eligible, highest-similarity `insight` pair (`maxPairs: 1`); the credential is never published in this repo.

> **Judges:** [`docs/JUDGE-GUIDE.md`](docs/JUDGE-GUIDE.md) is a 2-minute click path. It shows a cross-session contradiction, its read-only recommendation, and the separate authenticated human Accept / Override / Defer loop.

## Three things that make this memory different

1. **★ Read-only self-auditing memory.** A cross-session agent accumulates facts from many separate writes, and nothing stops two of them from **contradicting**. The agent **audits its own memory** (`POST /consistency`, [`src/memory/consistency.ts`](./src/memory/consistency.ts)): it detects same-record contradictions + dangling references and **recommends which value to trust** (`{rule, ordinal confidence, rationale}` over a fixed importance → source-authority → recency ladder), but it is a **pure function that never mutates memory**. The measured differentiator is deliberately narrow: our pinned Mem0 2.0.11 `dir()` probe found no separately named public contradiction/resolution method, and its returned memory strings contained both conflicting values; that does not rule out internal, undocumented, differently named, or newer behavior. Graphiti models temporal validity through graph updates; this project exposes an explicit, read-only recommendation surface. Measured: **5/5 developer-injected problems detected, 0 false positives** on that control, and **4/4 policy-conformance cases** (not independently validated truth). → [details](#-self-auditing-memory) · [BENCHMARK.md](./BENCHMARK.md#head-to-head-vs-mem0-and-zep)

2. **Recall measured against a common dense-only baseline.** A frozen **32-memory / 15-query synthetic financial benchmark** on real `text-embedding-v4` embeddings scores our `reranked-hybrid` retriever (dense + BM25 RRF fusion + one bounded listwise `qwen-plus` re-rank call) against `naive-vector`, a common single-vector cosine ANN configuration:

   | Metric (frozen corpus; explicit dense condition) | naive-vector | **reranked-hybrid (ours)** |
   |---|---:|---:|
   | Recall@3 | 90.0% | **96.7%** |
   | MRR | 0.883 | **0.911** |
   | nDCG@5 | 0.903 | **0.938** |

   Plus a literal-token fixture grade on 11 answers: **11/11 gold-memory recall@5**, **11/11 answers contain a developer-labelled EUR amount**, and **10/11 answers have complete EUR-labelled amount traceability**. These are deterministic token/provenance checks, not a general correctness or semantic-faithfulness estimate. → [BENCHMARK.md](./BENCHMARK.md)

3. **One memory core, exposed three ways, including a real MCP server.** The same injectable `MemoryAgent` is reachable over **REST**, a **Model Context Protocol server** ([`src/mcp/server.ts`](./src/mcp/server.ts), official `@modelcontextprotocol/sdk`, **stdio + Streamable HTTP**, four typed tools), and a **`qwen-plus` function-calling skills layer** ([`src/skills/`](./src/skills)). REST and `SkillDispatcher` are thin adapters over the same domain/store; MCP and Qwen skills share the dispatcher and typed schemas. → [MCP integration & custom skills](#mcp-integration--custom-skills)

## What we built

Archon MemoryAgent gives a small business's financial-intelligence pipeline a **memory**.

Every fused financial event, validation finding, and narrated insight is embedded with **Qwen `text-embedding-v4`** (Alibaba Cloud Model Studio / DashScope) and stored in a **pgvector** memory layer.

On any later run, whether it is a different session, a different process, or a fresh container, the agent **recalls the relevant prior facts by meaning** and grounds a **Qwen `qwen-plus`** answer in them. It reasons with continuity instead of starting cold on every request.

## Shipped product scope

This submission implements two concrete financial input paths:

- a document pipeline for a **payroll register + bank confirmation + payslips**, fused into one payroll event and validated with R1–R4; and
- a strict JSON contract for **purchase and sales invoices**, with explicit currency and idempotent retry semantics.

Over the resulting memories it produces a **currency-separated P&L** for payroll, purchases, sales, known/unknown cash movement, and net profit. Mixed currencies are never silently summed. The broader Archon product direction includes more document classes and metrics, but this entry does **not** claim shipped extraction for orders, receipts, general bank statements, EBITDA, or sales targets.

The MemoryAgent remembers the shipped events, findings, corrections, and insights across sessions and can answer later questions with citations.

## Where the memories come from

The MemoryAgent is the headline: it **recalls** grounded, cited answers and **self-audits** its own memory for cross-session contradictions. But an agent's memory is only as real as what feeds it, so this entry ships the **productized upstream** that produces those memories: a document-ingestion pipeline (`src/pipeline/`), ported from the Archon extraction + analysis agents.

```
scanned-image data URL · caller-extracted PDF text · text
              ──▶ Extractor (qwen-vl-max vision / qwen-plus text)   normalize each doc
              ──▶ Classifier      rule-based doc-type refinement (no LLM)
              ──▶ EventLinker     fuse the payroll triplet into one accurate event
              ──▶ Validator       R1–R4 cross-document consistency checks
              ──▶ P&L math        currency-separated payroll + invoice analytics
              ──▶ MemoryAgent.ingestEvent()   WRITE the fused event + findings to pgvector
```

A single payroll event is told by three documents that each carry a different slice
of evidence: the **bank confirmation**, the **payroll register**, and the
**payslips**. The pipeline reconciles their complementary fields, keeps source
provenance, computes currency-separated P&L, and hands the result to the
**unchanged** MemoryAgent to remember.

The pipeline is **supporting cast**: it exists to make the memory demonstrably fed by a real productization path. The agent core (recall, self-audit, consolidation, forgetting) is untouched; `POST /ingest/documents` runs the pipeline and writes through the same `ingestEvent()` the agent already exposed, and `GET /pnl` reads a P&L back **over the memories the agent holds**. Everything stays offline-testable: `qwen-vl-max`/`qwen-plus` are auto-selected only when `DASHSCOPE_API_KEY` is set, and a deterministic Fake extractor drives the whole path in CI (same seam as `FakeEmbedder`/`FakeNarrator`).

The concrete demo memories cover source-linked payroll evidence, purchase/sales
invoices, validation findings, and narrated insights. This financial context is a
bounded proof surface for the domain-neutral memory and audit core, not the product's
headline claim.

## Why this is a MemoryAgent

| Track requirement | How this entry meets it |
|---|---|
| **Persistent memory** | Memories are embedded and written to pgvector on Alibaba Cloud PostgreSQL, so they are durable rather than in-process. |
| **Queryable memory** | Recall is semantic ANN search (`ORDER BY embedding <=> $q`) over an HNSW cosine index, with `kind`/`company` pre-filters. |
| **Across sessions** | The headline e2e test (`tests/e2e/cross-session.test.ts`) proves it. Session A writes and tears down completely; a fresh session B, with no shared in-process state, recalls those memories and answers from them. The only thing shared is the database. |
| **Limited context windows** | Recall retrieves a bounded, relevant slice (`limit` is capped at 20) and narrates only from the returned, cited memories rather than replaying the whole store. |
| **Increasingly accurate over time** | Authenticated `POST /feedback` can protect a correct memory or atomically supersede an incorrect one with a high-importance correction; later recall uses the active corrected state. The release-bound evidence gate stores a Session-A correction and requires a fresh Session-B request to recall and cite it. This is explicit persisted feedback, not autonomous training or a model-weight update. |
| **Timely forgetting** | `POST /consolidate` and `POST /forget` provide tenant-scoped hygiene. Both require an operation id + explicit reason and preview by default; `confirm=true` is required before any mutation/deletion. Confirmed actor/reason/result provenance is persisted atomically and exact retries replay it. The final live proof requires exactly one feedback-superseded candidate previewed, exactly one audited deletion, protected state unchanged, and zero run-marker residue. |

## What makes the memory strong (not just present)

A MemoryAgent lives or dies on **recall quality** and **memory hygiene**. This entry treats both as first-class, engineered, and *measured*.

It also adds a capability most memory demos skip: the agent **audits its own memory**.

### ⭐ Self-auditing memory

A cross-session agent accumulates facts from many separate write events. Nothing stops two of them from **contradicting**.

Say session A records one value for an invoice field and a later session records a
different value for that same field. Plain recall just returns whichever ranked
higher and stays silent.

`POST /consistency` (`src/memory/consistency.ts`) does not. It scans the agent's own memories, groups them by the record they describe, and flags two things:

- **Cross-session contradictions**: same record and attribute, different value across write events.
- **Dangling references**: a memory points at a record that no memory stores.

It is a **pure, domain-neutral** engine, not a finance rulebook. And it is *measured*: on a labelled dataset it detects **5/5 injected problems with 0 false positives** on a consistent control set (100% precision).

This is memory you can *trust*, because it tells you when it disagrees with itself.

**It does more than detect: it recommends.** For every contradiction it recommends which side to trust:

```
resolution: { recommendedMemoryId, recommendedValue, rule, confidence, rationale }
```

The recommendation follows a fixed, domain-neutral priority ladder over signals already on the memories: **importance → source-authority → recency (later write wins)**.

It is a *recommender, not ground truth*. Its confidence is an uncalibrated ordinal heuristic. The pure audit **never mutates memory**, and its implementation conforms on **4/4 developer-labelled policy cases** (`npm run bench:resolution`); that proves the declared policy is implemented, not that its choice is universally correct.

**How the audit differs from existing memory layers:**

- Classic RAG and the pgvector default just **rank and return**.
- **Mem0** supports LLM-selected ADD / UPDATE / DELETE operations at write time; our pinned public-name probe found no separately named contradiction/resolution method, and the returned memory strings contained both conflicting values.
- **Zep / Graphiti** models temporal validity by updating graph state and invalidating stale edges over time.
- **Our audit never mutates.** It is a read-only, deterministic, domain-neutral pure function that surfaces the contradiction and hands back a *recommendation* with `rule + confidence + rationale` over a fixed importance → source-authority → recency ladder. A separate authenticated endpoint can atomically apply a human accept/override decision.

**Meaning-level contradictions, too**: `POST /consistency/semantic` ([`src/memory/semantic-consistency.ts`](./src/memory/semantic-consistency.ts)). The rule-based audit above compares metadata fields, so it is blind to memories that oppose each other in *meaning* while sharing no comparable key. The semantic audit reuses persisted vectors, applies a same-subject gate, and asks the configured `QWEN_JUDGE_MODEL` (`qwen-plus` rollback baseline) whether candidate pairs directly contradict. On the original developer-authored regression corpus, the deterministic offline judge **surfaces 9 contradictions** out of 10 labelled positives and scores **90% recall, 100% precision, 0 FP**. On the frozen 48-pair developer-labelled synthetic set, the immutable historical v1.1 artifact records three identical runs at **97.92% accuracy, 100% precision, 95.83% recall, 100% specificity, F1 97.87%**, with one inconclusive case per repetition caused by one recorded embedding failure whose frozen failed pair was reused. The v1.1 change fixed reporting only; dataset, labels, model, thresholds, calls and scoring were unchanged from v1. This is historical frozen-set evidence, not independent expert evaluation or a production sample, and its metadata records a dirty working tree and host-specific command. Final model promotion therefore uses the new clean-source, same-commit A/B protocol rather than treating v1.1 as release provenance. → [BENCHMARK.md](./BENCHMARK.md#meaning-level-semantic-self-audit--measured-on-a-labelled-set)

The claim is not "we detect and they cannot." It is **"the audit recommends without mutating, explainably and portably."** An explicit atomic human decision follows only when requested.

Full method and caveats: **[BENCHMARK.md](./BENCHMARK.md)**.

### Hybrid retrieval (dense + lexical, RRF) + a bounded listwise Qwen re-ranker

Agent memories are full of exact tokens that dense embeddings blur: document numbers (`INV-2043`, `PINV-771`), euro figures, company names, period codes.

Recall handles both meaning and exact tokens:

1. Fuse `text-embedding-v4` cosine search with BM25 / full-text lexical search using **Reciprocal Rank Fusion (RRF)**.
2. Refine the bounded candidate list in **one listwise `qwen-plus` call** that returns a complete score map. This is the actual candidate-set prompt behavior, not a dedicated pairwise reranking architecture.

### Measured against explicit baselines, with fixture-bounded claims

A frozen, labelled benchmark (`bench/`) scores retrieval with Recall@k / MRR / nDCG on **real `text-embedding-v4`**.

The `naive-vector` baseline is a real and common dense-only configuration, but it is not a product-wide baseline for every memory framework. All deltas below are limited to our **32-memory / 15-query synthetic financial fixture**.

On this fixture:

- **Hybrid is robust on this fixture.** Its Recall@3 and Recall@5 remain at least the dense condition on these 15 queries (Recall@3 90.0% → 93.3%) and it exceeds lexical-only here. CI gates only this disclosed fixture relationship.
- **Hybrid alone doesn't beat the dense condition on top-rank here**: the bounded listwise Qwen re-ranker does on this same fixture.
- **`reranked-hybrid` wins on top-rank** over dense: MRR **0.883 → 0.911**, nDCG@5 **0.903 → 0.938**, Recall@3 **90.0% → 96.7%**.

Reproducible offline from committed fixtures with no live provider call, **gated in
CI**, and shipped with a **sensitivity control**: a meaning-shuffled retriever that
must score near chance, proving the benchmark actually discriminates.

Full method and caveats: **[BENCHMARK.md](./BENCHMARK.md)**.

### A real head-to-head vs Mem0 (run), with Zep cited

We installed **Mem0 (`mem0ai==2.0.11`)** and drove it with the **same Qwen models and the same cross-session conflict pairs** our own audit is measured on (`bench/external/`). The immutable `mem0-evidence.json` is historical observed-fixture evidence; the v2 runner now uses unique non-overwritable attempts, clean-source/provider attestation, and source/data/protocol hashes.

The bounded comparison found:

- **Retrieval is at parity.** Mem0 put the gold figure in its top-5 on 5/5. We claim *parity, not a retrieval win*.
- **The pinned public-name probe matched no separately named contradiction/resolution method.** Its returned `memory` strings contained both disagreeing values. That narrow `dir()`/search observation is not a claim about undocumented, internal, differently named, or newer Mem0 behavior.

**Zep / Graphiti handles temporal contradiction through validity updates**: an older edge's validity window is closed while history remains queryable. We did not run it. The architectural difference is that our surface is a portable, read-only audit and recommendation over generic rows; this is not a claim that one approach is universally superior.

Full capability matrix + caveats: **[BENCHMARK.md](./BENCHMARK.md#head-to-head-vs-mem0-and-zep)**.

### Objective EUR-token and traceability checks on our own fixture

On 11 developer-labelled number-bearing questions, we replay one committed `qwen-plus` pass and grade **literal EUR-labelled token presence, not prose** (`npm run bench:accuracy`, gated in CI). The parser accepts `€` or `EUR` on either side of an amount, so a bare year or percentage cannot satisfy the monetary check:

- **Gold-memory recall@5: 100%**
- **Gold EUR-token answer hit rate: 11/11**: each answer contains its developer-labelled amount with an explicit EUR marker.
- **Complete EUR-labelled amount traceability: 10/11**: in ten answers every EUR-labelled amount also occurs, EUR-labelled, in a recalled memory.

Pinned narrow metrics: **gold EUR-token hit: 100.0% · complete EUR-labelled traceability: 90.9%**.

The one traceability miss is a *derived* amount (€2,800 = €41,200 − €38,400) that is not stored in any recalled memory. This historical answer fixture predates the current strict narrator amount/currency/citation guard, which now repairs or falls back instead of serving an unsupported amount. We retain the miss rather than rewriting old evidence. This narrow fixture check does not grade prose, truth, arithmetic validity, semantic equivalence, or general answer faithfulness.

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
  hits = rerank(qwen-plus, q, pool) one bounded listwise score-map call (optional)
  answer = qwen-plus(question, hits)   grounded, citing [n]

consistency(scope):                 ── the agent audits its OWN memory
  M = active memories in scope
  flag contradictions (same record, same attribute, different value / session)
  flag absences       (a memory references a record no memory stores)
```

## Required stack (all three, confirmed against the hackathon rules)

| Requirement | This entry |
|---|---|
| **Qwen models** | `text-embedding-v4` (1024-d embeddings) + `qwen-plus` (RAG narration, rerank, function calling) + a health-visible configured semantic judge (`qwen-plus` rollback baseline; candidate only after promotion) + `qwen-vl-max` (payroll-document vision extraction). |
| **Qwen Cloud / DashScope** | Called with the standard `openai` Node SDK through an allowlisted official Alibaba Model Studio endpoint. The default/last live baseline uses `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`; key = `DASHSCOPE_API_KEY`. |
| **Alibaba Cloud deployment** | The HTTP backend (`src/server.ts`) ships as a container (`Dockerfile`) and runs **live on Alibaba Cloud ECS** (`ecs.e-c1m2.large`, ap-southeast-1) via docker-compose, with the backend alongside a self-hosted **pgvector container** as the memory store. A **Function Compute + managed ApsaraDB RDS** path is also provided (`deploy/s.yaml`, `deploy/deploy-fc.sh`) as a serverless alternative. See [`deploy/`](./deploy). |

The semantic judge has its own `QWEN_JUDGE_MODEL` setting. A dated Qwen 3.7
candidate may be promoted there only after the clean same-commit A/B gate passes;
that setting does not change `QWEN_MODEL` narration, reranking, text extraction,
or any embedding/vision model.

Production and deploy preflight share one normalized endpoint policy in
[`src/qwen/client.ts`](./src/qwen/client.ts): HTTPS, the exact
`/compatible-mode/v1` path, no credentials/query/fragment, and only the
[documented shared or workspace-dedicated Model Studio hosts](https://www.alibabacloud.com/help/en/model-studio/base-url).
Trial, Token Plan, Coding Plan, and arbitrary OpenAI-compatible proxies fail
closed. Keyed promotion evidence is stricter still: its versioned protocol is
pinned to the shared international host and never records a workspace ID.

## Architecture

The **MemoryAgent is the centre** (recall + self-audit). The document-ingestion **pipeline is the supporting upstream** that *produces* the memories the agent remembers.

In standard-pattern terms this is three well-understood pieces, not a novel framework: an **agent** (the recall/RAG loop over persistent memory), **MCP** in its canonical role as the coordination + context-sharing standard, and self-audit workflows over the agent's stored state. The field-level audit is deterministic; the separate meaning-level audit uses the configured `QWEN_JUDGE_MODEL` online and a deterministic polarity judge offline. Both remain read-only and return reproducible provenance/status rather than silently editing memory. This Track-1 product stops at the memory boundary: it does not approve invoices, schedule payments, or execute accounts-payable actions. A separate submission may consume memories as an input, but shares neither this entry's user journey nor its judged core capability.

```mermaid
flowchart TB
    Agent["AI agent / HTTP caller"]
    Docs["Payroll evidence<br/>(scanned image · PDF-extracted text · text)"]
    MCPClient["MCP client: Claude Desktop / IDE / agent"]

    subgraph ECS["Alibaba Cloud · ECS ap-southeast-1 · docker-compose"]
        direction TB
        subgraph API["backend container: Fastify · src/server.ts"]
            direction LR
            H["Public health / schema<br/>GET /health · /ready · /docs"]
            I["Authenticated tenant writes<br/>/ingest · /feedback · lifecycle"]
            R["Public-tenant reads<br/>/recall (quota) · /pnl · rule audit"]
            C["Authenticated heavy audit<br/>/consistency/semantic"]
        end
        subgraph PIPE["Ingestion pipeline: src/pipeline (supporting cast)"]
            direction LR
            EX["Extractor<br/>(qwen-vl-max / qwen-plus)"]
            CL["Classifier"]
            EL["EventLinker<br/>company + period + event_ref"]
            VA["Validator R1–R4"]
            PN["Currency-separated P&amp;L<br/>mixed totals never combined"]
            EX --> CL --> EL --> VA --> PN
        end
        subgraph MCPSURF["MCP surface: src/mcp/* + src/skills/*"]
            direction LR
            MT["4 MCP tools<br/>recall · ingest · audit(+semantic) · count"]
            SK["SkillDispatcher (shared)<br/>+ qwen-plus function-calling skills"]
        end
        MA["★ MemoryAgent: embedder · store · narrator (all injectable)<br/>ingestEvent → remember() · recallAnswer → recall() → narrate()<br/>+ self-audit (contradictions · dangling refs)"]
        DB["pgvector container · PostgreSQL: THE MEMORY<br/>agent_memory(embedding vector(1024)) + HNSW cosine index<br/>recall = ORDER BY embedding &lt;=&gt; $query"]
    end

    subgraph QWEN["Model Studio / DashScope: Qwen Cloud"]
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

Judge-facing 16:9 submission hero: [`demo/final-media/judge-architecture.jpg`](./demo/final-media/judge-architecture.jpg), with editable source [`docs/judge-architecture.svg`](./docs/judge-architecture.svg). The dense technical appendix remains available as [`docs/architecture.svg`](./docs/architecture.svg) / [`docs/architecture.png`](./docs/architecture.png), from [`docs/architecture.mmd`](./docs/architecture.mmd).

Both surfaces, the HTTP routes and the MCP tools / custom skills, go through the **same injectable `MemoryAgent`** via the shared `SkillDispatcher`. There is one implementation of recall / ingest / audit / count, exposed three ways (REST, MCP, and Qwen function-calling), so the protocol layer never duplicates the memory logic.

**Live deployment** = ECS + docker-compose (backend + pgvector container). Because the store is pg-wire, the identical code runs unchanged on a managed ApsaraDB RDS / AnalyticDB for PostgreSQL instance (the Function Compute alternative in `deploy/`).

**Offline / CI:** no `DASHSCOPE_API_KEY` → deterministic Fake embedder, narrator, reranker, semantic judge, and extractor; pgvector runs as a docker service for DB-backed CI slices. Same interfaces, zero cloud credentials. Production does not silently use this mode.

### Write path (`remember`)

An agent states a fact in natural language. For example:

> *"Payroll event for ByteCraft Software 2026-05 reconciled from a source-linked register and bank confirmation."*
>
> *"Purchase invoice PINV-771 from Pallas Freight: payment status remains unknown."*

Qwen `text-embedding-v4` embeds it. The text, structured metadata, and the 1024-dim vector are then stored in `agent_memory`.

### Read path (`recall` → `narrate`)

A question is embedded and run as an ANN search over the HNSW cosine index (`ORDER BY embedding <=> $query`).

The top-k memories are handed to the **narrator** (`qwen-plus`), which writes a grounded answer that **cites the exact memories** it used. It is RAG over the agent's own persistent memory.

## The memory store: decision and tradeoff

**Chosen: pgvector on PostgreSQL, running on Alibaba Cloud.**

The live deployment self-hosts the `pgvector/pgvector` container on an ECS instance, alongside the backend, via docker-compose. Because it is pg-wire, the identical `pg` driver + SQL also runs against a managed **ApsaraDB RDS / AnalyticDB for PostgreSQL** instance with the `pgvector` extension (the Function Compute alternative in [`deploy/`](./deploy)).

**Why the ECS + pgvector-container topology for the live box:**

- It delivers a single, always-reachable public URL on Alibaba Cloud fastest and most reliably, without FC↔RDS VPC wiring or ACR console steps in the critical path.
- Because the store is pg-wire, the same `pg` driver + SQL runs unchanged across local docker, CI, and production.
- It stands up a real vector index in CI with **zero Alibaba credentials** (stock `pgvector/pgvector` docker).
- It is the best Alibaba-narrative × short-deadline tradeoff. The managed-RDS + Function Compute path is a drop-in `DATABASE_URL` swap.

**Consciously deferred alternative:** Alibaba's fully-managed **DashVector** (or **Tair** vector) is an arguably *stronger pure-Alibaba* story. But it is a new non-pg API that needs its own offline test double, which was the wrong trade at this deadline. The `MemoryStore` interface (`src/memory/store.ts`) is the seam a `DashVectorStore` would slot into next, with no change to the agent.

## Repository layout

```
archon-qwen-memoryagent/
├── src/
│   ├── qwen/client.ts          # OpenAI-compatible Qwen/DashScope client + injectable seams
│   ├── memory/
│   │   ├── embeddings.ts        # QwenEmbedder (text-embedding-v4) + offline FakeEmbedder
│   │   ├── retrieval.ts         # BM25 + cosine + RRF + MMR + hybrid + rerank retrievers (pure)
│   │   ├── rerank.ts            # bounded listwise Qwen re-rank + offline FakeReranker
│   │   ├── consistency.ts       # SELF-AUDIT: cross-session contradiction + dangling-ref DETECT + RESOLVE (pure)
│   │   ├── semantic-consistency.ts # SELF-AUDIT (meaning): embedding-gated + configured Qwen/offline judge, read-only
│   │   ├── consolidation.ts     # consolidate (dedup) + forget planners (pure)
│   │   ├── store.ts             # MemoryStore: PgVectorStore + InMemoryStore (hybrid + lifecycle + audit)
│   │   └── memory.ts            # remember() / recall(): embed ↔ store orchestration
│   ├── agents/
│   │   ├── narrator.ts          # QwenNarrator (qwen-plus RAG) + offline FakeNarrator
│   │   └── memory-agent.ts      # MemoryAgent: ingestEvent · recallAnswer · auditConsistency · auditSemanticConsistency · consolidate · forget
│   ├── pipeline/                # document-ingestion pipeline (supporting cast): extractor · classifier · event-linker · validator · pnl · vision
│   ├── mcp/{server.ts,tools.ts}   # Model Context Protocol server: the four memory tools over stdio + Streamable HTTP
│   ├── skills/                  # qwen-plus function-calling skills + shared SkillDispatcher (schemas = single source of truth)
│   ├── db/{client.ts,schema.sql}  # pg pool + pgvector schema (vector(1024) + HNSW + FTS + lifecycle)
│   ├── types.ts                 # PayrollEvent domain types
│   └── server.ts                # Fastify HTTP backend (the Alibaba Cloud deploy target)
├── bench/                        # frozen retrieval + accuracy + consistency datasets, metrics, runners, committed fixtures (embeddings + re-rank + answers)
│   └── external/                 # real head-to-head vs Mem0 (mem0ai): export + harness + committed evidence
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
git clone https://github.com/upgradedev/archon-qwen-memoryagent.git
cd archon-qwen-memoryagent
cp .env.example .env
# Generate two different URL-safe DB secrets plus a judge secret, then edit .env:
#   POSTGRES_PASSWORD=<bootstrap-only password>
#   MIGRATION_DATABASE_URL=postgresql://memoryagent_admin:<bootstrap password>@db:5432/memoryagent
#   MEMORY_APP_DB_PASSWORD=<independent runtime password>
#   DATABASE_URL=postgresql://memoryagent_app:<runtime password>@localhost:5432/memoryagent
#   COMPOSE_DATABASE_URL=postgresql://memoryagent_app:<runtime password>@db:5432/memoryagent
# Also set JUDGE_API_KEY (32+ chars). DASHSCOPE_API_KEY may stay empty only for
# local Fake-backed development; production requires real Qwen.
set -a; . ./.env; set +a
npm ci

# 1. Start pgvector, then run the admin-only schema/grant job. It exits after
# provisioning the fixed non-superuser runtime role; no admin DSN reaches backend.
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build db-init
npm run db:verify-role

# 2. Run the end-to-end agent-memory demo (write fused events, recall by meaning)
npm run memory:demo

# 3. Run the HTTP backend
npm start                       # open http://localhost:9000

# 4. Reproduce the benchmarks (offline replay; no live provider call)
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
| `GET /health` | Public | Liveness; reports embedder, narrator, and semantic-judge model ids + dimension. |
| `GET /ready` | Public | Cheap readiness: probes database/schema and verifies real-Qwen/auth configuration without calling a model. |
| `GET /ready/deep` | Authenticated; admission + durable quota | Cached end-to-end readiness: database + one real embedding + one grounded/cited narration probe (10-minute success / 60-second failure cache). Only a cache-miss/in-flight owner acquires provider capacity and reserves 3 work units; hits/followers do neither. |
| `GET /memory/count` | Public tenant, or credential tenant | Count memories in the server-selected tenant. |
| `GET /memory/list` | Public tenant, or credential tenant | `?company=&kind=&limit=` → recent `{ id, kind, company, period, snippet, createdAt }` rows. |
| `POST /demo/seed` | Public fixed payload; ingest quota | Idempotently seed the built-in payroll + field/meaning contradiction demo. It accepts no caller-controlled memory content. |
| `POST /ingest` | Authenticated; ingest quota | `{ event }` → tenant-scoped memories for a fused payroll event. |
| `POST /ingest/invoice` | Authenticated; ingest quota | Currency-explicit purchase/sales invoice. Exact retries are idempotent; a changed payload for the same logical invoice returns `409`. |
| `POST /ingest/documents` | Authenticated; ingest quota | Payroll evidence pipeline over scanned-image data URLs, PDF-extracted text, or text (Extractor → Classifier → EventLinker by company/period/event_ref → Validator → P&L). Default mode commits each fused event's memories as one tenant-scoped atomic batch; a multi-event request is not advertised as one transaction. With strict boolean `dryRun=true`, the same protected/provider/admission/quota path executes extraction through P&L, returns `written=0`, `memoryIds=[]`, and `extractionModels`, and performs no memory write. The aggregate JSON body is capped at 10 MiB by default (`MAX_JSON_BODY_BYTES`); decoded images and text have stricter extraction limits. |
| `GET /pnl` | Public tenant, or credential tenant | `?company=&period=` → payroll + purchase/sales-invoice P&L. `currency_status` and `by_currency` prevent mixed-currency totals. |
| `POST /recall` | Public tenant, or credential tenant; recall quota | Grounded, cited answer (hybrid + rerank by default) plus best-effort self-audit over recalled memories. |
| `POST /feedback` | Authenticated; incorrect correction uses ingest quota | Protect a correct memory or atomically supersede an incorrect one with a high-importance correction. |
| `POST /consistency` | Public tenant, or credential tenant | Deterministic field-level contradictions + dangling references, each with a read-only recommendation. |
| `POST /consistency/semantic` | Authenticated; semantic quota | Meaning-level contradiction audit using stored embeddings + configured Qwen judge online (offline judge in CI). Read-only. |
| `POST /resolve-conflict` | Authenticated | Atomically and idempotently protect the reviewer-selected existing carrier and supersede every other active carrier; requires `decisionId` and an explicit reason and records server-derived actor/reason provenance. |
| `POST /consolidate` | Authenticated | Preview near-duplicate consolidation by default; `confirm=true` applies it. Every call requires an explicit `operationId` + reason; confirmed retries replay the persisted audit result and changed reuse conflicts. |
| `POST /forget` | Authenticated | Preview tenant-scoped retention by default; `confirm=true` is required to delete. Every call requires an explicit `operationId` + reason; confirmed retries replay the persisted audit result and changed reuse conflicts. |

**Currency contract.** Invoice currency is mandatory and must be a supported ISO 4217 code. Payroll currency is evidence-derived when present; records without supported currency evidence are counted in `unknown_currency_records` but excluded from monetary aggregation. They are never silently treated as EUR or combined through an `UNSPECIFIED` pseudo-currency. With one fully evidenced currency, top-level monetary totals are populated. With mixed or unknown currency evidence, `currency_status` exposes the condition, top-level monetary totals are `null`, and `by_currency` carries only complete independent evidenced-currency totals. Purchase cash can be `unpaid`, `partial`, `paid`, `refund`, or `unknown`; unknown paid amounts are reported separately rather than guessed.

**Local Fakes vs production.** With no `DASHSCOPE_API_KEY`, local development and tests use deterministic Fake clients while still exercising the pgvector path. In `NODE_ENV=production`, Qwen-heavy routes fail closed when only Fakes are available (unless the explicit non-qualifying `ALLOW_FAKE_QWEN=true` override is set), and `/ready` does not report ready. A qualifying live deployment therefore requires real Qwen.

**Auth, tenant isolation, and provider-operation bounds.** The no-login judge path is intentionally limited to the fixed public demo and public-tenant reads. Production mutations, feedback, lifecycle operations, deep readiness, and the semantic audit require `Authorization: Bearer …` or `x-api-key`; the matched credential selects the tenant server-side, so a request cannot choose another tenant. A coarse per-client limiter bounds the complete HTTP surface at **300 requests/minute** by default (`HTTP_RATE_LIMIT_MAX`), including readiness and database-only reads. Qwen-heavy routes additionally use atomic UTC-daily per-subject/IP plus global **work-unit** pools: recall defaults to **200 / 2,000**, ingest (including seed) to **100 / 500**, semantic audit to **500 / 2,500**, and authenticated deep readiness to **30 / 300**. Work units are disclosed preflight policy weights for logical model operations: REST/MCP recall reserves **4** worst-case operations (query embedding + rerank + draft narration + one bounded citation repair), document ingestion reserves a fixed **5 per document** to stop batch amplification, semantic audit reserves its requested bounded pair fan-out, and only the deep-readiness cache-miss/in-flight owner reserves **3** (embedding + narration + bounded citation repair); transport retries do not create additional logical reservations, and hits/followers reserve zero. Malformed MCP calls are rejected before reservation. Database-only reads such as count, list, P&L, and field-level audit reserve no Qwen work units. Invalid credentials fail rather than falling back to the public tenant.

**Database least privilege.** `POSTGRES_*` initializes the local bootstrap owner and
`MIGRATION_DATABASE_URL` is consumed only by the one-shot `db-init` service.
That job applies the schema, removes `PUBLIC` database/schema access, and grants
the fixed `memoryagent_app` role only `CONNECT`, schema `USAGE`, table DML, and
sequence use, but never ownership, DDL, `TRUNCATE`, temporary tables, role creation,
or database creation. The long-lived backend receives only its runtime
`DATABASE_URL`. `npm run db:verify-role` proves the positive DML boundary and,
for every production redeploy, requires `CROSS_APP_DATABASE_NAME` and an ACL/authentication
denial against the neighbouring app database before deployment proceeds.

The Explorer exposes a password-type **Reviewer token (protected audit/feedback)** field and a **Run bounded Qwen insight scan** button for the protected judge path. The UI sends the selected company, `kind: "insight"`, and `maxPairs: 1`, then labels the result as an at-most-one-pair scan. This judge-facing bound is narrower than the general semantic API/MCP default and reserves one semantic work unit per attempt. Paste only the dedicated credential supplied in Devpost testing instructions; clear it before screenshots/recording cuts and never place it in source, URLs, posts, or public video descriptions. The entrant must verify the form field's actual visibility and rotate/revoke the low-privilege credential after judging.

### Resilience

A live model service will blip; the memory layer should not fail with it. Three measures keep `/recall` and `/ingest` responsive when Qwen (DashScope) is slow or unreachable:

- **Bounded model calls.** Every call to DashScope goes through one OpenAI-compatible client configured with a **per-request timeout** (`QWEN_TIMEOUT_MS`, default 20s) and a small **automatic retry budget** (`QWEN_MAX_RETRIES`, default 2). Without these, a single upstream stall would hang a recall until the socket eventually gave up, which is the exact failure a judge would see mid-demo. Both are env-tunable.
- **Graceful narrator degradation.** By the time the answer narrator (`qwen-plus`) runs, the memories have **already been retrieved** from pgvector. So if narration fails, the recall is not thrown away: `/recall` still returns the retrieved memories as citations plus a plain fallback answer composed from them, with a degraded status explaining that the narrator is unavailable and raw recalled memories are being returned. The result is soft, still useful, and still grounded instead of a hard 500. (Retrieval itself needs the query embedding, so an *embedder* outage surfaces as a clear error rather than a silent empty answer: you cannot recall without the query vector.)
- **Structured error envelope and safe operator log.** A Fastify `setErrorHandler` turns any unhandled server-side fault into an opaque **503** carrying `requestId` + `errorId`, never an exception message or stack. The correlated operator event records only a fixed failure category and registered route, because exception messages/stacks can themselves contain credentials, connection URLs, provider payloads, or host paths. Client mistakes keep their own `4xx` (the request-validation guards are unaffected).

All three are covered by offline unit tests (timeout/retry config, the degraded-recall path, and the 503-vs-preserved-4xx envelope), with no key and no network.

## MCP integration & custom skills

Beyond the REST API, the same memory is exposed two more ways: a **Model Context Protocol (MCP) server** and a **Qwen function-calling custom-skills layer**. MCP and the Qwen skills loop share one `SkillDispatcher` ([`src/skills/dispatcher.ts`](./src/skills/dispatcher.ts)) and the same typed schemas; REST is a separate thin adapter over the identical injectable `MemoryAgent` and store. There is one domain implementation, not one universal transport code path.

### The four skills / MCP tools

| Skill / MCP tool | Args | What it does |
|---|---|---|
| `recall_memory` | `{ question, company?, kind?, limit? }` | Hybrid semantic recall → Qwen-narrated **grounded, cited answer** + a best-effort self-audit (same path as `POST /recall`). |
| `ingest_memory` | `{ content, kind, company?, period?, sourceRef?, metadata? }` | Embeds (`text-embedding-v4`) and writes a single fact into persistent memory. |
| `audit_memory` | `{ company?, period?, kind? }` | Read-only cross-session **self-audit**: contradictions (with a resolution recommendation) + dangling references. |
| `memory_count` | `{ company? }` | How many memories the agent holds. |

There are exactly **four skills/tools**, while `kind` is a separate validated six-value JSON-Schema enum: `document | payroll_event | validation | insight | invoice | action`. Both an MCP client and qwen-plus therefore get a sharp typed choice, not free text.

### 1. MCP server ([`src/mcp/server.ts`](./src/mcp/server.ts))

A real MCP server built on the official `@modelcontextprotocol/sdk`. **stdio** is the trusted local-process transport used by desktop MCP clients; optional **Streamable HTTP** is the authenticated network transport (`MCP_TRANSPORT=http`, default port `9100`, endpoint `/mcp`). Serverless runtimes reject stdio and must use Streamable HTTP.

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

**Stdio is trusted, not unmetered.** Its operator-selected `MCP_STDIO_TENANT_ID` is the quota subject. Provider-backed tools share the same process admission controller and atomic PostgreSQL `mcp:judge:*` per-tenant/global UTC-daily quota namespace as authenticated remote MCP. The shared fail-safe classifier reserves worst-case logical model operations, `recall_memory=4`, `ingest_memory=1`, and semantic `audit_memory=25` (the fixed bounded default pair fan-out); `memory_count`, rule-only audit, and protocol discovery reserve zero work units. Transport retries are not counted as new logical operations, and canonical tool validation happens before reservation so malformed calls consume no quota. Results are projected to text-only MCP blocks and capped by `MCP_STDIO_MAX_RESULT_BYTES` (256 KiB default); operational failures expose only a correlation id. Any stdio session using real Qwen requires `DATABASE_URL`, so spawning another process cannot replace the durable quota with a fresh in-memory counter. `NODE_ENV=production` additionally requires explicit `MCP_STDIO_ENABLED=true`, real Qwen credentials, and an explicit stdio/judge tenant. This is an operator opt-in, not remote authentication, and whoever can launch the process retains that tenant's four-tool authority.

**Remote clients.** Streamable HTTP is deliberately **always authenticated and fail-closed**: configure `MCP_API_KEY` + `MCP_TENANT_ID` (or let it reuse `JUDGE_API_KEY` + `JUDGE_TENANT_ID`), terminate TLS at the trusted edge, and send Bearer or `x-api-key` credentials. The credential selects the tenant server-side; provider-backed calls share the authenticated MCP quota pool described above.

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

The same skills are handed to **`qwen-plus` as OpenAI-compatible function tools**, so the model itself decides which memory operation to call. `runSkillLoop()` runs the standard tool-calling cycle: the model proposes a skill call → the `SkillDispatcher` executes it against memory → the result is fed back → the model continues until it produces a final grounded answer. This is the agentic counterpart to the REST API: instead of a caller choosing an endpoint, qwen-plus chooses a skill.

Both surfaces are covered by offline unit tests ([`tests/unit/mcp.test.ts`](./tests/unit/mcp.test.ts) exercises the server over the real MCP protocol via the SDK's in-memory transport + a `Client`; [`tests/unit/skills.test.ts`](./tests/unit/skills.test.ts) exercises the dispatcher and the function-calling loop with a canned client) plus focused stdio admission/quota/runtime/sanitization security tests in [`tests/security/mcp-stdio-boundary.test.ts`](./tests/security/mcp-stdio-boundary.test.ts), with no network, no key, and no DB.

## Deploy to Alibaba Cloud

### Live path: ECS + docker-compose (backend + pgvector container)

This is how the entry runs on Alibaba Cloud: a single ECS instance (`ecs.e-c1m2.large`, ap-southeast-1) runs docker-compose with the backend container plus a self-hosted `pgvector/pgvector` container as the memory store, behind one public URL. Exact runtime source [`104a002820607c754d857473877da28b69ebb44d`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/104a002820607c754d857473877da28b69ebb44d) passed the project-contained exact-deploy controller on 2026-07-16, including immutable checkout, image build, schema/grants, cross-application denial, real-Qwen readiness, grounded recall and zero-residue cleanup. [`deploy/DEPLOY_STATE.md`](./deploy/DEPLOY_STATE.md) is the authoritative release record; final gallery/video capture must bind to that SHA and its retained controller evidence.

[`deploy/redeploy.sh`](./deploy/redeploy.sh) is the schema-first redeploy helper. [`deploy/DEPLOY_STATE.md`](./deploy/DEPLOY_STATE.md) records the exact source candidate and secret-safe release contract. Public `/ready` and real-model `/health` prove endpoint readiness, not source identity; exact checkout/build plus the final smoke in [`demo/FINAL_MEDIA_CHECKLIST.md`](./demo/FINAL_MEDIA_CHECKLIST.md) must attest the candidate before recording.

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

Set the PostgreSQL credentials/URLs, `DASHSCOPE_API_KEY`, `DASHSCOPE_BASE_URL`,
`QWEN_JUDGE_MODEL`, and a long random `JUDGE_API_KEY`/tenant mapping via the
compose environment. Never commit them. Keep the judge at `qwen-plus` unless a
new candidate passes the versioned A/B promotion gate. Production is fail-closed:
a qualifying box must use real Qwen through an allowlisted official Alibaba
Model Studio endpoint, authentication enabled, and `/ready`
returning `200`; deterministic Fakes are for local/CI only.

### Alternative: Function Compute + managed RDS (serverless)

For a fully-serverless topology, the same container deploys to Alibaba Cloud Function Compute (custom-container HTTP function) with a managed **ApsaraDB RDS / AnalyticDB for PostgreSQL** memory store. See [`deploy/deploy-fc.sh`](./deploy/deploy-fc.sh) and [`deploy/s.yaml`](./deploy/s.yaml).

```bash
# Prereqs: Alibaba Cloud account + ACR namespace (same region), Serverless Devs (`s`)
REGION=ap-southeast-1 ACR_NAMESPACE=<your-ns> \
  ACR_REGISTRY=registry.ap-southeast-1.aliyuncs.com \
  bash deploy/deploy-fc.sh
# → builds linux/amd64 image, pushes to ACR, deploys the FC function, prints the HTTP URL
curl <trigger-url>/health
```

Because the store is pg-wire, switching between the two is a `DATABASE_URL` swap with no application change.

## Proof of Alibaba Cloud Deployment

This backend's qualifying path runs on **Alibaba Cloud ECS**. Two halves of proof:

**1. Runtime proof image**: only after [`deploy/DEPLOY_STATE.md`](./deploy/DEPLOY_STATE.md) turns green for the current source candidate, generate the app-specific canonical PNG at `demo/gallery/10-alibaba-runtime-proof.png` from that verified live deployment. It must show the MemoryAgent ECS process/container, `/ready`, `/health`, and this app's HTTPS URL in one sanitized composite; never reuse another entry's proof. Keep raw console captures only in ignored `demo/private-originals/`.

```text
$ aliyun ecs DescribeInstances --RegionId ap-southeast-1 --InstanceIds "['<redacted-instance-id>']"
  Region: ap-southeast-1   Status: Running

$ curl https://memory.43.106.13.19.sslip.io/ready
  {"status":"ready","checks":{"database":"ok","qwen":"configured","judgeAuth":"configured"}}

$ curl https://memory.43.106.13.19.sslip.io/health
  {"status":"ok","embedder":"text-embedding-v4","narrator":"qwen-plus","embedDim":1024}
```

**2. Code that uses Alibaba Cloud services & APIs**: direct links:

| Alibaba Cloud service | Code file | What it does |
|---|---|---|
| **ECS** (live deploy) | [`deploy/redeploy.sh`](./deploy/redeploy.sh) | Syncs source and (re)starts the docker-compose stack (backend + pgvector container) on the ECS instance behind one public HTTPS URL. |
| **Function Compute** (serverless alternative) | [`deploy/s.yaml`](./deploy/s.yaml) | Serverless Devs spec for the custom-container HTTP function + managed ApsaraDB RDS memory store. |
| **Model Studio / DashScope** (Qwen inference) | [`src/qwen/client.ts`](./src/qwen/client.ts) + [`src/pipeline/vision.ts`](./src/pipeline/vision.ts) | OpenAI-compatible client used for `text-embedding-v4`, `qwen-plus` narration/rerank/skills, the independently configured semantic judge, and `qwen-vl-max` vision extraction. |

Full proof doc with every service mapping: [`demo/ALIBABA_PROOF.md`](./demo/ALIBABA_PROOF.md).

## Testing & CI

The authoritative test and coverage values are the current CI artifacts, not a hand-copied count in this document. Qwen/Alibaba credentials are not needed for offline CI; deterministic Fakes and committed fixtures exercise the model seams without external provider calls, while PostgreSQL integration slices run when `DATABASE_URL` is supplied.

`scripts/test-matrix.ts` is the single source of truth for the test files in every tier. The npm scripts and hosted c8 job use the same runner; a docs/supply-chain fitness test fails if a test file is unregistered, duplicated, or if CI bypasses the canonical 80% statements/branches/functions/lines gate. The coverage job supplies real pgvector, applies the schema, and verifies the DML-only runtime role before running unit, integration, security, and E2E suites serially under c8.

| Tier | File(s) | What it proves |
|---|---|---|
| **Unit** | `tests/unit/*` | Embedder + narrator (Qwen canned + Fake), memory logic, **retrieval primitives** (BM25, RRF, MMR, hybrid, **re-rank**), **IR metrics**, **consolidation + forgetting**, **self-audit consistency** (contradiction + absence detection, precision on a control set), and the **MCP server + custom-skills layer** (`mcp.test.ts` drives the server over the real MCP protocol via the SDK in-memory transport; `skills.test.ts` covers the dispatcher + qwen-plus function-calling loop), all over `InMemoryStore`, no infra. |
| **Integration** | `tests/integration/*` | Real pgvector SQL and pipeline writes: `::vector` insert, `<=>` cosine recall, filters, count, hybrid dense+FTS fusion, idempotency, and consolidate → supersede → forget. These tests skip explicitly when no real DB is supplied. |
| **E2E** | `tests/e2e/*` | **Cross-session persistence** (session A writes + tears down, session B recalls) plus a broad **offline journey suite** (`full-journey.test.ts` + http / mcp / templates / robustness): seed → recall → cited answer → rule-audit → semantic-audit → MCP round-trip → P&L → provenance, and the error/edge journeys (empty store, no-contradiction, judge-guide chips). Exact executed/skipped counts come only from the final immutable CI artifact. |
| **Security (pen-test)** | `tests/security/*` | Automated app-security suite over the real HTTP + MCP surface: **authorization + daily provider-operation quota** (429 when exhausted), **prompt-injection resistance** (a genuine contradiction is still flagged despite an injected "report consistent" instruction; the read-only audit is unswayable), **MCP tool-boundary / excessive-agency** (reads never mutate; unknown tools fail safe; no prototype pollution), **sensitive-data exposure** (no stack/path/secret leaks), and **store-injection** (a `DROP TABLE` payload and NaN/Inf embeddings stay inert). Runs as the `pen-test` CI job; the SQL-parameterization case runs against real pgvector. |
| **Production image supply chain** | [`.github/workflows/supply-chain.yml`](./.github/workflows/supply-chain.yml); [`docs/SUPPLY_CHAIN.md`](./docs/SUPPLY_CHAIN.md) | Builds and constrains the exact production image, emits retained Syft/SPDX 2.3/CycloneDX SBOMs, then scans the sealed inventory with byte-pinned Grype tooling and a byte-pinned advisory snapshot. Every high/critical finding fails, including no-fix findings; there is no current allowlist. Results are dated evidence, not a security certification. |
| **Benchmark gates** | `bench/*` | Retrieval regression/discrimination on the 32-memory/15-query fixture; 11/11 developer-labelled gold EUR-token hits and 10/11 complete EUR-labelled amount traceability; developer-authored field/semantic regression sets; the 48-pair synthetic semantic stability gate; and structural + declared-policy conformance checks. Re-rank and pinned Mem0 deltas are reported, not generalized. |
| **Load / performance** | `load/recall-load.js` (k6); [published live result](./load/RESULTS_2026-07-15.md) | Drives concurrent `/health` + `/recall` + `/consistency` and asserts **p95 latency + error-rate SLOs** as k6 thresholds (the run fails on a regression). Two profiles: an **offline smoke** that runs on **every push** via the `load` CI job (boots the backend on deterministic Fakes against a real pgvector, seeds, then holds tight local SLOs with no external model call), and a manual, arrival-rate-bounded `load-test` workflow that exercises the **live box** (real Qwen) without overrunning its production HTTP or Qwen quotas. |

CI stages:

1. **secret-scan**: gitleaks (pinned v8.18.4, redacted). Fails fast on any committed secret.
2. **dep-audit**: `npm audit` (fails on high/critical).
3. **build-test**: typecheck → schema apply (stands up real pgvector) → unit → integration → e2e → offline demo smoke.
4. **coverage**: `npm run coverage` runs the canonical unit + integration + security + E2E matrix serially under c8 against real pgvector and gates statements, branches, functions, and lines at ≥ 80%.
5. **benchmark**: retrieval regression + discrimination, literal gold-EUR-token/traceability checks, field and semantic regression sets, the 48-pair online synthetic semantic evidence set, scale/lifecycle invariants, and contradiction-resolution policy conformance. All offline gates replay committed fixtures without a live provider call.
6. **pen-test**: `npm run test:security` (authz + daily provider-operation quota, prompt-injection resistance, MCP tool-boundary, sensitive-data exposure, SQL-parameterization against real pgvector).
7. **load**: boots the backend offline, seeds, runs the bounded k6 smoke; the p95 + error-rate **SLO thresholds gate the job**.
8. **readiness**: `npm run readiness -- --gate`: the weighted rubric completeness (≥ 95%) **and** the new **assurance dimension** (security / load / e2e layers all wired) must both be green.
9. **CodeQL** (`.github/workflows/codeql.yml`): SAST for the TypeScript source.
10. **Production Image Supply Chain** (`.github/workflows/supply-chain.yml`): exact production-image runtime check, retained SPDX/CycloneDX SBOMs, and a no-ignore high/critical Grype gate bound to a dated immutable database snapshot.

Application tests and benchmarks need no DashScope / Alibaba credentials: the
Qwen seams use deterministic Fakes or committed fixtures. Supply-chain jobs use
network access only to fetch exact release archives, npm lock artifacts, and the
reviewed vulnerability snapshot; their byte identities are verified before use.

### Load SLOs

The k6 thresholds are the contract: a run **fails** if any is breached. The offline CI smoke (`OFFLINE=true`, deterministic Fakes over real pgvector) holds the tight local targets; the manual live-box run holds the looser real-Qwen targets.

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
| **Innovation & AI Creativity (30%)** | **Self-auditing memory that recommends without mutating**, with a separate authenticated human Accept / Override / Defer loop. Developer-authored evidence covers 5/5 field problems, 4/4 declared-policy conformance, the original semantic regression set, and a broader 48-pair stress set that retains all hard misses. Qwen use spans embedding, narration, reranking, semantic judgement, function calling and vision. |
| **Problem Value & Impact (25%)** | A real SMB risk: durable financial facts and corrections must remain queryable without hiding conflicts. The shipped proof uses payroll evidence plus purchase/sales invoices, currency-separated P&L, cited recall, and explicit correction/forgetting, not unimplemented order/receipt/EBITDA claims. |
| **Presentation & Documentation (15%)** | This README + architecture diagram + [BENCHMARK.md](./BENCHMARK.md) (method + honest caveats) + [JUDGE_REVIEW.md](./demo/JUDGE_REVIEW.md) (rules check & strict review) + the interactive `/docs` API explorer + the ~3-min demo + the live Alibaba URL. |

## Provenance / reuse

**Reused/pre-existing boundary:** this entry carries forward the Archon name and
product context, and ports the upstream extraction/analysis pipeline patterns
explicitly identified above. Those reused elements are supporting context, not
evidence that the judged memory capability is new.

**Contest-entry boundary:** the work recorded here for the judged capability is
the Qwen/Alibaba-backed MemoryAgent core: persistent `MemoryStore`/pgvector,
embedding/recall/rerank/narration seams, field and meaning-level self-audit,
human conflict resolution, consolidation/forgetting, MCP/auth/quota boundaries,
evaluation harnesses, and the qualifying deployment path.

**Build-window disclosure.** This entry was materially built during the competition
window. The repository's earliest commit is `6ec9389` (2026-07-01), after the
competition opened on 2026-05-26. That evidence establishes only this repository's
recorded timing; repository history alone is not proof of authorship, originality,
or completeness.

## License

MIT. See [LICENSE](./LICENSE).
