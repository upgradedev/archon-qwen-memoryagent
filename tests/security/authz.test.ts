// PEN-TEST — Authorization & request-boundary controls (OWASP API1 Broken Object
// Level Auth / API4 Unrestricted Resource Consumption / API8 Misconfiguration).
//
// The live demo is intentionally OPEN (no login) so judges can drive it end to
// end — so the authorization surface is NOT a token wall; it is (1) the input
// contract every mutating route enforces (a malformed write is rejected, never a
// silent partial write), (2) the daily SPEND budget that authorizes how much a
// single client may consume of the shared Qwen key (the only real abuse lever on
// an open demo), and (3) the read-only guarantee — audit/query routes can never
// mutate the store. This suite drives the REAL Fastify routes over in-process
// `inject` (no socket), fully OFFLINE (InMemoryStore + Fakes, no DB, no key).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer, INGEST_DAILY_LIMIT } from "../../src/server.js";
import { InMemoryStore, type MemoryStore } from "../../src/memory/store.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { FakeJudge } from "../../src/memory/semantic-consistency.js";

function offlineServer(store: MemoryStore): Promise<FastifyInstance> {
  delete process.env.DASHSCOPE_API_KEY;
  return buildServer({ store, embedder: new FakeEmbedder(), narrator: new FakeNarrator(), judge: new FakeJudge() });
}

const minimalDoc = {
  doc_id: "sec-doc-1",
  filename: "reg.txt",
  source_kind: "text",
  company: "PenTest Co",
  period: "2026-05",
  content: JSON.stringify({ doc_type: "payroll_register", gross_pay_total: 1000, employer_cost_total: 1200, employee_count: 1 }),
};

// ── Input-contract enforcement — a malformed WRITE is rejected, not half-applied ─
describe("AuthZ: mutating routes enforce their input contract (no silent partial writes)", () => {
  test("POST /ingest with no event → 400 typed error, store untouched", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ingest", payload: {} });
    const count = await store.count();
    await app.close();
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /event/i);
    assert.equal(count, 0, "a rejected write must persist nothing");
  });

  test("POST /ingest with an event missing event_id → 400, store untouched", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ingest", payload: { event: { company: "X" } } });
    const count = await store.count();
    await app.close();
    assert.equal(res.statusCode, 400);
    assert.equal(count, 0);
  });

  test("POST /ingest/documents with an empty array → 400, store untouched", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ingest/documents", payload: { documents: [] } });
    const count = await store.count();
    await app.close();
    assert.equal(res.statusCode, 400);
    assert.equal(count, 0);
  });

  test("POST /recall with no question → 400 (the query-contract guard)", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/recall", payload: { company: "X" } });
    await app.close();
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /question/i);
  });
});

// ── Resource-consumption authorization — the daily SPEND budget (API4) ──────────
describe("AuthZ: the metered ingest route authorizes consumption via a daily budget", () => {
  test("POST /ingest/documents returns 429 once the per-IP daily budget is exhausted", async () => {
    // Drive the REAL budget: INGEST_DAILY_LIMIT valid calls succeed, the next is
    // rejected 429. We read the limit from the exported const so this holds whether
    // it is the default (100) or lowered via env in CI (INGEST_DAILY_LIMIT=…).
    assert.ok(INGEST_DAILY_LIMIT >= 1 && INGEST_DAILY_LIMIT <= 200, `unexpected budget ${INGEST_DAILY_LIMIT}`);
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    try {
      for (let i = 0; i < INGEST_DAILY_LIMIT; i++) {
        const ok = await app.inject({ method: "POST", url: "/ingest/documents", payload: { documents: [minimalDoc] } });
        assert.equal(ok.statusCode, 200, `call ${i + 1} within budget must be 200`);
      }
      const blocked = await app.inject({ method: "POST", url: "/ingest/documents", payload: { documents: [minimalDoc] } });
      assert.equal(blocked.statusCode, 429, "the call past the budget must be rejected");
      assert.match(blocked.json().error, /limit/i);
      // The abuse control does NOT close the free read paths — recall stays open.
      const recall = await app.inject({ method: "POST", url: "/recall", payload: { question: "still open?" } });
      assert.equal(recall.statusCode, 200, "recall must stay open even after the ingest budget is spent");
    } finally {
      await app.close();
    }
  });
});

// ── Read-only guarantee — query/audit routes can NEVER mutate the store ─────────
describe("AuthZ: read-only routes cannot mutate memory", () => {
  test("recall + both audits + pnl + list leave the memory count unchanged", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    await app.inject({ method: "POST", url: "/demo/seed", payload: {} });
    const before = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
    assert.ok(before > 0, "seed must have written memories to make the invariant meaningful");

    const readOnly = [
      { method: "POST" as const, url: "/recall", payload: { question: "what did it cost?" } },
      { method: "POST" as const, url: "/consistency", payload: {} },
      { method: "POST" as const, url: "/consistency/semantic", payload: { similarityThreshold: 0.5 } },
      { method: "GET" as const, url: "/pnl" },
      { method: "GET" as const, url: "/memory/list?limit=100" },
      { method: "GET" as const, url: "/memory/count" },
    ];
    for (const r of readOnly) {
      const res = await app.inject(r as any);
      assert.equal(res.statusCode, 200, `${r.method} ${r.url} should be a 200`);
    }
    const after = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
    await app.close();
    assert.equal(after, before, "no read-only route may change the memory count");
  });
});

// ── Route-surface boundary — no phantom endpoints answer (API8/API9) ────────────
describe("AuthZ: the route surface is bounded — unknown routes 404, they do not leak", () => {
  test("an undefined path → 404, and the body carries no server internals", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/../../etc/passwd" });
    const admin = await app.inject({ method: "POST", url: "/admin/wipe", payload: {} });
    await app.close();
    assert.equal(res.statusCode, 404);
    assert.equal(admin.statusCode, 404, "there is no privileged mutation route to reach");
    // A 404 body must not leak a stack trace or filesystem path.
    const body = res.payload;
    assert.doesNotMatch(body, /\bat \/|\.ts:\d+|[A-Za-z]:\\/, "404 must not leak stack/paths");
  });
});
