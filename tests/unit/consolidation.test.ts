// Unit tests for memory consolidation + forgetting — no DB, no key. Uses the
// pure planners plus the MemoryAgent over an InMemoryStore.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planConsolidation, planForget } from "../../src/memory/consolidation.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";

const lifecycleProvenance = (operationId: string) => ({
  operationId,
  actor: "test:operator",
  reason: "exercise atomic lifecycle provenance",
  requestHash: operationId.padEnd(64, "0").slice(0, 64),
});

test("planConsolidation clusters near-duplicates and keeps the most important", () => {
  const plan = planConsolidation(
    [
      { id: "a", kind: "insight", company: "Acme", period: "2026-01", content: "dup", embedding: [1, 0, 0], importance: 0.5, createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", kind: "insight", company: "Acme", period: "2026-01", content: "dup", embedding: [1, 0, 0], importance: 0.9, createdAt: "2026-01-02T00:00:00Z" },
      { id: "c", kind: "insight", company: "Acme", period: "2026-01", content: "distinct", embedding: [0, 1, 0], importance: 0.5, createdAt: "2026-01-03T00:00:00Z" },
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
      { id: "a", kind: "insight", company: "Acme", period: "2026-01", content: "x", embedding: [1, 0], importance: 0.5, createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", kind: "document", company: "Acme", period: "2026-01", content: "x", embedding: [1, 0], importance: 0.5, createdAt: "2026-01-01T00:00:00Z" },
    ],
    0.95
  );
  assert.equal(plan.groups.length, 0);
});

test("planConsolidation never merges across company or period", () => {
  const base = {
    kind: "insight",
    content: "same-looking fact",
    embedding: [1, 0],
    importance: 0.5,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const plan = planConsolidation([
    { ...base, id: "a", company: "Acme", period: "2026-01" },
    { ...base, id: "b", company: "OtherCo", period: "2026-01" },
    { ...base, id: "c", company: "Acme", period: "2026-02" },
  ]);
  assert.equal(plan.groups.length, 0);
});

test("planConsolidation clamps unsafe thresholds and prevents single-link chaining", () => {
  const base = {
    kind: "insight",
    company: "Acme",
    period: "2026-01",
    content: "fact",
    importance: 0.5,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const plan = planConsolidation([
    { ...base, id: "a", embedding: [1, 0] },
    { ...base, id: "b", embedding: [0.9511, 0.309] },
    { ...base, id: "c", embedding: [0.809, 0.588] },
  ], -100);
  assert.equal(plan.groups.length, 1, "A/B may merge but C must not chain through B");
  assert.equal(plan.groups[0]!.losers.length, 1);
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

test("planForget empty policy is a safe no-op and invalid dates are retained", () => {
  const candidates = [
    { id: "sup", importance: 0.1, createdAt: "2026-01-01T00:00:00Z", supersededAt: "2026-02-01T00:00:00Z" },
    { id: "invalid", importance: 0, createdAt: "not-a-date", supersededAt: null },
  ];
  assert.deepEqual(planForget(candidates, {}), []);
  assert.deepEqual(
    planForget(candidates, { olderThanDays: 1, maxImportance: 1 }, new Date("2026-06-01T00:00:00Z")),
    [],
  );
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

test("confirmed lifecycle operations persist reason/actor and replay by operation id", async () => {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator());
  await agent.remember("insight", "audited duplicate", { company: "Audit Co" });
  await agent.remember("insight", "audited duplicate", { company: "Audit Co" });
  const options = {
    company: " audit co ", threshold: 0.99, dryRun: false,
    operationId: "lifecycle-audit-001", actor: "judge:tenant-a",
    reason: "remove verified duplicate memories",
  };

  const first = await agent.consolidate(options);
  const replay = await agent.consolidate(options);
  assert.deepEqual(replay, first, "a lost-response retry replays durable counts and timestamp");
  assert.deepEqual(first.audit, {
    operationId: "lifecycle-audit-001",
    actor: "judge:tenant-a",
    reason: "remove verified duplicate memories",
    persisted: true,
    completedAt: first.audit.completedAt,
  });
  assert.match(first.audit.completedAt!, /^\d{4}-\d{2}-\d{2}T/);
  await assert.rejects(
    agent.consolidate({ ...options, reason: "different request" }),
    /operation id was already used for a different request/i,
  );
});

test("feedback and confirmed consolidation serialize: protection wins or the superseded feedback fails", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  const agent = new MemoryAgent(embedder, store, new FakeNarrator());
  const a = await agent.remember("insight", "same duplicate lifecycle fact", { company: "Race Co", importance: 0.1 });
  const b = await agent.remember("insight", "same duplicate lifecycle fact", { company: "Race Co", importance: 0.5 });
  const outcomes = await Promise.allSettled([
    agent.applyFeedback(a, "correct", undefined, { feedbackId: "protect-before-consolidate" }),
    agent.consolidate({ company: "Race Co", threshold: 0.99, dryRun: false }),
  ]);
  const active = await store.listForAudit({ company: "Race Co" });
  assert.equal(active.length, 1);
  if (outcomes[0]!.status === "fulfilled") {
    assert.equal(active[0]!.id, a, "a committed protection must be reflected in the locked consolidation plan");
    assert.equal((await store.getMemoryForFeedback(a))?.importance, 0.95);
  } else {
    assert.equal((await store.getMemoryForFeedback(a))?.supersededAt !== null, true);
  }
  assert.ok([a, b].includes(active[0]!.id));
});

test("feedback protection and confirmed stale forgetting serialize without deleting a committed protected row", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  const agent = new MemoryAgent(embedder, store, new FakeNarrator());
  const id = await agent.remember("insight", "old low importance lifecycle fact", { company: "Retention Race Co", importance: 0.1 });
  // Protection commits first: the atomic forget operation re-plans from current
  // importance and retains the row even though its synthetic test clock is old.
  await agent.applyFeedback(id, "correct", undefined, { feedbackId: "protect-before-forget" });
  const protectedForget = await store.forgetAtomic({
    tenantId: "_public", company: "Retention Race Co", policy: { olderThanDays: 1, maxImportance: 0.3 },
    dryRun: false, now: new Date("2030-01-01T00:00:00Z"),
    ...lifecycleProvenance("protect-forget"),
  });
  assert.equal(protectedForget.forgotten, 0);
  assert.ok(await store.getMemoryForFeedback(id));

  // On a fresh row, a concurrent forget may serialize first. In that ordering
  // feedback fails rather than resurrecting or partially protecting a deleted row.
  const vulnerable = await agent.remember("insight", "second old low importance fact", { company: "Retention Race Co", importance: 0.1 });
  const race = await Promise.allSettled([
    agent.applyFeedback(vulnerable, "correct", undefined, { feedbackId: "feedback-forget-race" }),
    store.forgetAtomic({
      tenantId: "_public", company: "Retention Race Co", policy: { olderThanDays: 1, maxImportance: 0.3 },
      dryRun: false, now: new Date("2030-01-01T00:00:00Z"),
      ...lifecycleProvenance("race-forget"),
    }),
  ]);
  const target = await store.getMemoryForFeedback(vulnerable);
  if (race[0]!.status === "fulfilled") assert.equal(target?.importance, 0.95);
  else assert.equal(target, null);
});

test("lifecycle rejects an oversized scope before planning or mutation", async () => {
  const store = new InMemoryStore();
  await store.rememberMany(Array.from({ length: 3 }, (_, index) => ({
    tenantId: "tenant-cap",
    kind: "insight" as const,
    company: "Wide Co",
    content: `Memory ${index}`,
    embedding: [1, 0, index / 100],
    embedModel: "fixture",
  })));
  const before = await store.count("Wide Co", "tenant-cap");
  const oversized = (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 409);
    assert.match((error as Error).message, /candidate cap 2.*narrower company/i);
    return true;
  };
  await assert.rejects(
    () => store.consolidateAtomic({
      tenantId: "tenant-cap", company: "Wide Co", threshold: 0.8, dryRun: false, candidateCap: 2,
      ...lifecycleProvenance("cap-consolidate"),
    }),
    oversized,
  );
  await assert.rejects(
    () => store.forgetAtomic({
      tenantId: "tenant-cap", company: "Wide Co", policy: { olderThanDays: 1, maxImportance: 1 },
      dryRun: false, candidateCap: 2, now: new Date("2030-01-01"),
      ...lifecycleProvenance("cap-forget"),
    }),
    oversized,
  );
  assert.equal(await store.count("Wide Co", "tenant-cap"), before, "oversized scopes must mutate zero rows");
});
