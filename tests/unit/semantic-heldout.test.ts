import test from "node:test";
import assert from "node:assert/strict";
import { HELDOUT_SEMANTIC_CASES, assertHeldoutDatasetInvariant } from "../../bench/semantic-heldout-dataset.js";
import {
  HELDOUT_DATASET_SHA256,
  HELDOUT_PROTOCOL_SHA256,
  embeddingEvidence,
  runHeldoutOffline,
  type EmbeddingPair,
} from "../../bench/semantic-heldout-run.js";

test("held-out semantic corpus is frozen, balanced, and category-diverse", () => {
  assert.doesNotThrow(assertHeldoutDatasetInvariant);
  assert.equal(HELDOUT_SEMANTIC_CASES.length, 48);
  assert.equal(HELDOUT_SEMANTIC_CASES.filter((c) => c.contradicts).length, 24);
  assert.equal(HELDOUT_SEMANTIC_CASES.filter((c) => !c.contradicts).length, 24);
  assert.ok(new Set(HELDOUT_SEMANTIC_CASES.map((c) => c.category)).size >= 8);
  assert.match(HELDOUT_DATASET_SHA256, /^[a-f0-9]{64}$/);
  assert.match(HELDOUT_PROTOCOL_SHA256, /^[a-f0-9]{64}$/);
});

test("v1.1 embedding report preserves null success errors instead of serializing 'missing'", () => {
  const successful: EmbeddingPair = { a: [1, 0], b: [1, 0], error: null, latencyMs: 1 };
  const pairs = new Map(HELDOUT_SEMANTIC_CASES.map((c) => [c.id, successful]));
  const evidence = embeddingEvidence(pairs);
  assert.equal(evidence.pairs, 48);
  assert.equal(evidence.failures, 0);
  assert.equal(evidence.cases.every((c) => c.error === null), true);
});

test("held-out offline evaluation preserves the documented hard misses", async () => {
  const run = await runHeldoutOffline();
  assert.deepEqual(
    {
      cases: run.metrics.cases,
      tp: run.metrics.truePositives,
      tn: run.metrics.trueNegatives,
      fp: run.metrics.falsePositives,
      fn: run.metrics.falseNegatives,
      accuracy: run.metrics.accuracyPct,
      precision: run.metrics.precisionPct,
      recall: run.metrics.recallPct,
    },
    { cases: 48, tp: 18, tn: 18, fp: 6, fn: 6, accuracy: 75, precision: 75, recall: 75 },
  );
  const failures = run.cases.filter((c) => c.expected !== c.predicted).map((c) => c.id);
  assert.deepEqual(failures, ["p19", "p20", "p21", "p22", "p23", "p24", "n07", "n08", "n09", "n10", "n11", "n12"]);
});
