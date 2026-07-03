// End-to-end test — the headline claim of the MemoryAgent track: memory that
// PERSISTS ACROSS SESSIONS. Session A ingests fused events and then fully tears
// down (pool closed — simulating the process ending). A brand-new Session B,
// with fresh Embedder / Store / Agent instances and NO shared in-process state,
// recalls those memories by meaning and narrates a grounded, cited answer.
//
// The only thing shared between the two sessions is the pgvector database — which
// is exactly what "persistent, cross-session memory" means. Fully OFFLINE
// (FakeEmbedder + FakeNarrator — no key); gated on DATABASE_URL (RUN in CI).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { PgVectorStore } from "../../src/memory/store.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { closePool } from "../../src/db/client.js";
import type { PayrollEvent } from "../../src/types.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);

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

before(async () => {
  if (!HAS_DB) return;
  await new PgVectorStore().clear();
});

after(async () => {
  await closePool();
});

test("memory written in session A is recalled by a fresh session B", { skip: !HAS_DB }, async () => {
  // ── Session A: ingest, then tear down completely. ─────────────────────────
  {
    const agentA = new MemoryAgent(new FakeEmbedder(), new PgVectorStore(), new FakeNarrator());
    const ids = await agentA.ingestEvent(EVENT);
    assert.equal(ids.length, 4); // event + insight + 2 employees
    await closePool(); // process A ends — no in-memory state survives.
  }

  // ── Session B: brand-new instances, only the DB is shared. ────────────────
  const agentB = new MemoryAgent(new FakeEmbedder(), new PgVectorStore(), new FakeNarrator());
  const { answer, hits, citations } = await agentB.recallAnswer(
    "How much payroll cost is hidden from the bank statement?",
    { company: "Acme Foods AE", limit: 3 }
  );

  // Session B recalled memories it never wrote itself — proof of persistence.
  assert.ok(hits.length > 0, "session B recalled nothing — memory did not persist");
  assert.ok(citations.length > 0, "answer has no citations");
  for (const c of citations) assert.ok(answer.includes(c.marker), `answer missing marker ${c.marker}`);
  const grounded = citations.map((c) => c.content).join(" ");
  assert.ok(
    grounded.includes("€22,800") || grounded.includes("€63,800"),
    "recalled cross-session memory must carry the employer-cost figures"
  );
});
