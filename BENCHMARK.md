# Retrieval benchmark — does the memory actually recall better?

A MemoryAgent is only as good as what it can *recall*. This benchmark measures
the retrieval quality of the agent's memory against baselines on a frozen,
labelled dataset, so the recall claim is a number you can reproduce — not a
vibe.

## TL;DR

On **real `text-embedding-v4` embeddings**, hybrid retrieval (dense + lexical,
fused with Reciprocal Rank Fusion) is the **robust** choice: it never recalls
worse than pure dense, improves **Recall@3 coverage**, and **far outperforms
lexical-only** on every ranking metric. Hybrid alone does *not* beat a strong
dense embedder on top-of-list ordering (MRR / nDCG) on this corpus — but adding a
**cross-encoder re-rank stage** (`reranked-hybrid`) does: it **beats dense on
every metric**, including the top-rank ones. Both results are measured on real
embeddings and reported as they fall.

| Condition | Recall@3 | Recall@5 | MRR | nDCG@5 |
|---|---:|---:|---:|---:|
| no-memory (stateless) | 0.0% | 0.0% | 0.000 | 0.000 |
| shuffled-vector (sensitivity control) | 16.7% | 33.3% | 0.162 | 0.197 |
| lexical-bm25 only | 73.3% | 83.3% | 0.680 | 0.701 |
| naive-vector (dense baseline) | 90.0% | 100.0% | 0.883 | 0.903 |
| hybrid-rrf | 93.3% | 100.0% | 0.839 | 0.884 |
| hybrid + MMR | 90.0% | 96.7% | 0.889 | 0.885 |
| **reranked-hybrid (ours, top-rank winner)** | **96.7%** | 100.0% | **0.911** | **0.938** |

**What holds:** hybrid **≥ dense on recall** (Recall@3 90.0% → 93.3%, +3.3 pts;
Recall@5 ties at 100%) and **≫ lexical** on every metric. Hybrid alone trails
dense on MRR (0.883 → 0.839) and nDCG@5 (0.903 → 0.884) — a strong 1024-dim
embedder already ranks the right memory first, so rank-fusing a weaker lexical
list only jostles it down. **The cross-encoder re-ranker fixes exactly that:**
reading each (query, memory) pair jointly, it lifts **MRR 0.883 → 0.911 (+0.028)**,
**nDCG@5 0.903 → 0.938 (+0.035)** and **Recall@3 90.0% → 96.7%** over the dense
baseline — a genuine top-rank win on the rebalanced corpus (see
[The cross-encoder re-ranker](#the-cross-encoder-re-ranker)).

## What the dense baseline represents (it is the field default)

`naive-vector` in the table above is **not a strawman** — it is the retrieval
approach mainstream agent-memory stacks ship **by default**. A single-vector cosine
ANN search (`ORDER BY embedding <=> $q`) is the tutorial-grade default of
LangChain's `VectorStoreRetriever` / `VectorStoreRetrieverMemory` (search type
`"similarity"`, cosine — [docs](https://reference.langchain.com/javascript/langchain-core/vectorstores/VectorStoreRetriever))
and of virtually every pgvector RAG demo. So `reranked-hybrid` beating
`naive-vector` on **every** metric (Recall@3 90.0% → 96.7%, MRR 0.883 → 0.911,
nDCG@5 0.903 → 0.938) is a win over **what the field actually ships by default**,
not over a weak control.

To be explicit about what we are and are **not** claiming: we did **not** run any
product head-to-head — that would need each product's harness and is out of scope.
What we *can* state precisely is that **LangChain's `VectorStoreRetriever` and
typical pgvector RAG demos default to exactly the dense-cosine ANN we measured
against**, so the delta over `naive-vector` is a delta over a real, widely-shipped
default. And our result points the same way the strongest *production* stacks are
already moving: **Mem0's 2026 "multi-signal" retrieval (semantic + BM25 + entity)
and Zep's hybrid/graph retrieval have both moved _beyond_ pure dense** toward
exactly the lexical/dense **fusion** this benchmark measures. So the finding both
**beats the common tutorial-grade default** and **independently corroborates the
direction the field's leaders are taking** — arrived at from Archon's own memory
corpus, and reproducible offline from committed fixtures. (Note: Mem0/Zep are cited
as evidence of *where the field is heading*, not as the dense baseline — their
current defaults are richer than dense; the dense-default attribution is only to
LangChain's default retriever and stock pgvector demos.)

## Why it wins where it wins: recall by genre (Recall@5)

| Condition | paraphrase | specific | mixed |
|---|---:|---:|---:|
| lexical-bm25 | 50.0% | 100.0% | 100.0% |
| naive-vector | 100.0% | 100.0% | 100.0% |
| hybrid-rrf | 100.0% | 100.0% | 100.0% |

Lexical retrieval collapses on **paraphrase** queries (50%) — it has no notion of
meaning. Dense retrieval nails paraphrases but can blur **exact tokens** (doc
numbers like `INV-2043` / `PINV-771`, euro figures, company names, period codes).
Hybrid keeps the paraphrase recall of dense **and** the exact-token precision of
lexical, so it is the retriever that does not fall over on *any* query genre —
which is the property you want when you cannot predict what a user will ask. That
robustness (not a headline MRR number) is the honest case for hybrid here.

## What changed and why

An earlier version of this benchmark reported hybrid beating dense by **+14.8%
MRR / +7.3% nDCG**. That result did **not** survive rebalancing the corpus.

- The old corpus was dominated by ~12 near-identical workforce/payroll rows.
  Dense embeddings *blur* near-duplicate rows together, so lexical (exact
  company/period tokens) was genuinely rescuing dense — and hybrid won top-rank.
- The current corpus is a **diverse, full-picture** business memory (below). On
  distinct topics a strong `text-embedding-v4` model resolves each memory on its
  own, saturating Recall@5 at 100% and leaving no top-rank headroom for fusion.

So the old MRR headline was partly a **corpus artifact** (near-duplicate rows),
not a pure method advantage. We measured this directly — re-running on the
rebalanced corpus showed dense's MRR *rise* (0.813 → 0.883), not fall. Rather
than tune the corpus back toward duplicates to recover the number, we report the
honest result: **on a clean, diverse corpus with a modern embedder, hybrid *alone*
gives recall robustness, not a top-rank win.** The genuine top-rank win needs a
different mechanism — a **cross-encoder re-ranker** — which we then built and
measured (next section). It is not future work anymore; it is a real, reproducible
number over the same embeddings.

## The cross-encoder re-ranker

Dense and hybrid rank a memory by a similarity computed *independently* for the
query and each memory (a bi-encoder). A **cross-encoder** instead reads the
`(query, memory)` pair *together* and scores their relevance jointly — strictly
more expressive, and the standard way to squeeze extra top-rank quality out of a
retrieval stack. We add it as a **re-rank stage over the hybrid candidate pool**
(`retrieveHybridReranked`): hybrid fixes recall, the re-ranker only re-orders the
top ~10, so it can lift MRR/nDCG **without dropping a recalled gold memory**.

Measured on the same real embeddings, `reranked-hybrid` **beats the dense
baseline on every metric**: Recall@3 90.0% → **96.7%**, MRR 0.883 → **0.911**
(+0.028, ≈ the first correct memory moving from rank 1.13 to rank 1.10 and fewer
rank-2 firsts), nDCG@5 0.903 → **0.938** (+0.035). It also beats hybrid-rrf
(MRR 0.839 → 0.911). **This is the restored top-rank headline** — earned by a
real mechanism on the diverse corpus, not by reverting to a duplicate-heavy one.

**Honesty + reproducibility caveats we own:**

- **Provider substitution.** The intended model was Alibaba's dedicated
  `gte-rerank`, but that service returned `AccessDenied` on the hackathon account
  (rerank not activated). So the shipped `Reranker` is an **LLM cross-encoder
  using `qwen-plus`** — the same Model Studio chat model the narrator uses, which
  *is* accessible: it reads each query/memory pair and returns a joint relevance
  score. The seam (`src/memory/rerank.ts`) is model-agnostic — swap in a
  `GteReranker` once the rerank API is enabled; the benchmark path is unchanged.
- **Cached once, replayed free.** `npm run bench:rerank` calls `qwen-plus` **once**
  per query over the frozen corpus (15 calls, `temperature 0`) and commits the
  scores to `bench/fixtures/rerank.json`. `npm run bench` and CI **replay** those
  scores with **no key and no spend**, so the +0.028 MRR is reproducible offline,
  exactly like the embedding fixture. Re-run only if the dataset changes.
- **We do NOT gate on `re-rank > dense`.** A cross-encoder win over a strong
  embedder is plausible but corpus-dependent; a hard CI gate on it would be
  brittle. The benchmark *reports* the delta every run; the enforced gates stay on
  the robust facts (regression guard + fusion value + discrimination).

## Does the benchmark actually discriminate? (sensitivity control)

A benchmark that scores a *broken* retriever as highly as a good one is measuring
nothing. So we include an **ablation control**: `shuffled-vector` runs the exact
dense retriever, but each query embedding has its components deterministically
**permuted** (`degradeVector`) — same vector norm, but all semantic alignment
with the corpus destroyed. It collapses to near chance (**Recall@5 33.3%, MRR
0.162**) versus dense's 100% / 0.883. The gap is a **wide, enforced margin** (CI
fails if `shuffled` Recall@5 is within 50 pts of dense), proving the metrics track
real query→memory meaning, not a harness artifact.

## What did NOT help (reported honestly)

**MMR diversity re-ranking does not help top-rank here** (nDCG@5 0.903 dense →
0.885). The benchmark memories are already largely distinct facts, so penalising
redundancy just risks demoting correct hits. MMR stays available
(`retrieveHybridMMR`, `recall({hybrid, ...})`) for corpora with genuinely
redundant memories; the right tool for duplicate memories here is
**consolidation** (below), not MMR.

`no-memory` scores 0 by construction — it retrieves nothing. It is the
qualitative "why memory at all" contrast, not a tuned number.

## Method (and why you can trust it)

- **Dataset** — `bench/dataset.ts`: **32 memories** spanning the full financial
  picture (sales & purchase invoices, orders, receipts & payments, bank
  statements/transfers, expenses & capital purchases, a sales target, P&L /
  EBITDA / cash, completeness / consistency / reconciliation cross-checks, a few
  workforce-cost insights as one example among many, and remembered user
  preferences) + 15 queries in three genres (paraphrase / specific / mixed), each
  with hand-labelled gold relevant memory ids. **Labels were fixed independently
  and never tuned to favour a condition** — the honest "hybrid loses top-rank"
  result above is the proof we report what the data says. Distractor memories
  deliberately share vocabulary and euro figures with the answers (e.g. a €18,400
  quote that was never invoiced, a supplier statement echoing an invoice figure)
  to fool naive recall.
- **Metrics** — Recall@k, MRR, nDCG@5 (`bench/metrics.ts`), computed on ranked
  memory ids vs gold. We deliberately do **not** grade the narrator's generated
  prose: `qwen-plus` phrasing (`€22,800` vs "22,800 euros") is brittle to string-
  match, and an LLM-judge would be both extra spend and circular (same model).
  Retrieval metrics against fixed gold labels are objective.
- **Real embeddings, cached once** — `npm run bench:embed` calls
  `text-embedding-v4` **once** over the frozen dataset and commits the vectors to
  `bench/fixtures/embeddings.json`. `npm run bench` (and CI) replay from that
  fixture with **no key and no spend**, so a judge reproduces the exact numbers
  offline. Re-run `bench:embed` only if the dataset changes.
- **One retrieval engine** — every condition runs over the same pure functions in
  `src/memory/retrieval.ts` (the ones the production store uses), so the
  comparison is apples-to-apples. One caveat to own: the benchmark's lexical half
  is this repo's portable `BM25` class, while the deployed `PgVectorStore` uses
  Postgres `ts_rank`/`plainto_tsquery` for the lexical pool. The dense half and
  the RRF fusion are identical, so the "hybrid is the robust retriever" thesis
  transfers; the exact numbers are measured on the BM25-hybrid variant, not the
  FTS one.
- **The Fake embedder is not part of the claim** — `npm run bench -- --fake` runs
  the harness on the deterministic `FakeEmbedder` purely to prove it executes
  offline. That bag-of-words hash is already lexical, so it *hides* the dense
  effect — never cite `--fake` numbers as a result.

## The CI gate (what we actually enforce)

CI runs `npm run bench -- --gate` on every push. The gate is aligned to what is
**true**, not to a number we wish were true:

1. **Regression guard** — `hybrid ≥ naive-vector` on Recall@3 and Recall@5.
   Hybrid must never recall worse than pure dense.
2. **Fusion value** — `hybrid > lexical-bm25` on MRR and nDCG@5. The dense half
   must genuinely add ranking signal over sparse-only.

3. **Discrimination guard** — `shuffled-vector` Recall@5 must be ≥ 50 pts below
   dense. A meaning-destroyed retriever must score near chance, or the benchmark
   isn't measuring semantics.

We deliberately **retired** the old `hybrid > naive on MRR/nDCG` gate: that
top-rank win was a near-duplicate-corpus artifact and does not survive a strong
embedder (above). We also deliberately **do not** gate on `reranked-hybrid > dense`
even though it currently holds — a cross-encoder win is corpus-dependent, so we
report the delta every run rather than freezing it into a brittle gate.

## Reproduce

```bash
npm ci
npm run bench            # replays the committed fixtures (embeddings + re-rank scores)
npm run bench -- --gate  # CI gate: regression guard + fusion value + discrimination
npm run bench:consistency -- --gate   # self-auditing memory: detection + 0 false positives
npm run bench:resolution -- --gate    # contradiction resolution: winner-accuracy + structural invariants
# optional, need DASHSCOPE_API_KEY, rebuild the fixtures (one-time ~cents each):
npm run bench:embed      # re-embed the corpus/queries (text-embedding-v4)
npm run bench:rerank     # re-score the cross-encoder re-rank (qwen-plus)
```

## Self-auditing memory-consistency (the innovation headline)

Retrieval quality is only half of a trustworthy memory. The other half is: does
the agent notice when its OWN memory disagrees with itself? A cross-session
MemoryAgent accumulates facts from many separate write events; nothing stops two
of them from **contradicting** — session A records a payroll event's employer cost
at €18,000, a later session B records €19,000 for the same event. Plain recall would hand back
whichever ranked higher and stay silent.

`auditConsistency` (`src/memory/consistency.ts`, exposed as `POST /consistency`)
scans the agent's active memories and flags two memory-native problems:

- **Contradiction** — two memories describing the **same record** (`metadata.record`
  or `sourceRef`, never a coarse company::period key) assign **different values**
  to the **same attribute**. Each memory is a distinct write event with its own
  timestamp, so a contradiction = two sessions that remembered the record
  differently.
- **Absence** — a memory references another record (`metadata.refs`) that **no
  memory stores** — a dangling reference / expected-but-missing counterpart.

It is a **pure, domain-neutral** engine (not the financial R1–R4 validator): it
compares *shared* attributes only, treats numbers within tolerance as equal
(re-ingest float noise is not a conflict), and never collapses distinct records
that merely share an attribute name.

**Measured** on a labelled dataset (`bench/consistency-dataset.ts`,
`npm run bench:consistency`) of injected conflicts plus a consistent control set
(agreeing re-ingests, float-noise, different records sharing attribute names):

> **5 / 5 injected problems detected (4 contradictions + 1 dangling reference),
> with 0 false positives on the control** — 100% detection, 100% precision.

The precision number is the load-bearing one: the control set exists specifically
to prove the audit stays silent on things that only *look* like conflicts.

### From DETECT to DETECT + RESOLVE

Finding a contradiction is only useful if the agent can also say **which side to
trust**. For every contradiction it raises, `auditConsistency` now also emits a
`resolution` recommendation — `{ recommendedMemoryId, recommendedValue, rule,
confidence, rationale }` — using a fixed priority ladder over signals **already
present on the memories** (no new data, no finance rulebook):

1. **importance** — a memory carrying an explicit `metadata.importance` outranks a
   later write with none (human/agent-flagged salience is the strongest signal).
2. **source-authority** — a **structured** record (`document` / `payroll_event` /
   `validation`) outranks a **derived narrative** (`insight`) for a raw value.
   Conservative and overridable: we only ever *demote* a memory we know is a
   derived note; everything else keeps the neutral structured rank.
3. **recency** (default) — otherwise the **later write wins** (the newest session
   presumably corrected the older one).

It is a **recommender, not ground truth** — the audit cannot know which write was
actually correct, only which one a defensible policy prefers. It **never mutates
memory**; it recommends, and the caller decides. The recommendation is additive on
the `POST /consistency` response (backward-compatible).

**Measured** on a labelled dataset (`bench/resolution-dataset.ts`,
`npm run bench:resolution`) of contradictions hand-labelled with the memory that
*should* win and the rule that should decide it (two recency, one importance, one
source-authority):

> **4 / 4 winners recommended correctly, 4 / 4 rules correct** — with the
> structural invariants (every contradiction resolved, the recommendation points
> at a real memory of that contradiction, confidence in [0,1]) enforced too.

**Honesty caveats we own:**

- **This measures policy-conformance, not policy-optimality.** The gold labels
  encode a defensible *human* policy (later-write-wins by default; importance and
  source-authority override); the engine implements that same policy, so a 100%
  here means the pure recommender *faithfully implements its stated policy*, **not**
  that the policy is universally right. Real conflicts can defy any fixed rule —
  hence a *recommendation* with a confidence, never an auto-edit.
- **The importance signal reads the persisted `importance` column.** The store's
  top-level 0..1 salience (e.g. the `0.9` hidden-cost insight `ingestEvent` writes)
  is surfaced into the audit view by `listForAudit`, with a caller-placed
  `metadata.importance` as a backward-compat fallback. So the importance rule fires
  on **real ingested memories** on the live box, not only on hand-crafted metadata —
  proven end-to-end by a store→`listForAudit`→resolver test in
  `tests/unit/consistency.test.ts`.
- **Confidence is heuristic, not calibrated.** It reflects how cleanly the winning
  signal separated the sides (bigger write-gap / stronger signal → higher), and is
  deliberately modest for recency. Treat it as an ordinal hint, not a probability.

**What CI gates:** only the robust, deterministic facts — the structural invariants
above plus winner-accuracy against the labelled policy (`bench:resolution --gate`).
Because the recommender is pure and deterministic, these never flake; the rule
breakdown is reported every run.

## Memory lifecycle: consolidation + forgetting

Retrieval quality decays if the store only ever appends — the same fact gets
re-ingested every session and near-duplicates crowd recall. The agent therefore
also *manages* its memory (`src/memory/consolidation.ts`, `MemoryAgent.consolidate`
/ `MemoryAgent.forget`):

- **Consolidate** — cluster active memories by embedding similarity (same kind,
  cosine ≥ threshold), keep the most-important/newest per cluster, supersede the
  rest. Recall then hides superseded memories, so a fact re-ingested three times
  is recalled once (see `tests/unit/consolidation.test.ts` and the pgvector
  integration test).
- **Forget** — hard-delete superseded rows, and optionally stale low-importance
  memories past a retention window (`olderThanDays` + `maxImportance`). High-
  importance memories — like a flagged completeness anomaly (`importance 0.9`) —
  survive.

These are verified by unit + integration tests but kept out of the retrieval
benchmark: they are a store-hygiene mechanism, not a ranking lever.
