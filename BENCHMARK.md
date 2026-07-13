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

- **Provider substitution & listwise efficiency.** The intended model was Alibaba's dedicated
  `gte-rerank`, but that service returned `AccessDenied` on the hackathon account
  (rerank not activated). So the shipped `Reranker` is an **LLM cross-encoder
  using `qwen-plus`** — the same Model Studio chat model the narrator uses, which
  *is* accessible. Crucially, the implementation is **listwise** rather than pairwise:
  `LlmReranker` (`src/memory/rerank.ts`) packs the entire candidate pool (top-10) into
  a **single, unified prompt** and scores them listwise. This avoids the cost/latency
  bottleneck of N pairwise completions, executing in exactly **one** API call. The seam
  is model-agnostic — swap in a `GteReranker` once the rerank API is enabled; the
  benchmark path is unchanged.
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
npm run bench:accuracy -- --gate      # grounded-answer accuracy: correctness + faithfulness
npm run bench:consistency -- --gate   # self-auditing memory: detection + 0 false positives
npm run bench:resolution -- --gate    # contradiction resolution: winner-accuracy + structural invariants
# optional, need DASHSCOPE_API_KEY, rebuild the fixtures (one-time ~cents each):
npm run bench:embed      # re-embed the corpus/queries (text-embedding-v4)
npm run bench:rerank     # re-score the cross-encoder re-rank (qwen-plus)
npm run bench:answers    # re-narrate the grounded answers (qwen-plus)
# external head-to-head (needs `pip install "mem0ai==2.0.11" qdrant-client` + a key):
npm run bench:export && python bench/external/mem0_headtohead.py   # → bench/external/mem0-evidence.json
```

## Grounded-answer accuracy — a measured number on our own pipeline

Retrieval metrics score the *ranking*. But the thing a user actually reads is the
**narrated answer**. So we also measure the end of the pipeline the same way an
extraction system measures field accuracy: on a labelled question set, is the
answer *correct*, and is every figure in it *grounded* in a recalled memory (no
invented numbers)? This is the memory-agent analogue of a measured field-accuracy
number — an objective grade on our own output, gated in CI.

**We grade by NUMBER PRESENCE, not prose.** Earlier in this doc we said we
deliberately do *not* grade the narrator's prose (phrasing is brittle to
string-match and an LLM-judge would be circular — same model grading itself).
That still holds. This benchmark sidesteps both traps: it never scores wording or
uses a judge model. It checks two objective, reproducible facts — *is a specific
labelled figure present?* and *does every euro figure in the answer trace to a
recalled memory?* Both are deterministic string/number facts, not opinions.

**Measured** (`bench/accuracy-dataset.ts`, `npm run bench:accuracy`) on **11
labelled number-bearing questions**, replaying **one committed `qwen-plus` pass**
(`bench/fixtures/answers.json`, built by `npm run bench:answers`) over the shipped
hybrid top-5 recall:

| Measure | Result | What it means |
|---|---:|---|
| Gold-memory recall@5 | **11 / 11 (100%)** | hybrid recall put the answer-bearing memory in the top-5 for every question |
| Answer correctness | **11 / 11 (100%)** | the narrated answer states a gold figure |
| **Answer grounding (faithfulness)** | **10 / 11 (90.9%)** | every euro figure in the answer traces to a recalled memory |

The grounding number is the honest, load-bearing one. The single miss is
instructive, not swept away: on the EBITDA question the narrator *derived*
**€2,800 = operating-profit €41,200 − EBITDA €38,400** (the depreciation/
amortisation gap) — an arithmetically-*correct* but **not-stored** figure. The
faithfulness metric **correctly flags it**: that is the metric working, catching
even a plausible, self-consistent invented number. We report **90.9%**, not a
suspiciously perfect 100%, and gate at that floor (correctness = 100%, grounding
≥ 90%) so CI catches a real regression without pretending the narrator never
derives.

**Scope, owned:** 11 questions on the frozen corpus — a small, honest labelled
set, exactly like the retrieval benchmark's 15. It measures *this* pipeline on
*this* corpus; it is not a general faithfulness claim. Reproducible offline: the
grade replays the committed answers with **no key and no spend** (rebuild the
answers only if the corpus changes, `npm run bench:answers`).

```bash
npm run bench:accuracy            # replay committed answers, grade correctness + grounding
npm run bench:accuracy -- --gate  # CI gate: correctness = 100%, grounding ≥ 90%
```

## Head-to-head vs Mem0 and Zep

The retrieval table above measures us against the field-default dense baseline.
The fair question a judge will ask next is: *how does this compare to the actual
agent-memory libraries — Mem0 and Zep?* We answer it honestly, and the honest
answer has two parts: **retrieval is at parity**, and **we expose a capability
they do not** — a read-only, non-mutating contradiction audit with a resolution
recommendation.

### What we actually ran (Mem0, real)

We installed **Mem0 (`mem0ai==2.0.11`)** and drove it with the **same Qwen models
and data**: `qwen-plus` + `text-embedding-v4` via DashScope, a local in-process
Qdrant store, and the **same cross-session conflict pairs our own audit is
measured on** (`bench/external/`, `python bench/external/mem0_headtohead.py`). The
run is committed as evidence (`bench/external/mem0-evidence.json`) — it needs a
key, so like `bench:embed`/`bench:rerank` it is **captured once and read offline**,
and because Mem0's write path is a non-deterministic LLM it is **evidence, not a
CI gate**.

Findings, measured:

- **Retrieval parity.** On the number-bearing probe queries, Mem0's recall put the
  gold figure in its top-5 on **5 / 5** — Mem0 retrieves competently. We therefore
  claim **parity, not a retrieval win**. (A strict Recall@k against our gold ids
  would be ill-defined anyway: Mem0 *rewrites* the corpus into LLM-extracted
  "facts", so there are no stable ids to score — which is exactly why we grade the
  objective *figure-present* signal instead.) Parity is two-sided and measured on
  both: on the very same five figures (€18,400 / €12,900 / €38,400 / €6,300 /
  €27,600), **our** hybrid recall surfaces the gold figure in its top-5 on **5 / 5**
  too — see the accuracy benchmark's 11/11 recall, of which these are five.
- **No contradiction/resolution surface.** Mem0's public API exposes **no**
  `consist*`/`contradict*`/`conflict*`/`resolve*`/`audit*` method (empirically the
  matched-method list is `[]`). Fed two cross-session writes that disagree
  (INV-2043 total €18,400 then €18,900; and three more records), Mem0 **stored
  both** and, on recall, **returned both values ranked by similarity with no
  conflict flag and no resolution recommendation**. Mem0 *does* reason about
  conflicts **internally at write time** — its LLM decides ADD/UPDATE/DELETE — but
  that is a **silent, non-deterministic mutation**, not a queryable report of
  *"these two memories disagree; here is which to trust and why."*

### Zep / Graphiti (cited, not run)

We did **not** run Zep (it is a graph server / hosted service; standing it up was
out of scope at this deadline), so this is **cited from its documentation and
paper**, stated conservatively. Crucially — and contrary to a lazy "they can't do
it" claim — **Zep _does_ handle contradictions**: Graphiti's temporal knowledge
graph has an LLM detect edges that contradict a new fact and **invalidate** the old
edge by setting `invalid_at` (closing its validity window), so the graph always
reflects the currently-true fact while history stays queryable. That is genuinely
strong. But note the shape of it: it **mutates graph state**, it **requires the
graph model**, and it resolves **by time** (the newer edge wins). It is not a
read-only, portable audit that hands the caller a *recommendation* to accept or
override.

### The honest capability matrix

| Capability | Mem0 (OSS) | Zep / Graphiti | **This entry** |
|---|---|---|---|
| Cross-session retrieval | dense (+ newer multi-signal) | graph + semantic/BM25 | dense + BM25 **RRF** + cross-encoder re-rank |
| Detects same-record contradictions | at write time (LLM) | at write time (LLM, graph edges) | **on demand, read-only** (`POST /consistency`) |
| Resolution output | none surfaced | temporal: newer edge wins | **recommendation** `{rule, confidence, rationale}` (importance→authority→recency) |
| Mutates memory to resolve? | **yes** (silent ADD/UPDATE/DELETE) | **yes** (closes validity window) | **no — never mutates**, recommends only |
| Deterministic + explainable? | no (LLM decision) | partial (LLM detect + time rule) | **yes** (pure function, fixed ladder) |
| Portable (no lib/graph lock-in)? | needs Mem0 stack | needs graph DB + Graphiti | **pure function over generic memory rows** |

**The one honest sentence.** We are **not** claiming Mem0/Zep can't handle
conflicting memories — Mem0 mutates via its LLM, Zep invalidates graph edges by
time. We are claiming something narrower and, we think, genuinely useful that
*neither* exposes: a **read-only, deterministic, portable audit that surfaces the
contradiction and *recommends* which value to trust — with a rule, a confidence,
and a rationale — while never mutating the memory itself.** The agent (or a human)
decides; the memory layer stays honest about what it holds.

**Scope, owned:** 4 conflict pairs + 5 retrieval probes against Mem0 — a focused,
frozen comparison, not a broad multi-workload benchmark; Zep is doc-cited, not run.
Reproduce with `npm run bench:export && python bench/external/mem0_headtohead.py`.

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
  top-level 0..1 salience (e.g. the `0.9` off-bank-cost insight `ingestEvent` writes)
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

### Meaning-level (semantic) self-audit — measured on a labelled set

The rule-based audit above compares **shared metadata fields**, so it is blind to a
whole class of real contradiction: two memories that oppose each other **in meaning**
while sharing no comparable key — e.g. *"vendor always pays on time"* vs *"vendor is
chronically late"*. Neither carries a numeric attribute to compare, so the rule-based
path groups nothing and reports OK. The disagreement lives in the prose.

`auditSemanticConsistency` (`src/memory/semantic-consistency.ts`, exposed as
`POST /consistency/semantic`) closes that gap **additively** — it does not replace the
rule-based path, it runs alongside it:

1. **Subject gate** — embed each memory (the same `text-embedding-v4` recall path) and
   keep only pairs whose cosine similarity clears a threshold (default 0.75, tuned for
   real vectors): they are about the same subject. This both finds candidate pairs and
   bounds the (paid) judge calls to plausibly-related memories.
2. **Opposition judge** — for each near pair, ask a judge whether they *directly
   contradict*. Online that is **qwen-plus** (real semantic reasoning); offline it is a
   deterministic polarity/negation heuristic (`FakeJudge`) so the whole path runs in CI
   with zero credentials — the same Fake seam as the rest of the suite. The online judge
   **fails closed**: any error or unparseable response yields "no contradiction", never a
   manufactured one (a hallucinated contradiction is a trust regression).

Like the rule-based layer it is **read-only** and a **recommender**: every finding carries
the SAME `resolution` shape produced by the SAME importance → source-authority → recency
ladder. It **never mutates memory**.

**Measured** on a labelled corpus (`bench/semantic-consistency-dataset.ts`,
`npm run bench:semantic`) of 10 same-subject **opposed** pairs spanning every polarity
cluster plus a hard control of agreeing / **negation-agreeing** / complementary /
cross-cluster / different-subject pairs:

> **9 / 10 contradictions detected with 0 false positives — 90% recall, 100%
> precision, 0% false-positive rate.** On the same corpus the rule-based
> field-level audit catches **0**, so the meaning-level self-audit
> **surfaces 9 contradictions** a naive store — and any field-level audit — would serve as truth.

**Method — the number isolates the offline judge.** Each memory carries an explicit
per-subject **orthogonal embedding**, so the subject gate is deterministic (same-subject
pairs land at cosine ≈ 0.995 and clear the gate; different-subject pairs are orthogonal and
are rejected, never judged). That makes precision/recall/FP a clean measurement of the
offline opposition **judge's** discrimination — the `FakeJudge` polarity/negation heuristic
— free of bag-of-words embedder noise. The **live** path swaps in real `text-embedding-v4`
vectors + the **qwen-plus** judge; this offline corpus measures exactly the credential-free
CI path.

**Precision is the load-bearing number** (identical stance to the rule-based audit): the
control set exists to keep the audit **silent** on things that only *look* like conflicts.
The sharpest trap is the **negation-agreement** case — *"not late"* AGREES with *"pays on
time"* (both positive once negation is applied) and must **not** flag; the heuristic's
`isNegated` handles it, and the benchmark proves 0 FP across the whole control.

**The one miss is honest, not hidden.** The single undetected contradiction is **cue-free**
— *"delivers every shipment ahead of schedule"* vs *"is consistently behind schedule"* — no
lexical polarity cue the offline heuristic can see. That is precisely the case the **online
qwen-plus judge** exists to close; we floor recall at the measured 90% (same philosophy as
grounding's measured 90.9% above), never an aspirational 100%. Full unit coverage of the
mechanism remains in `tests/unit/semantic-consistency.test.ts`, and the **shipped demo
fixture** (`DEMO_SEMANTIC`, seeded by `POST /demo/seed`) is proven detectable offline.

**What CI gates:** `npm run bench:semantic -- --gate` fails on any regression below **100%
precision (0 FP)** or **90% recall** — the fifth benchmark gate alongside retrieval,
grounded-answer accuracy, self-audit detection, and resolution. The headline numbers are
pinned in `bench/golden.json` (`semantic` block) and re-verified by the readiness gate
(`scripts/readiness.ts`, which asserts computed == golden == docs).

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
