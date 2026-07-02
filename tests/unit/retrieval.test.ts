// Unit tests for the retrieval primitives — no DB, no key. These pin the ranking
// math that the production store and the benchmark both depend on.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  BM25,
  cosineSimilarity,
  cosineDistance,
  rrfFuse,
  mmr,
  topK,
  retrieveVector,
  retrieveLexical,
  retrieveHybrid,
  retrieveHybridMMR,
  type Candidate,
} from "../../src/memory/retrieval.js";

test("tokenize keeps digits so ids and euro figures stay recallable", () => {
  assert.deepEqual(tokenize("Employee E-01 paid €22,800"), ["employee", "e", "01", "paid", "22", "800"]);
});

test("cosineSimilarity is 1 for identical direction, 0 for orthogonal", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [2, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosineDistance([1, 0], [2, 0])) < 1e-9);
});

test("BM25 ranks the doc containing the rare query token first", () => {
  const bm25 = new BM25([
    { id: "a", content: "the quarterly sales invoice for office furniture" },
    { id: "b", content: "employee E-03 net salary and employer cost" },
    { id: "c", content: "general note about gross and net salary" },
  ]);
  const ranked = topK(bm25.scoreAll("E-03 salary"), 3);
  assert.equal(ranked[0], "b", "the doc with the exact id token must win");
});

test("rrfFuse rewards ids ranked well in multiple lists", () => {
  const fused = rrfFuse([
    ["x", "y", "z"],
    ["y", "x", "w"],
  ]);
  const order = topK(fused, 4);
  // y is 1st+1st-ish and x is 1st+2nd → both beat z (only in one list).
  assert.ok(order.indexOf("y") < order.indexOf("z"));
  assert.ok(order.indexOf("x") < order.indexOf("z"));
});

test("mmr drops a near-duplicate in favour of a distinct memory", () => {
  const q = [1, 0, 0];
  const cands = [
    { id: "dup1", embedding: [1, 0, 0] },
    { id: "dup2", embedding: [0.99, 0.01, 0] }, // nearly identical to dup1
    { id: "diverse", embedding: [0.8, 0.6, 0] }, // relevant but different direction
  ];
  // lambda 0.3 → weight diversity over marginal relevance, so the near-duplicate
  // is penalised and the distinct memory is picked second.
  const picked = mmr(q, cands, 2, 0.3);
  assert.equal(picked[0], "dup1");
  assert.equal(picked[1], "diverse", "MMR must prefer the diverse memory over the near-duplicate");
});

test("hybrid recovers a lexical-only hit that pure vector misses", () => {
  // Build a corpus where the embedding of the answer is a poor match for the
  // query vector, but the answer shares the exact rare token 'e03'. Pure vector
  // fails; lexical rescues it; hybrid must surface it.
  const corpus: Candidate[] = [
    { id: "ans", content: "employee e03 earned net 9700", embedding: [0, 1, 0] },
    { id: "d1", content: "office rent paid by bank transfer", embedding: [1, 0, 0] },
    { id: "d2", content: "electricity utilities bill", embedding: [0.9, 0.1, 0] },
  ];
  const query = { text: "what did e03 earn", embedding: [1, 0, 0] };
  const vec = retrieveVector(query, corpus, 1);
  assert.notEqual(vec[0], "ans", "pure vector should miss the lexical-only answer here");
  const lex = retrieveLexical(query, corpus, 1);
  assert.equal(lex[0], "ans");
  const hybrid = retrieveHybrid(query, corpus, 2, 3);
  assert.ok(hybrid.includes("ans"), "hybrid must surface the lexical hit missed by vector");
});

test("retrieveHybridMMR returns at most k unique ids", () => {
  const corpus: Candidate[] = [
    { id: "a", content: "alpha", embedding: [1, 0, 0] },
    { id: "b", content: "beta", embedding: [0, 1, 0] },
    { id: "c", content: "gamma", embedding: [0, 0, 1] },
  ];
  const out = retrieveHybridMMR({ text: "alpha beta", embedding: [1, 1, 0] }, corpus, 2, 3);
  assert.equal(out.length, 2);
  assert.equal(new Set(out).size, 2);
});
