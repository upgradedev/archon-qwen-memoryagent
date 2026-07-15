import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertScaleArtifactAvailable,
  assertWritableScaleRepository,
  lifecycleEvidence,
  logicalCorpusSha256,
  runScale,
  sanitizedScaleCommand,
  writeScaleArtifactExclusive,
} from "../../bench/scale-stress.js";

const TEST_ARTIFACT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../.artifacts/scale-evidence-tests");

test("scale evidence provenance hashes vectors and exposes only a repo-relative command", () => {
  const memory = {
    tenantId: "ephemeral-run-a",
    kind: "insight" as const,
    content: "Frozen logical fact",
    embedding: [1, 0, 0],
    embedModel: "frozen-vector-model",
  };
  const baseline = logicalCorpusSha256([memory]);
  assert.equal(
    logicalCorpusSha256([{ ...memory, tenantId: "ephemeral-run-b" }]),
    baseline,
    "only the isolation tenant is excluded from the corpus digest",
  );
  assert.notEqual(
    logicalCorpusSha256([{ ...memory, embedding: [0, 1, 0] }]),
    baseline,
    "embedding bytes are evidence and must affect the corpus digest",
  );
  assert.equal(
    sanitizedScaleCommand(["C:\\private\\runner.ts", "--gate", "--write", "--count=10000"]),
    "node bench/scale-stress.ts --gate --write --count=10000",
  );
  assert.throws(
    () => assertWritableScaleRepository({ gitCommit: "a".repeat(40), gitDirty: true, command: "node bench/scale-stress.ts --write" }),
    /clean whole repository/,
  );
});

test("scale evidence publication is complete and non-overwritable", () => {
  const path = resolve(TEST_ARTIFACT_DIR, `exclusive-${process.pid}-${Date.now()}.json`);
  try {
    assert.doesNotThrow(() => assertScaleArtifactAvailable(path));
    writeScaleArtifactExclusive(path, "{\"complete\":true}\n");
    assert.equal(readFileSync(path, "utf8"), "{\"complete\":true}\n");
    assert.throws(() => writeScaleArtifactExclusive(path, "{\"complete\":false}\n"), /already exists|new protocol\/version/i);
    assert.equal(readFileSync(path, "utf8"), "{\"complete\":true}\n", "the first evidence document is immutable");
  } finally {
    rmSync(path, { force: true });
  }
});

test("scale evidence lifecycle demonstrates preview, apply, forget, and feedback correction", async () => {
  const result = await lifecycleEvidence();
  assert.equal(result.duplicateRecallBefore, 12);
  assert.equal(result.consolidationPreview.dryRun, true);
  assert.equal(result.consolidationPreview.planned, 11);
  assert.equal(result.consolidationApplied.superseded, 11);
  assert.equal(result.duplicateRecallAfter, 1);
  assert.equal(result.forgetting.forgotten, 11);
  assert.deepEqual(result.feedback, {
    oldMemorySupersededAndHidden: true,
    correctedMemoryVisible: true,
    correctedMemoryCreated: true,
  });
});

test("small deterministic scale path returns top-k and bounded context without latency assertions", async () => {
  const result = await runScale("in-memory-exact-cosine", 200);
  assert.equal(result.corpus.memories, 200);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.corpus.dimensions, 1024);
  assert.equal(result.retrieval.queries, 60);
  assert.equal(result.retrieval.returnedAllTopK, true);
  assert.equal(result.retrieval.quality.goldTargetHitAt1Pct, 100);
  assert.equal(result.retrieval.quality.goldTargetHitAt5Pct, 100);
  assert.equal(result.retrieval.quality.meanReciprocalRank, 1);
  assert.deepEqual(result.retrieval.quality.misses, []);
  assert.ok(result.boundedContext.estimatedTokenReductionPct >= 75);
  assert.match(result.boundedContext.interpretation, /directional|not.*quality/i);
  assert.ok(result.retrieval.latency.p50Ms >= 0);
  assert.match(result.corpus.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.protocol.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.protocol.parameterDeviation, { corpusMemories: 200, defaultMemories: 10000 });
});
