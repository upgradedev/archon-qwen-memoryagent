// Unit tests for the IR metrics used by the benchmark.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recallAtK, reciprocalRank, ndcgAtK, aggregate } from "../../bench/metrics.js";

test("recallAtK counts gold hits within the top k", () => {
  assert.equal(recallAtK(["a", "b", "c"], ["a", "c"], 3), 1);
  assert.equal(recallAtK(["a", "b", "c"], ["a", "c"], 1), 0.5);
  assert.equal(recallAtK(["b", "c", "a"], ["a"], 2), 0);
});

test("reciprocalRank is 1/(rank of first hit), 0 if none", () => {
  assert.equal(reciprocalRank(["a", "b"], ["a"]), 1);
  assert.equal(reciprocalRank(["x", "a"], ["a"]), 0.5);
  assert.equal(reciprocalRank(["x", "y"], ["a"]), 0);
});

test("ndcgAtK is 1 when the only gold hit is ranked first", () => {
  assert.equal(ndcgAtK(["a", "b", "c"], ["a"], 5), 1);
  // gold at rank 2 → DCG=1/log2(3), IDCG=1 → < 1
  assert.ok(ndcgAtK(["b", "a"], ["a"], 5) < 1);
  assert.equal(ndcgAtK(["b", "c"], ["a"], 5), 0);
});

test("aggregate averages across queries", () => {
  const row = aggregate([
    { ranked: ["a", "b"], gold: ["a"] }, // rr 1, r@3 1
    { ranked: ["x", "a"], gold: ["a"] }, // rr .5, r@3 1
  ]);
  assert.equal(row.n, 2);
  assert.equal(row.recallAt3, 1);
  assert.equal(row.mrr, 0.75);
});
