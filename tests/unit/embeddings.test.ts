// Unit tests for the embedding layer — NO database, NO DashScope key. Covers the
// deterministic Fake, the real QwenEmbedder against a canned OpenAI-compatible
// client, and the environment auto-selection.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FakeEmbedder,
  QwenEmbedder,
  defaultEmbedder,
  EMBED_DIM,
} from "../../src/memory/embeddings.js";
import type { QwenEmbeddingsClient } from "../../src/qwen/client.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // both vectors are L2-normalized, so dot == cosine similarity
}

test("FakeEmbedder produces vectors of the configured dimension", async () => {
  const v = await new FakeEmbedder().embed("employer social security IKA");
  assert.equal(v.length, EMBED_DIM);
});

test("FakeEmbedder is deterministic", async () => {
  const e = new FakeEmbedder();
  assert.deepEqual(await e.embed("hidden payroll cost"), await e.embed("hidden payroll cost"));
});

test("FakeEmbedder output is L2-normalized (unit length)", async () => {
  const v = await new FakeEmbedder().embed("Maria net pay gross employer cost");
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norm was ${norm}`);
});

test("overlapping text is more similar than disjoint text", async () => {
  const e = new FakeEmbedder();
  const q = await e.embed("hidden employer payroll cost social security");
  const near = await e.embed("the hidden employer cost from social security");
  const far = await e.embed("quarterly sales invoice for office furniture");
  assert.ok(cosine(q, near) > cosine(q, far));
});

test("QwenEmbedder calls the OpenAI-compatible embeddings endpoint with the right model + dims", async () => {
  let captured: { model?: string; input?: string; dimensions?: number } = {};
  const canned: QwenEmbeddingsClient = {
    embeddings: {
      async create(args) {
        captured = args;
        return { data: [{ embedding: new Array(8).fill(0.1) }] };
      },
    },
  };
  const e = new QwenEmbedder(canned, "text-embedding-v4", 8);
  const v = await e.embed("real employer payroll cost");
  assert.equal(captured.model, "text-embedding-v4");
  assert.equal(captured.dimensions, 8);
  assert.equal(captured.input, "real employer payroll cost");
  assert.equal(v.length, 8);
});

test("QwenEmbedder rejects a dimension mismatch from the API", async () => {
  const canned: QwenEmbeddingsClient = {
    embeddings: {
      async create() {
        return { data: [{ embedding: [0.1, 0.2] }] }; // wrong length
      },
    },
  };
  await assert.rejects(() => new QwenEmbedder(canned, "text-embedding-v4", 8).embed("x"), /expected 8/);
});

test("defaultEmbedder selects the offline FakeEmbedder without a DashScope key", () => {
  const saved = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  try {
    assert.equal(defaultEmbedder().modelId, "fake-hash-embedder");
  } finally {
    if (saved !== undefined) process.env.DASHSCOPE_API_KEY = saved;
  }
});
