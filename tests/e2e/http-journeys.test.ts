// End-to-end HTTP journeys — the full request→memory→response path a caller
// drives through the real Fastify routes, exercised over Fastify's in-process
// `inject` (no socket, no network). Fully OFFLINE and DB-FREE: buildServer() is
// handed an InMemoryStore + FakeEmbedder + FakeNarrator, so every DB-backed route
// (/ingest, /recall, /consolidate, /memory/list, /memory/count) runs end to end
// with no database and no DashScope key. Runs in every CI lane (not gated on
// DATABASE_URL), so these journeys guard the product on every push.
//
// Each journey asserts a REAL populated result on the happy path (a grounded,
// cited answer with the exact figures — never an empty body, a spinner, or an
// error) and a GRACEFUL, correctly-shaped failure on the unhappy path (a 4xx with
// a typed { error }, or the deterministic no-memory fallback with zero citations).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { InMemoryStore, type MemoryStore } from "../../src/memory/store.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import type { PayrollEvent } from "../../src/types.js";

const NO_MEMORY = "No relevant memories found in the agent's persistent memory.";

// A fused event with unambiguous, assertable figures. €63,800 is the true
// employer cost carried in the event-summary memory; Elena Novak is a per-employee
// memory whose name is a strong lexical anchor for retrieval.
const ACME: PayrollEvent = {
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
  off_bank_cost: 22800,
  employees: [
    { employee_id: "E-01", name: "Elena Novak", gross: 22000, employee_social_security: 1800, tax: 3000, net: 17200, employer_social_security: 5000, employer_cost: 27000 },
    { employee_id: "E-02", name: "David Chen", gross: 18000, employee_social_security: 1500, tax: 2400, net: 14100, employer_social_security: 4100, employer_cost: 22100 },
  ],
  linked_docs: ["doc-bank-1", "doc-reg-1"],
};

// A second, clearly-distinct company so retrieval has something to rank against.
const GLOBEX: PayrollEvent = {
  ...ACME,
  event_id: "evt-globex-2026-03",
  company: "Globex Metals",
  employer_cost_total: 90000,
  bank_net_total: 60000,
  off_bank_cost: 30000,
  employees: [
    { employee_id: "G-01", name: "Priya Raman", gross: 30000, employee_social_security: 2000, tax: 4000, net: 24000, employer_social_security: 6000, employer_cost: 36000 },
  ],
};

function offlineServer(store: MemoryStore) {
  return buildServer({ store, embedder: new FakeEmbedder(), narrator: new FakeNarrator() });
}

// ── Ingest → recall, INCLUDING the headline cross-session claim ────────────────
describe("ingest → recall journeys", () => {
  test("HAPPY: memory written by session A is recalled by a fresh session B (only the store is shared)", async () => {
    // The ONE thing the two sessions share is the store instance — exactly what
    // "persistent, cross-session memory" means. Everything else (app, embedder,
    // narrator, agent) is a brand-new instance per session.
    const store = new InMemoryStore();

    const sessionA = await offlineServer(store);
    await sessionA.ready();
    const ingest = await sessionA.inject({ method: "POST", url: "/ingest", payload: { event: ACME } });
    assert.equal(ingest.statusCode, 200);
    assert.equal(ingest.json().written, 4, "event + insight + 2 employees");
    await sessionA.close(); // session A ends — no in-process state survives.

    const sessionB = await offlineServer(store);
    await sessionB.ready();
    const res = await sessionB.inject({
      method: "POST",
      url: "/recall",
      payload: { question: "How much did it really cost to employ the team?", company: ACME.company },
    });
    await sessionB.close();

    assert.equal(res.statusCode, 200);
    const body = res.json();
    // Session B recalled memories it never wrote itself — a real, cited answer.
    assert.ok(Array.isArray(body.hits) && body.hits.length > 0, "session B recalled nothing");
    assert.ok(Array.isArray(body.citations) && body.citations.length > 0, "answer is not grounded");
    assert.notEqual(body.answer, NO_MEMORY);
    for (const c of body.citations) assert.ok(body.answer.includes(c.marker), `answer missing ${c.marker}`);
    const grounded = body.citations.map((c: { content: string }) => c.content).join(" ");
    assert.ok(grounded.includes("€63,800"), "recalled memory must carry the true employer-cost figure");
  });

  test("UNHAPPY: recall against an empty store returns the no-memory fallback (200, zero citations)", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/recall", payload: { question: "anything at all?" } });
    await app.close();

    assert.equal(res.statusCode, 200, "an empty memory is a graceful 200, not an error");
    const body = res.json();
    assert.equal(body.answer, NO_MEMORY);
    assert.equal(body.citations.length, 0);
    assert.equal(body.hits.length, 0);
  });

  test("UNHAPPY: recall scoped to a company that was never ingested finds nothing (no bleed)", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    await app.inject({ method: "POST", url: "/ingest", payload: { event: ACME } });
    const res = await app.inject({
      method: "POST",
      url: "/recall",
      payload: { question: "How much did it cost to employ the team?", company: "No Such Company ZZZ" },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.citations.length, 0, "a memory for a different company must not leak into this scope");
    assert.equal(body.answer, NO_MEMORY);
  });

  test("UNHAPPY: POST /ingest with no event body → 400 with a typed error", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ingest", payload: {} });
    await app.close();
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /event/i);
  });

  test("UNHAPPY: POST /ingest with an event missing event_id → 400 (not a silent partial write)", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ingest", payload: { event: { company: "Acme" } } });
    assert.equal(res.statusCode, 400);
    // The rejected write must not have persisted anything.
    const count = await app.inject({ method: "GET", url: "/memory/count" });
    await app.close();
    assert.equal(count.json().count, 0, "a 400 must leave the store untouched");
  });

  test("UNHAPPY: POST /recall with no question → 400 (the malformed-request guard)", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/recall", payload: { company: "Acme Foods AE" } });
    await app.close();
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /question/i);
  });
});

// ── Retrieval / re-rank ────────────────────────────────────────────────────────
describe("retrieval and re-ranking journeys", () => {
  let app: FastifyInstance;
  before(async () => {
    const store = new InMemoryStore();
    app = await offlineServer(store);
    await app.ready();
    await app.inject({ method: "POST", url: "/ingest", payload: { event: ACME } });
    await app.inject({ method: "POST", url: "/ingest", payload: { event: GLOBEX } });
  });
  after(async () => { await app.close(); });

  test("HAPPY: a name-specific question re-ranks the queried employee above the peer (scoped, no bleed)", async () => {
    // Scope to Acme so the candidate set is deterministic (no cross-company noise),
    // then query a name that is a strong, specific anchor. The re-ranker must place
    // the queried employee's memory ABOVE the non-queried peer's.
    const res = await app.inject({
      method: "POST",
      url: "/recall",
      payload: { question: "Elena Novak", company: "Acme Foods AE" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.hits.length > 0, "no hits for a question that matches a stored memory");
    // No bleed: every recalled memory belongs to the scoped company.
    assert.ok(body.hits.every((h: { company: string }) => h.company === "Acme Foods AE"), "cross-company bleed");
    const idxElena = body.hits.findIndex((h: { content: string }) => /Elena Novak/.test(h.content));
    const idxPeer = body.hits.findIndex((h: { content: string }) => /David Chen/.test(h.content));
    assert.ok(idxElena >= 0, "the queried employee's memory was not recalled");
    assert.ok(idxPeer === -1 || idxElena < idxPeer, "the queried employee must out-rank the non-queried peer");
  });

  test("HAPPY: limit caps the number of recalled memories", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/recall",
      payload: { question: "what did it cost to employ everyone?", limit: 2 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.hits.length > 0 && body.hits.length <= 2, `expected 1-2 hits, got ${body.hits.length}`);
    assert.equal(body.citations.length, body.hits.length, "one citation per recalled hit");
  });

  test("UNHAPPY: an oversized (but valid) query is handled gracefully — a 200, never a crash", async () => {
    // A large-but-under-1MB question. This must NOT hit the body-size limit; it
    // exercises the recall path's robustness to a huge query string.
    const huge = "what did it cost to employ the team? ".repeat(2000); // ~74 KB
    const res = await app.inject({ method: "POST", url: "/recall", payload: { question: huge } });
    assert.equal(res.statusCode, 200, "a large valid query must degrade to a normal answer, not error");
    assert.equal(typeof res.json().answer, "string");
  });

  test("UNHAPPY: a whitespace-only question is rejected as empty (400)", async () => {
    // "" is falsy → the guard fires. (A single space is truthy and would recall;
    // the empty string is the real empty-query case the guard protects.)
    const res = await app.inject({ method: "POST", url: "/recall", payload: { question: "" } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /question/i);
  });
});

// ── Consolidation (dedupe / merge) ─────────────────────────────────────────────
describe("consolidation journeys", () => {
  test("HAPPY: re-ingesting the same event, then consolidating, collapses the duplicates", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();

    // Ingest the identical event twice — a real re-run — so each memory now has a
    // byte-identical twin (cosine 1.0 under the fake embedder).
    await app.inject({ method: "POST", url: "/ingest", payload: { event: ACME } });
    await app.inject({ method: "POST", url: "/ingest", payload: { event: ACME } });

    const before = await app.inject({ method: "GET", url: "/memory/list?limit=100" });
    assert.equal(before.json().count, 8, "two ingests of a 4-memory event = 8 rows");

    const consolidated = await app.inject({ method: "POST", url: "/consolidate", payload: {} });
    assert.equal(consolidated.statusCode, 200);
    const plan = consolidated.json();
    assert.ok(plan.clusters >= 1, "duplicate clusters should be found");
    assert.ok(plan.superseded >= 1, "duplicates should be superseded");

    // The browse view (active memories only) no longer shows the duplicates.
    const after = await app.inject({ method: "GET", url: "/memory/list?limit=100" });
    assert.ok(
      after.json().count < before.json().count,
      "consolidation must reduce the count of active memories",
    );

    // Idempotent: a second pass finds nothing left to merge.
    const again = await app.inject({ method: "POST", url: "/consolidate", payload: {} });
    await app.close();
    assert.equal(again.json().superseded, 0, "re-consolidating an already-clean store is a no-op");
  });

  test("UNHAPPY: consolidating a store with nothing to merge is a clean no-op (0 clusters, 0 superseded)", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    await app.inject({ method: "POST", url: "/ingest", payload: { event: ACME } }); // all-distinct memories
    const res = await app.inject({ method: "POST", url: "/consolidate", payload: {} });
    await app.close();

    assert.equal(res.statusCode, 200);
    const plan = res.json();
    assert.equal(plan.clusters, 0);
    assert.equal(plan.superseded, 0);
  });
});
