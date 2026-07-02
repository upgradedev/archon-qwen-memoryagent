// Standard information-retrieval metrics for the benchmark.
//
// Each metric takes the retriever's RANKED id list and the set of GOLD relevant
// ids for one query, and returns a per-query score. The runner averages them.

export function recallAtK(ranked: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  const found = gold.filter((g) => top.has(g)).length;
  return found / gold.length;
}

// Mean Reciprocal Rank contribution: 1 / rank of the FIRST relevant hit (0 if
// none in the list). Rewards putting a correct memory high.
export function reciprocalRank(ranked: string[], gold: string[]): number {
  const goldSet = new Set(gold);
  for (let i = 0; i < ranked.length; i++) {
    if (goldSet.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

// Normalized Discounted Cumulative Gain @k with binary relevance.
export function ndcgAtK(ranked: string[], gold: string[], k: number): number {
  const goldSet = new Set(gold);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (goldSet.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(k, gold.length);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export interface MetricRow {
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
  n: number;
}

export function aggregate(
  rows: Array<{ ranked: string[]; gold: string[] }>
): MetricRow {
  const n = rows.length || 1;
  let r3 = 0;
  let r5 = 0;
  let mrr = 0;
  let ndcg = 0;
  for (const { ranked, gold } of rows) {
    r3 += recallAtK(ranked, gold, 3);
    r5 += recallAtK(ranked, gold, 5);
    mrr += reciprocalRank(ranked, gold);
    ndcg += ndcgAtK(ranked, gold, 5);
  }
  return {
    recallAt3: r3 / n,
    recallAt5: r5 / n,
    mrr: mrr / n,
    ndcgAt5: ndcg / n,
    n: rows.length,
  };
}
