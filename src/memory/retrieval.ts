// Retrieval primitives — the SOTA core of the agent's memory.
//
// A plain vector top-k is the naive-RAG baseline. Real agent memories are full
// of tokens that dense embeddings blur together — employee ids (E-01), euro
// figures (€22,800), company names, period codes (2026-03). Lexical signal
// recovers exactly those; dense signal recovers meaning. We fuse the two with
// Reciprocal Rank Fusion (RRF), then optionally diversify the top-k with Maximal
// Marginal Relevance (MMR) so near-duplicate memories don't crowd out coverage.
//
// Everything here is a PURE function over generic candidates: the same code
// ranks in the production store, in unit tests, and in the offline benchmark
// (bench/), so the "hybrid beats naive" claim is measured on one shared engine.

// ── Tokenization + lexical scoring (BM25) ─────────────────────────────────────

// Unicode-aware word tokenizer. Lower-cases and keeps letters+digits, so
// "€22,800" → ["22", "800"] and "E-01" → ["e", "01"] stay recallable by keyword.
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export interface LexicalDoc {
  id: string;
  content: string;
}

// A tiny, dependency-free BM25 index. BM25 is the standard sparse-retrieval
// baseline (the "keyword" half of hybrid search). We build it over the candidate
// corpus and score a query against every document.
export class BM25 {
  private readonly k1: number;
  private readonly b: number;
  private readonly docs: Array<{ id: string; tf: Map<string, number>; len: number }> = [];
  private readonly df = new Map<string, number>();
  private avgdl = 0;

  constructor(docs: LexicalDoc[], k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    let total = 0;
    for (const d of docs) {
      const toks = tokenize(d.content);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: d.id, tf, len: toks.length });
      total += toks.length;
    }
    this.avgdl = this.docs.length ? total / this.docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    // Robertson-Sparck-Jones idf with +1 smoothing (always positive).
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  // BM25 score for every document against `queryText`. Docs with no term overlap
  // score 0 (they simply won't rank).
  scoreAll(queryText: string): Array<{ id: string; score: number }> {
    const qterms = tokenize(queryText);
    return this.docs.map((d) => {
      let score = 0;
      for (const term of qterms) {
        const f = d.tf.get(term);
        if (!f) continue;
        const denom = f + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgdl || 1));
        score += this.idf(term) * ((f * (this.k1 + 1)) / denom);
      }
      return { id: d.id, score };
    });
  }
}

// ── Dense similarity ──────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

// Deterministically DEGRADE an embedding by permuting its components with a fixed
// pseudo-random shuffle (seeded Fisher-Yates). The vector keeps its norm but loses
// all alignment with un-permuted corpus vectors, so cosine recall collapses to
// chance. Used only by the benchmark's sensitivity control — a broken retriever
// that MUST score near-zero, proving the benchmark discriminates real matches.
export function degradeVector(v: number[], seed = 1234567): number[] {
  const idx = v.map((_, i) => i);
  let s = seed >>> 0;
  const rand = () => {
    // xorshift32 — deterministic, dependency-free.
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.map((p) => v[p] ?? 0);
}

// ── Ranking + fusion ──────────────────────────────────────────────────────────

export interface Scored {
  id: string;
  score: number;
}

// Sort by descending score, break ties by id for determinism, return top-k ids.
export function topK(scored: Scored[], k: number): string[] {
  return [...scored]
    .sort((x, y) => (y.score - x.score) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, k)
    .map((s) => s.id);
}

// Reciprocal Rank Fusion: combine several ranked id-lists into one. RRF is rank-
// based, so it needs no score normalization between the (very different) dense
// and lexical score scales — the reason it's the standard hybrid-search fuser.
//   rrf(id) = Σ_lists 1 / (k + rank_in_list(id))
export function rrfFuse(rankings: string[][], k = 60): Scored[] {
  const acc = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      acc.set(id, (acc.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...acc.entries()].map(([id, score]) => ({ id, score }));
}

// Maximal Marginal Relevance: greedily pick the next result that is most relevant
// to the query yet least redundant with those already picked. Reduces the "five
// near-identical memories" failure and improves coverage of distinct facts.
//   mmr = λ·rel(q, d) − (1−λ)·max_{s∈selected} sim(d, s)
export function mmr(
  queryVec: number[],
  candidates: Array<{ id: string; embedding: number[]; relevance?: number }>,
  k: number,
  lambda = 0.7
): string[] {
  const pool = candidates.map((c) => ({
    id: c.id,
    embedding: c.embedding,
    relevance: c.relevance ?? cosineSimilarity(queryVec, c.embedding),
  }));
  const selected: typeof pool = [];
  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      let maxSim = 0;
      for (const s of selected) {
        const sim = cosineSimilarity(c.embedding, s.embedding);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * c.relevance - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]!);
  }
  return selected.map((s) => s.id);
}

// ── Composed retrievers (the benchmark conditions) ────────────────────────────

export interface Candidate {
  id: string;
  content: string;
  embedding: number[];
}

// NAIVE: pure dense vector top-k (the naive-RAG baseline).
export function retrieveVector(query: { embedding: number[] }, corpus: Candidate[], k: number): string[] {
  const scored = corpus.map((c) => ({ id: c.id, score: cosineSimilarity(query.embedding, c.embedding) }));
  return topK(scored, k);
}

// LEXICAL: pure BM25 top-k.
export function retrieveLexical(query: { text: string }, corpus: Candidate[], k: number): string[] {
  const bm25 = new BM25(corpus);
  return topK(bm25.scoreAll(query.text), k);
}

// HYBRID: RRF over the dense ranking and the BM25 ranking. `poolK` controls how
// deep each list is fused (deeper = more recall fed into the fusion).
export function retrieveHybrid(
  query: { text: string; embedding: number[] },
  corpus: Candidate[],
  k: number,
  poolK = 20,
  rrfK = 60
): string[] {
  const dense = retrieveVector(query, corpus, poolK);
  const lexical = retrieveLexical(query, corpus, poolK);
  const fused = rrfFuse([dense, lexical], rrfK);
  return topK(fused, k);
}

// HYBRID + MMR: fuse hybrid to a candidate pool, then diversify to k with MMR.
export function retrieveHybridMMR(
  query: { text: string; embedding: number[] },
  corpus: Candidate[],
  k: number,
  poolK = 20,
  lambda = 0.7
): string[] {
  const poolIds = retrieveHybrid(query, corpus, poolK, poolK);
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const pool = poolIds
    .map((id) => byId.get(id))
    .filter((c): c is Candidate => Boolean(c))
    .map((c) => ({ id: c.id, embedding: c.embedding }));
  return mmr(query.embedding, pool, k, lambda);
}

// HYBRID + LISTWISE RE-RANK: fuse hybrid to a candidate pool, then re-order that
// pool by bounded Qwen relevance scores (`scoreOf(id)`) and take top-k. Reordering
// can change any top-k metric in either direction; the pinned fixture measures
// the observed delta. `scoreOf` is injected — live listwise Qwen scores in
// production, cached fixture scores in the benchmark.
export function retrieveHybridReranked(
  query: { text: string; embedding: number[] },
  corpus: Candidate[],
  k: number,
  scoreOf: (id: string) => number | undefined,
  poolK = 10
): string[] {
  const poolIds = retrieveHybrid(query, corpus, poolK, poolK);
  const withIdx = poolIds.map((id, i) => ({ id, i, score: scoreOf(id) }));
  withIdx.sort((a, b) => {
    const as = a.score ?? -Infinity;
    const bs = b.score ?? -Infinity;
    if (as !== bs) return bs - as;
    return a.i - b.i; // stable: preserve hybrid order on ties / unscored
  });
  return withIdx.slice(0, k).map((x) => x.id);
}
