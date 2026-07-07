// Unit tests for memory consolidation + forgetting — no DB, no key. Uses the
// pure planners plus the MemoryAgent over an InMemoryStore.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planConsolidation, planForget } from "../../src/memory/consolidation.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";

test("planConsolidation clusters near-duplicates and keeps the most important", () => {
  const plan = planConsolidation(
    [
      { id: "a", kind: "insight", content: "dup", embedding: [1, 0, 0], importance: 0.5, createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", kind: "insight", content: "dup", embedding: [1, 0, 0], importance: 0.9, createdAt: "2026-01-02T00:00:00Z" },
      { id: "c", kind: "insight", content: "distinct", embedding: [0, 1, 0], importance: 0.5, createdAt: "2026-01-03T00:00:00Z" },
    ],
    0.95
  );
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0]!.winner, "b", "highest importance must win the cluster");
  assert.deepEqual(plan.groups[0]!.losers, ["a"]);
  assert.equal(plan.supersededCount, 1);
});

test("planConsolidation never merges different kinds", () => {
  const plan = planConsolidation(
    [
      { id: "a", kind: "insight", content: "x", embedding: [1, 0], importance: 0.5, createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", kind: "document", content: "x", embedding: [1, 0], importance: 0.5, createdAt: "2026-01-01T00:00:00Z" },
    ],
    0.95
  );
  assert.equal(plan.groups.length, 0);
});

test("planForget drops superseded rows and stale low-importance ones", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const ids = planForget(
    [
      { id: "sup", importance: 0.9, createdAt: "2026-05-01T00:00:00Z", supersededAt: "2026-05-02T00:00:00Z" },
      { id: "old-lowimp", importance: 0.1, createdAt: "2026-01-01T00:00:00Z", supersededAt: null },
      { id: "old-highimp", importance: 0.9, createdAt: "2026-01-01T00:00:00Z", supersededAt: null },
      { id: "fresh", importance: 0.1, createdAt: "2026-05-31T00:00:00Z", supersededAt: null },
    ],
    { deleteSuperseded: true, olderThanDays: 60, maxImportance: 0.3 },
    now
  );
  assert.deepEqual(ids.sort(), ["old-lowimp", "sup"], "keep high-importance + fresh memories");
});

test("MemoryAgent.consolidate collapses re-ingested duplicates so recall stops repeating them", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  const agent = new MemoryAgent(embedder, store, new FakeNarrator());

  // Same fact ingested three times across sessions (identical text → identical
  // FakeEmbedder vector) plus one distinct memory.
  const fact = "off-bank employer social-security cost wedge at acme for 2026 03";
  await agent.remember("insight", fact);
  await agent.remember("insight", fact);
  await agent.remember("insight", fact);
  await agent.remember("document", "quarterly sales invoice for office furniture");

  const before = await store.recall(await embedder.embed(fact), { hybrid: true, queryText: fact, limit: 5 });
  const dupCountBefore = before.filter((h) => h.content === fact).length;
  assert.ok(dupCountBefore >= 2, "precondition: duplicates present before consolidation");

  const res = await agent.consolidate({ threshold: 0.99 });
  assert.equal(res.clusters, 1);
  assert.equal(res.superseded, 2, "two of the three identical memories must be superseded");

  const after = await store.recall(await embedder.embed(fact), { hybrid: true, queryText: fact, limit: 5 });
  assert.equal(after.filter((h) => h.content === fact).length, 1, "recall now returns the fact once");
});

test("MemoryAgent.forget hard-deletes superseded memories", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  const agent = new MemoryAgent(embedder, store, new FakeNarrator());
  const fact = "duplicate fact";
  await agent.remember("insight", fact);
  await agent.remember("insight", fact);
  await agent.consolidate({ threshold: 0.99 });
  assert.equal(await store.count(), 2);
  const { forgotten } = await agent.forget({ deleteSuperseded: true });
  assert.equal(forgotten, 1);
  assert.equal(await store.count(), 1);
});
