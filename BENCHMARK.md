# Retrieval benchmark — does the memory actually recall better?

A MemoryAgent is only as good as what it can *recall*. This benchmark measures
the retrieval quality of the agent's memory against baselines on a frozen,
labelled dataset, so the "SOTA" claim is a number you can reproduce — not a
vibe.

## TL;DR

On **real `text-embedding-v4` embeddings**, hybrid retrieval (dense + lexical,
fused with Reciprocal Rank Fusion) beats the naive vector-RAG baseline on every
ranking metric, with the gain concentrated where it matters for RAG — getting a
correct memory to the **top** of the list the narrator reads:

| Condition | Recall@3 | Recall@5 | MRR | nDCG@5 |
|---|---:|---:|---:|---:|
| no-memory (stateless) | 0.0% | 0.0% | 0.000 | 0.000 |
| lexical-bm25 only | 83.3% | 83.3% | 0.756 | 0.758 |
| **naive-vector (baseline)** | 86.7% | 93.3% | 0.813 | 0.838 |
| **hybrid-rrf (ours)** | **93.3%** | 93.3% | **0.933** | **0.899** |
| hybrid + MMR | 80.0% | 90.0% | 0.793 | 0.806 |

**Hybrid vs naive vector: MRR +0.120 (+14.8% relative), nDCG@5 +0.061 (+7.3%),
Recall@3 +6.6 pts (86.7% → 93.3%).** Recall@5 ties — both eventually find the
memory; hybrid ranks it higher.

## Why it wins: recall by genre (Recall@5)

| Condition | paraphrase | specific | mixed |
|---|---:|---:|---:|
| lexical-bm25 | 50.0% | 100.0% | 100.0% |
| naive-vector | 80.0% | 100.0% | 100.0% |
| hybrid-rrf | 80.0% | 100.0% | 100.0% |

Agent memories are dense with exact tokens dense embeddings blur together —
employee ids (`E-03`), euro figures (`€22,800`), company names, period codes
(`2026-04`). Lexical retrieval nails those; dense retrieval nails paraphrases.
RRF fuses the two rank lists (rank-based, so no score-scale normalisation), so
the agent keeps the paraphrase recall of dense **and** the exact-token precision
of lexical — which is why the top-of-list ranking (MRR / nDCG) jumps.

## What did NOT help (reported honestly)

**MMR diversity re-ranking hurt on this corpus** (MRR 0.933 → 0.793). The
benchmark memories are already largely distinct facts, so penalising redundancy
just demotes correct hits. MMR stays available (`retrieveHybridMMR`,
`recall({hybrid, ...})`) for corpora with genuinely redundant memories, but the
right tool for duplicate memories here is **consolidation** (below), not MMR. The
headline retriever is plain hybrid-rrf.

`no-memory` scores 0 by construction — it retrieves nothing. It is the
qualitative "why memory at all" contrast, not a tuned number.

## Method (and why you can trust it)

- **Dataset** — `bench/dataset.ts`: 30 memories across 3 companies / multiple
  periods (fused payroll events, per-employee lines, insights, validation
  findings, remembered user preferences) + 15 queries in three genres
  (paraphrase / specific / mixed), each with hand-labelled gold relevant memory
  ids. **Frozen before the enhanced retriever existed** — the benchmark measures
  the retriever, not the reverse. Distractor memories deliberately share
  vocabulary with the answers (e.g. an office-rent payment that also mentions a
  bank transfer) to fool naive recall.
- **Metrics** — Recall@k, MRR, nDCG@5 (`bench/metrics.ts`), computed on ranked
  memory ids vs gold. We deliberately do **not** grade the narrator's generated
  prose: qwen-plus phrasing (`€22,800` vs "22,800 euros") is brittle to string-
  match, and an LLM-judge would be both extra spend and circular (same model).
  Retrieval metrics against fixed gold labels are objective.
- **Real embeddings, cached once** — `npm run bench:embed` calls
  `text-embedding-v4` **once** over the frozen dataset and commits the vectors to
  `bench/fixtures/embeddings.json`. `npm run bench` (and CI) replay from that
  fixture with **no key and no spend**, so a judge reproduces the exact numbers
  offline. Re-run `bench:embed` only if the dataset changes.
- **One retrieval engine** — every condition runs over the same pure functions in
  `src/memory/retrieval.ts` (the ones the production store uses), so the
  comparison is apples-to-apples.
- **The Fake embedder is not part of the claim** — `npm run bench -- --fake` runs
  the harness on the deterministic `FakeEmbedder` purely to prove it executes
  offline. That bag-of-words hash is already lexical, so it *hides* the hybrid
  effect — never cite `--fake` numbers as a result.

## Reproduce

```bash
npm ci
npm run bench            # replays the committed real-embedding fixture, prints the tables above
npm run bench -- --gate  # CI gate: exits non-zero if hybrid < naive on any metric
# optional, needs DASHSCOPE_API_KEY, rebuilds the fixture (one-time ~cents):
npm run bench:embed
```

CI runs `npm run bench -- --gate` on every push (`.github/workflows/ci.yml`,
`benchmark` job), so a change that regresses retrieval below the naive baseline
fails the build.

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
  importance memories — like the hidden employer-cost insight (`importance 0.9`)
  — survive.

These are verified by unit + integration tests but kept out of the retrieval
benchmark: they are a store-hygiene mechanism, not a ranking lever.
