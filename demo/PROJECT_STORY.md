# Archon MemoryAgent — Project Story

## Inspiration

Two frustrations collided, and the project lives in the gap between them.

The first: **AI agents are brilliant and amnesiac.** Give an agent a hard problem and it reasons beautifully — then the session ends and it forgets everything. The next run starts cold, re-deriving what it already knew an hour ago. A *MemoryAgent* is supposed to fix that: persistent, queryable memory that survives across sessions.

The second is the one almost nobody talks about: **once an agent remembers a lot of things, some of them will disagree.** Memory accumulates from many separate write events, from different sources, at different times. Sooner or later two of those memories describe the *same fact* with *different values*. A naive memory just stores both, returns whichever ranked higher, and stays silent about the conflict.

Financial intelligence made this concrete. A business's financial truth is scattered across invoices, orders, receipts, bank transfers, and workforce-cost records. The same event is often recorded more than once — and the numbers don't always match. We didn't want a memory that confidently hands back a number while hiding that it disagreed with itself. We wanted a memory that is **honest about what it holds**.

So the guiding question became: *not just how does an agent remember, but how does an agent stay truthful as its memory grows?*

## What it does

**Archon MemoryAgent** gives a unified financial-intelligence pipeline a persistent memory.

Every fused financial event, validation finding, and narrated insight is embedded with **Qwen `text-embedding-v4`** and written to a **pgvector** store. On any later run — a different session, process, or container — the agent **recalls the relevant prior facts by meaning** and grounds a **Qwen `qwen-plus`** answer in them, citing the exact memories it used.

Three ideas make the memory *strong*, not merely present:

1. **Recall that respects exact tokens** — hybrid dense + lexical retrieval, refined by a cross-encoder re-ranker.
2. **Memory that audits itself** — a pure function that flags when two of the agent's own memories contradict, and *recommends* which to trust without ever mutating them.
3. **Honest measurement** — every claim above is backed by a frozen, reproducible benchmark, including a real head-to-head against Mem0.

## How we built it

The service is **TypeScript on Fastify**, deployed live on **Alibaba Cloud ECS** (with a serverless Function Compute + managed RDS path as an alternative). Qwen models are called through the OpenAI-compatible DashScope endpoint. The memory lives in `pgvector` on PostgreSQL.

### Recall — meaning *and* exact tokens

A single-vector cosine search is the default of virtually every RAG demo, and it has a blind spot: dense embeddings blur the exact tokens agent memories are full of — document numbers like `INV-2043`, currency figures, company names, period codes.

Recall starts from cosine similarity over the embedding space:

$$
\operatorname{sim}(\mathbf{q}, \mathbf{d}) = \frac{\mathbf{q} \cdot \mathbf{d}}{\lVert \mathbf{q} \rVert \, \lVert \mathbf{d} \rVert}
$$

To recover the exact-token signal, we fuse that dense ranking with a lexical (BM25 / full-text) ranking using **Reciprocal Rank Fusion**:

$$
\operatorname{RRF}(d) = \sum_{r \in \{\text{dense},\, \text{lexical}\}} \frac{1}{k + \operatorname{rank}_r(d)}
$$

Fusion makes recall *robust* (it never does worse than dense), but robustness alone doesn't win the top rank. So a **cross-encoder re-ranker** (`qwen-plus` scoring each query/memory pair jointly) refines the head of the list — and that is what lifts the ordered-retrieval metrics:

$$
\operatorname{nDCG}@k = \frac{\operatorname{DCG}@k}{\operatorname{IDCG}@k}, \qquad \operatorname{DCG}@k = \sum_{i=1}^{k} \frac{2^{\text{rel}_i} - 1}{\log_2(i + 1)}
$$

### Self-audit — detect, then recommend, never mutate

The headline capability. `POST /consistency` scans the agent's own memories, groups them by the record they describe, and flags two failure modes:

- **Cross-session contradictions** — same record and attribute, different value across write events.
- **Dangling references** — a memory points at a record that no memory stores.

Detecting a conflict is the easy half. The hard half is *what to do about it*. Rewriting memory at conflict time — the approach taken by systems that silently ADD/UPDATE/DELETE — throws away information and hides the disagreement. So instead of mutating, the audit returns a **recommendation** under a fixed, domain-neutral priority ladder evaluated lexicographically:

$$
\text{winner} = \operatorname*{arg\,max}_{m \in \text{conflict}} \; \big\langle\, \text{importance}(m),\; \text{authority}(m),\; \text{recency}(m) \,\big\rangle
$$

Higher importance wins; ties break on source authority; remaining ties break on recency (the later write wins). The result carries `rule + confidence + rationale`, so a human or agent can accept or override it. It is a **recommender, not ground truth** — the memory is never overwritten.

### Offline-first engineering

Every external dependency has an injectable seam. With no `DASHSCOPE_API_KEY`, a deterministic `FakeEmbedder` and `FakeNarrator` engage, so the full pgvector write-and-recall path still runs — with **zero credentials and zero spend**. That single decision is what lets the entire test pyramid and every benchmark run in CI, offline, on every commit.

## What we learned

- **Dense retrieval alone is a trap for agent memory.** The moment memories carry identifiers and figures, you need a lexical channel and a re-ranker. Hybrid + re-rank wasn't gold-plating; it was the difference between recalling the right fact and a plausible neighbour.
- **Detecting a contradiction is easy; deciding what to do is the real design problem.** The valuable move was refusing to mutate — surfacing the disagreement and *recommending*, rather than quietly picking a winner and erasing the evidence.
- **"Better than baseline" only means something if the baseline is what people actually ship.** We benchmarked against the single-vector cosine retriever that is the field default, not a strawman — so the win is a win over real practice.
- **Honesty is a feature.** Our grounding metric reports **90.9%**, not a suspiciously clean 100%, because one answer cites a *derived* figure the metric correctly refuses to credit. Reporting the miss makes every other number believable.

## Challenges we faced

- **Exact-token recall.** Getting document numbers and euro figures to survive retrieval took the full hybrid + RRF + re-rank stack, each stage earning its place against the benchmark.
- **Domain-neutral contradiction detection.** The self-audit had to be a *pure, general* engine — no finance rulebook baked in — so it groups and compares on structure alone. Keeping it domain-neutral while still catching real conflicts was the core design tension.
- **Measuring honestly.** Reproducibility meant freezing labelled fixtures and committing real embeddings, then adding a *sensitivity control* — a meaning-shuffled retriever that must score near chance — to prove the benchmark actually discriminates rather than rewarding noise.
- **A fair head-to-head.** To compare against Mem0 credibly we installed it (`mem0ai`), drove it with the *same* Qwen models and the *same* conflict pairs, and reported the honest result: retrieval at parity, but no contradiction/resolution API.
- **Deploying on Alibaba under a deadline.** We chose an ECS + `pgvector`-container topology for a single always-reachable URL, and — because the store speaks the Postgres wire protocol — kept a managed-RDS path as a drop-in `DATABASE_URL` swap rather than a rewrite.

## What's next

The `MemoryStore` interface is the seam a fully-managed **DashVector** store would slot into, with no change to the agent. Beyond that: larger labelled evaluation sets, richer resolution signals, and consolidation policies tuned on longer-lived memories.

---

*Built for the Global AI Hackathon Series with Qwen Cloud — MemoryAgent track. Method, numbers, and honest caveats live in [BENCHMARK.md](../BENCHMARK.md).*
