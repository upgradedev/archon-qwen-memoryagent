// Integration test — the PgVectorStore against a REAL pgvector database (the CI
// service container, or a local pgvector docker). Exercises the actual vector
// SQL: insert with `$n::vector`, cosine recall `ORDER BY embedding <=> $q`, the
// company/kind pre-filters, and count. Fully OFFLINE (FakeEmbedder — no key).
//
// Gated on DATABASE_URL: skipped on a laptop with no DB, RUN in CI (which stands
// pgvector up + applies the schema before `npm test`).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { PgVectorStore } from "../../src/memory/store.js";
import { remember, recall } from "../../src/memory/memory.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { closePool } from "../../src/db/client.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const embedder = new FakeEmbedder();
const store = new PgVectorStore();

before(async () => {
  if (!HAS_DB) return;
  await store.clear();
});

after(async () => {
  // Always release the pg pool, or `node --test` never exits (CI would hang).
  await closePool();
});

test("PgVectorStore persists a memory and recalls it by cosine similarity", { skip: !HAS_DB }, async () => {
  await remember(embedder, store, {
    kind: "insight",
    company: "Acme Foods AE",
    period: "2026-03",
    sourceRef: "evt-1",
    content: "Hidden employer social-security (IKA) cost of €11,800 at Acme Foods AE.",
    metadata: { hidden_total: 22800 },
  });
  await remember(embedder, store, {
    kind: "document",
    company: "Acme Foods AE",
    content: "Quarterly sales invoice for office furniture.",
  });
  assert.equal(await store.count(), 2);

  const hits = await recall(embedder, store, "what employer social security cost is hidden", { limit: 2 });
  assert.ok(hits.length > 0, "vector recall returned nothing");
  // The IKA memory must rank above the invoice memory under cosine distance.
  assert.match(hits[0]!.content, /social-security/i);
  assert.ok(hits[0]!.score >= hits[hits.length - 1]!.score, "hits must be sorted by similarity");
  // Round-trip fidelity: metadata + distance survive the DB.
  assert.equal(hits[0]!.metadata?.hidden_total, 22800);
  assert.ok(hits[0]!.distance >= 0 && hits[0]!.distance <= 2);
});

test("PgVectorStore applies the company + kind pre-filters in SQL", { skip: !HAS_DB }, async () => {
  await store.clear();
  await remember(embedder, store, { kind: "insight", company: "Acme", content: "acme insight one" });
  await remember(embedder, store, { kind: "insight", company: "Helios", content: "helios insight two" });
  await remember(embedder, store, { kind: "document", company: "Acme", content: "acme document three" });

  const scoped = await recall(embedder, store, "insight", { company: "Acme", kind: "insight", limit: 5 });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]!.company, "Acme");
  assert.equal(scoped[0]!.kind, "insight");

  assert.equal(await store.count("Acme"), 2);
});

test("PgVectorStore hybrid recall fuses dense + full-text (lexical rescue)", { skip: !HAS_DB }, async () => {
  await store.clear();
  await remember(embedder, store, { kind: "payroll_event", company: "Acme", content: "Elena Dimitriou (id E-03) net €9,700 employer cost €14,700." });
  await remember(embedder, store, { kind: "document", company: "Acme", content: "Office rent paid by bank transfer to the landlord." });
  await remember(embedder, store, { kind: "insight", company: "Acme", content: "Electricity utilities bill for the quarter." });

  const hits = await recall(embedder, store, "what did employee E-03 earn", {
    company: "Acme",
    hybrid: true,
    limit: 3,
  });
  assert.ok(hits.length > 0, "hybrid recall returned nothing");
  assert.match(hits[0]!.content, /E-03/, "the exact-id memory must rank first under hybrid fusion");
});

test("PgVectorStore consolidate supersedes duplicates and recall hides them", { skip: !HAS_DB }, async () => {
  await store.clear();
  const agent = new MemoryAgent(embedder, store, new FakeNarrator());
  const fact = "Hidden employer social-security cost wedge at Acme for 2026-03.";
  await agent.remember("insight", fact, { company: "Acme" });
  await agent.remember("insight", fact, { company: "Acme" });
  await agent.remember("insight", fact, { company: "Acme" });
  assert.equal(await store.count("Acme"), 3);

  const res = await agent.consolidate({ company: "Acme", threshold: 0.99 });
  assert.equal(res.superseded, 2, "two of three identical memories superseded");

  // Active recall now hides the superseded rows (count still 3 until forgotten).
  const active = await recall(embedder, store, fact, { company: "Acme", limit: 10 });
  assert.equal(active.filter((h) => h.content === fact).length, 1);
  assert.equal(await store.count("Acme"), 3);

  const { forgotten } = await agent.forget({ deleteSuperseded: true }, "Acme");
  assert.equal(forgotten, 2);
  assert.equal(await store.count("Acme"), 1);
});
