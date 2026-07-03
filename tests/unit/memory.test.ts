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
import { cosineSimilarity } from "../../src/memory/retrieval.js";
import { toVectorLiteral } from "../../src/db/client.js";
import type { PayrollEvent } from "../../src/types.js";

const EVENT: PayrollEvent = {
  event_id: "evt-acme-2026-03",
  company: "Acme Foods AE",
  period: "2026-03",
  employee_count: 2,
  bank_net_total: 41000,
  gross_total: 52000,
  employer_social_security_total: 11800,
  employee_social_security_total: 4200,
  tax_withheld_total: 6800,
  employer_cost_total: 63800,
  cost_gap_amount: 11800,
  cost_gap_pct: 28.8,
  hidden_total: 22800,
  employees: [
    { employee_id: "E-01", name: "Elena Novak", gross: 22000, employee_social_security: 1800, tax: 3000, net: 17200, employer_social_security: 5000, employer_cost: 27000 },
    { employee_id: "E-02", name: "David Chen", gross: 18000, employee_social_security: 1500, tax: 2400, net: 14100, employer_social_security: 4100, employer_cost: 22100 },
  ],
  linked_docs: ["doc-bank-1", "doc-reg-1"],
};

test("toVectorLiteral renders the pgvector text form", () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
});

test("remember + recall round trip ranks the semantically closest memory first", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "insight", content: "hidden employer social security contribution cost wedge" });
  await remember(embedder, store, { kind: "document", content: "quarterly sales invoice for office furniture" });
  assert.equal(await store.count(), 2);

  const hits = await recall(embedder, store, "what is the hidden employer social security cost", { limit: 2 });
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.content, /employer social security/i);
  assert.ok(hits[0]!.score >= hits[1]!.score, "hits must be sorted by descending similarity");
});

test("hybrid recall reports the REAL cosine in `score` while RRF drives ordering", async () => {
  // Regression guard for the reproducibility exposure: the default (hybrid) recall
  // must surface a real cosine similarity in `hit.score` — NOT the tiny 1/(60+rank)
  // RRF fusion value, which used to leak into the field labelled as similarity and
  // made a healthy retriever look broken (score: 0.016) to anyone curling /recall.
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "payroll_event", content: "Elena Novak (id E-01) net €17,200 employer cost €27,000." });
  await remember(embedder, store, { kind: "document", content: "quarterly sales invoice for office furniture" });
  await remember(embedder, store, { kind: "insight", content: "electricity utilities bill for the quarter" });

  const queryText = "what did employee E-01 earn";
  const qvec = await embedder.embed(queryText);
  const hits = await store.recall(qvec, { hybrid: true, queryText, limit: 3 });
  assert.ok(hits.length > 0, "hybrid recall returned nothing");

  for (const h of hits) {
    // `score` is the ACTUAL cosine of this hit's embedding vs the query — recompute
    // it independently and require an exact match (proves it is cosine, not RRF).
    const expected = cosineSimilarity(qvec, await embedder.embed(h.content));
    assert.ok(Math.abs(h.score - expected) < 1e-9, `score must equal the real cosine (got ${h.score}, expected ${expected})`);
    assert.ok(h.score >= 0 && h.score <= 1 + 1e-9, `cosine similarity must be in [0,1] (got ${h.score})`);
    // distance mirrors it (1 - cosine), and the RRF fusion value is exposed separately.
    assert.ok(Math.abs(h.distance - (1 - h.score)) < 1e-9, "distance must be 1 - cosine");
    assert.equal(typeof h.rrfScore, "number", "the RRF fusion score must be surfaced separately");
    assert.ok(h.rrfScore! > 0 && h.rrfScore! < 0.1, `rrfScore is the small 1/(60+rank) fusion value (got ${h.rrfScore})`);
  }

  // The relevant hit (E-01) ranks first and shows a SUBSTANTIAL cosine — the whole
  // point: a curl of the default recall now shows sane similarity, not score==rrf.
  const top = hits[0]!;
  assert.match(top.content, /E-01/, "the E-01 memory must rank first under hybrid fusion");
  assert.ok(top.score > 0.1, `the relevant top hit must show a real cosine, not a tiny RRF value (got ${top.score})`);
  assert.ok(top.score - top.rrfScore! > 1e-3, "score (cosine) must not be the RRF value");
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

test("MemoryAgent.auditConsistency surfaces a cross-session contradiction", async () => {
  // The demo "aha": session A stores one value for a record; a later session
  // stores a DIFFERENT value for the same record → the agent's self-audit
  // surfaces the disagreement instead of silently returning one of them.
  const agent = new MemoryAgent(new FakeEmbedder(), new InMemoryStore(), new FakeNarrator());
  // Session A — invoice INV-2043 remembered at €18,400.
  await agent.remember("document", "Invoice INV-2043 total €18,400.", {
    company: "Northwind", sourceRef: "INV-2043", metadata: { record: "INV-2043", total: 18400 },
  });
  // Session B (a separate write) — same invoice remembered at €18,900.
  await agent.remember("document", "Invoice INV-2043 total €18,900.", {
    company: "Northwind", sourceRef: "INV-2043", metadata: { record: "INV-2043", total: 18900 },
  });
  // A consistent, unrelated record that must NOT be flagged.
  await agent.remember("document", "Invoice INV-2051 total €9,250.", {
    company: "Northwind", sourceRef: "INV-2051", metadata: { record: "INV-2051", total: 9250 },
  });

  const report = await agent.auditConsistency({ company: "Northwind" });
  assert.equal(report.contradictions.length, 1, "exactly one contradiction");
  assert.equal(report.contradictions[0]!.subject, "INV-2043");
  assert.equal(report.contradictions[0]!.attribute, "total");
  assert.deepEqual(report.contradictions[0]!.values.map((v) => v.value).sort(), [18400, 18900]);
  assert.equal(report.ok, false);
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
