// Unit tests for the memory logic — NO database, NO key. Uses InMemoryStore so
// the write → embed → cosine-recall → top-k ordering is verifiable with zero
// infra, and the full MemoryAgent loop runs offline against the Fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { remember, recall } from "../../src/memory/memory.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { toVectorLiteral } from "../../src/db/client.js";
import type { PayrollEvent } from "../../src/types.js";

const EVENT: PayrollEvent = {
  event_id: "evt-acme-2026-03",
  company: "Acme Foods AE",
  period: "2026-03",
  employee_count: 2,
  bank_net_total: 41000,
  gross_total: 52000,
  employer_ika_total: 11800,
  employee_ika_total: 4200,
  tax_withheld_total: 6800,
  employer_cost_total: 63800,
  cost_gap_amount: 11800,
  cost_gap_pct: 28.8,
  hidden_total: 22800,
  employees: [
    { employee_id: "E-01", name: "Maria Papadopoulou", gross: 22000, employee_ika: 1800, tax: 3000, net: 17200, employer_ika: 5000, employer_cost: 27000 },
    { employee_id: "E-02", name: "Nikos Georgiou", gross: 18000, employee_ika: 1500, tax: 2400, net: 14100, employer_ika: 4100, employer_cost: 22100 },
  ],
  linked_docs: ["doc-bank-1", "doc-reg-1"],
};

test("toVectorLiteral renders the pgvector text form", () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
});

test("remember + recall round trip ranks the semantically closest memory first", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "insight", content: "hidden employer social security IKA cost wedge" });
  await remember(embedder, store, { kind: "document", content: "quarterly sales invoice for office furniture" });
  assert.equal(await store.count(), 2);

  const hits = await recall(embedder, store, "what is the hidden employer social security cost", { limit: 2 });
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.content, /employer social security/i);
  assert.ok(hits[0]!.score >= hits[1]!.score, "hits must be sorted by descending similarity");
});

test("recall honours the company + kind pre-filters", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "insight", company: "Acme", content: "acme insight" });
  await remember(embedder, store, { kind: "insight", company: "Helios", content: "helios insight" });
  await remember(embedder, store, { kind: "document", company: "Acme", content: "acme document" });

  const scoped = await recall(embedder, store, "insight", { company: "Acme", kind: "insight" });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]!.company, "Acme");
  assert.equal(scoped[0]!.kind, "insight");
});

test("MemoryAgent.ingestEvent writes event + insight + per-employee memories", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new InMemoryStore(), new FakeNarrator());
  const ids = await agent.ingestEvent(EVENT);
  // event summary + insight + 2 per-employee lines = 4 memories.
  assert.equal(ids.length, 4);
});

test("MemoryAgent.recallAnswer grounds a cited answer in the recalled memories", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new InMemoryStore(), new FakeNarrator());
  await agent.ingestEvent(EVENT);
  const { answer, hits, citations, modelId } = await agent.recallAnswer(
    "What was our real employer payroll cost last month?",
    { company: "Acme Foods AE", limit: 3 }
  );
  assert.ok(hits.length > 0, "vector recall returned no memories");
  assert.equal(modelId, "fake-narrator");
  for (const c of citations) assert.ok(answer.includes(c.marker), `answer missing marker ${c.marker}`);
  const allContent = citations.map((c) => c.content).join(" ");
  assert.ok(
    allContent.includes("€63,800") || allContent.includes("€22,800"),
    "recalled memories must include the employer-cost figures"
  );
});
