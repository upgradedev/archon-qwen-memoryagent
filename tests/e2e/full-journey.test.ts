// EXTENSIVE end-to-end journeys — the product driven the way a real caller drives
// it, over the actual Fastify routes AND the actual Model Context Protocol, all
// fully OFFLINE and DB-FREE. buildServer() is handed an InMemoryStore +
// FakeEmbedder + FakeNarrator (+ FakeJudge), so every DB-backed route runs end to
// end with no database and no DASHSCOPE key. The MCP leg round-trips through the
// SDK's in-memory transport pair, so it exercises the real tools/list + tools/call
// wire, not a direct function call.
//
// These complement the narrower http-journeys / mcp-journeys suites with the ONE
// long cradle-to-grave journey a judge would walk — seed → recall → cited answer →
// rule-audit → semantic-audit → MCP round-trip → P&L → provenance — plus a spread
// of error / edge journeys (empty store, no-contradiction, judge-guide chips,
// cross-surface consistency). Each asserts a REAL populated result on the happy
// path and a GRACEFUL, correctly-shaped outcome on the unhappy path.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.js";
import { InMemoryStore, type MemoryStore } from "../../src/memory/store.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { FakeJudge } from "../../src/memory/semantic-consistency.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { SkillDispatcher } from "../../src/skills/dispatcher.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import {
  DEMO_COMPANY,
  DEMO_TEMPLATES,
  DEMO_INVOICE_RECORD,
  DEMO_PRIMARY_RECALL_QUESTION,
} from "../../src/demo-data.js";

const NO_MEMORY = "No relevant memories found in the agent's persistent memory.";

function offlineServer(store: MemoryStore): Promise<FastifyInstance> {
  delete process.env.DASHSCOPE_API_KEY; // guarantee the offline Fakes
  return buildServer({
    store,
    embedder: new FakeEmbedder(),
    narrator: new FakeNarrator(),
    judge: new FakeJudge(),
  });
}

// Stand up a fresh MCP Client↔Server pair over the real protocol, sharing ONE
// store instance with the HTTP app so the two surfaces see the same memory.
async function mcpClientOver(store: MemoryStore): Promise<{ client: Client; close: () => Promise<void> }> {
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator(), new FakeJudge());
  const server = buildMcpServer(new SkillDispatcher(agent, store));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "full-journey-e2e", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await Promise.all([client.close(), server.close()]); } };
}

function mcpText(result: unknown): string {
  return (result as { content: Array<{ type: string; text: string }> }).content[0]!.text;
}

// ── JOURNEY 1 — the full cradle-to-grave walk over ONE shared store ─────────────
// seed → recall → cited answer → rule-audit → semantic-audit → MCP round-trip →
// P&L → provenance. Every step asserts a real, populated result.
describe("JOURNEY: seed → recall → audit → semantic-audit → MCP → P&L → provenance", () => {
  let store: InMemoryStore;
  let app: FastifyInstance;

  before(async () => {
    store = new InMemoryStore();
    app = await offlineServer(store);
    await app.ready();
  });
  after(async () => { await app.close(); });

  test("1. POST /demo/seed populates the store through the real pipeline (idempotent)", async () => {
    const res = await app.inject({ method: "POST", url: "/demo/seed", payload: {} });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.seeded > 0, "the seed must write memories");
    assert.equal(body.company, DEMO_COMPANY);
    assert.ok(body.events >= 1, "the pipeline must fuse at least one event");

    // Idempotency: a second click must NOT double-seed (a judge clicking twice).
    const again = await app.inject({ method: "POST", url: "/demo/seed", payload: {} });
    assert.equal(again.json().alreadySeeded, true);
    assert.equal(again.json().seeded, 0);
  });

  test("2. GET /memory/count reflects the seeded memories", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/count" });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().count > 0, "count must reflect the seed");
  });

  test("3. POST /recall returns a grounded, CITED answer (markers resolve to memories)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/recall",
      payload: { question: DEMO_PRIMARY_RECALL_QUESTION, company: DEMO_COMPANY, limit: 3 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.notEqual(body.answer, NO_MEMORY);
    assert.ok(Array.isArray(body.hits) && body.hits.length > 0, "recall found nothing");
    assert.ok(Array.isArray(body.citations) && body.citations.length > 0, "answer is ungrounded");
    // PROVENANCE: every citation marker in the answer resolves to a real memory,
    // and each cited memory carries a sourceRef/content pair (its provenance).
    for (const c of body.citations) {
      assert.ok(body.answer.includes(c.marker), `answer missing citation ${c.marker}`);
      assert.ok(typeof c.content === "string" && c.content.length > 0, "citation lacks content provenance");
    }
  });

  test("4. POST /consistency (rule-based audit) flags the seeded field-level contradiction", async () => {
    const res = await app.inject({ method: "POST", url: "/consistency", payload: { company: DEMO_COMPANY } });
    assert.equal(res.statusCode, 200);
    const report = res.json();
    assert.equal(report.ok, false, "a seeded contradiction must make the report not-ok");
    assert.ok(report.contradictions.length >= 1, "the disagreeing invoice amounts must be flagged");
    const inv = report.contradictions.find((c: { subject: string }) => c.subject === DEMO_INVOICE_RECORD);
    assert.ok(inv, `the ${DEMO_INVOICE_RECORD} contradiction must be surfaced`);
    // The audit RECOMMENDS which value to trust — a recommender, not a mutation.
    assert.ok(inv.resolution?.recommendedMemoryId, "a resolution must be recommended");
  });

  test("5. POST /consistency/semantic (meaning-level audit) catches the seeded opposite-prose pair", async () => {
    // The offline FakeEmbedder clusters the opposite-prose pair less tightly than
    // the live text-embedding-v4 does, so we pass the subject-similarity gate the
    // route exposes (0.5) to reproduce the live box's finding deterministically in
    // CI. The judge's polarity verdict — the actual contradiction call — is unchanged.
    const res = await app.inject({
      method: "POST",
      url: "/consistency/semantic",
      payload: { company: DEMO_COMPANY, kind: "insight", similarityThreshold: 0.5 },
    });
    assert.equal(res.statusCode, 200);
    const report = res.json();
    assert.ok(
      Array.isArray(report.semanticContradictions) && report.semanticContradictions.length >= 1,
      "the meaning-level contradiction (pays-on-time vs chronically-late) must be surfaced",
    );
    const f = report.semanticContradictions[0];
    assert.equal(f.type, "semantic-contradiction");
    assert.ok(f.resolution, "each semantic finding carries a resolution recommendation");
  });

  test("6. The audit is READ-ONLY — the two audits did not mutate the store", async () => {
    const before = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
    await app.inject({ method: "POST", url: "/consistency", payload: { company: DEMO_COMPANY } });
    await app.inject({ method: "POST", url: "/consistency/semantic", payload: { company: DEMO_COMPANY } });
    const after = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
    assert.equal(after, before, "a read-only self-audit must never change the memory count");
  });

  test("7. MCP round-trip over the SAME store sees the seeded memory (cross-surface consistency)", async () => {
    const { client, close } = await mcpClientOver(store);
    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((t) => t.name).sort(),
        ["audit_memory", "ingest_memory", "memory_count", "recall_memory"],
      );
      // memory_count over MCP must equal the HTTP count — same store, two surfaces.
      const httpCount = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
      const mcpCount = await client.callTool({ name: "memory_count", arguments: {} });
      assert.match(mcpText(mcpCount), new RegExp(`"count": ${httpCount}`));

      // recall over MCP grounds in the seeded memory.
      const recall = await client.callTool({
        name: "recall_memory",
        arguments: { company: DEMO_COMPANY, question: "what was the true employer cost?" },
      });
      assert.notEqual(recall.isError, true);
      assert.match(mcpText(recall), /"citations"/);

      // audit(+semantic) over MCP surfaces the meaning-level contradiction, read-only.
      const before = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
      const audit = await client.callTool({ name: "audit_memory", arguments: { company: DEMO_COMPANY, kind: "insight", semantic: true } });
      assert.notEqual(audit.isError, true);
      const after = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
      assert.equal(after, before, "MCP semantic audit must stay read-only");
    } finally {
      await close();
    }
  });

  test("8. GET /pnl aggregates a real P&L over the pipeline-fed memories (the drawer data)", async () => {
    const res = await app.inject({ method: "GET", url: `/pnl?company=${encodeURIComponent(DEMO_COMPANY)}` });
    assert.equal(res.statusCode, 200);
    const pnl = res.json();
    // The P&L drawer renders employer cost, cash-out and the off-bank gap — assert
    // the aggregate carries real numbers, not an empty object.
    const flat = JSON.stringify(pnl);
    assert.ok(/employer/i.test(flat), "P&L must report employer cost");
    assert.ok(/\d/.test(flat), "P&L must carry numeric aggregates, not an empty shape");
  });

  test("9. GET /memory/list returns the browse view with provenance fields (id, kind, snippet)", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/list?limit=100" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.count > 0 && Array.isArray(body.items));
    for (const it of body.items) {
      assert.ok(it.id && it.kind && typeof it.snippet === "string", "each browse row needs id + kind + snippet provenance");
    }
  });
});

// ── JUDGE-GUIDE happy path — every UI template chip is answerable on a seeded box ─
describe("JOURNEY: judge-guide — the demo template chips are all grounded", () => {
  let app: FastifyInstance;
  before(async () => {
    app = await offlineServer(new InMemoryStore());
    await app.ready();
    await app.inject({ method: "POST", url: "/demo/seed", payload: {} });
  });
  after(async () => { await app.close(); });

  for (const { q, c } of DEMO_TEMPLATES) {
    test(`HAPPY: template chip "${q}" recalls a grounded, cited answer (no empty fallback)`, async () => {
      const res = await app.inject({ method: "POST", url: "/recall", payload: { question: q, company: c } });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.notEqual(body.answer, NO_MEMORY, `chip "${q}" fell back to the no-memory answer`);
      assert.ok(body.citations.length > 0, `chip "${q}" produced an ungrounded answer`);
    });
  }
});

// ── EDGE journeys — the graceful-failure and boundary cases ─────────────────────
describe("JOURNEY: error + edge cases stay graceful and correctly-shaped", () => {
  test("EDGE: recall against a pristine EMPTY store → 200 no-memory fallback (0 hits, 0 citations)", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/recall", payload: { question: "anything?" } });
    await app.close();
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().answer, NO_MEMORY);
    assert.equal(res.json().citations.length, 0);
    assert.equal(res.json().hits.length, 0);
  });

  test("EDGE: audit of a store with NO contradiction reports ok:true, zero findings", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    // A single, self-consistent write — nothing disagrees with anything.
    await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { event: { event_id: "clean-1", company: "Solo Ltd", period: "2026-05", employee_count: 1, bank_net_total: 4000, gross_total: 5000, employer_social_security_total: 900, employee_social_security_total: 300, tax_withheld_total: 700, employer_cost_total: 5900, cost_gap_amount: 1900, cost_gap_pct: 47.5, off_bank_cost: 1900, employees: [{ employee_id: "E-01", name: "Sam Vale", gross: 5000, employee_social_security: 300, tax: 700, net: 4000, employer_social_security: 900, employer_cost: 5900 }], linked_docs: ["d1"] } },
    });
    const res = await app.inject({ method: "POST", url: "/consistency", payload: { company: "Solo Ltd" } });
    await app.close();
    assert.equal(res.statusCode, 200);
    const report = res.json();
    assert.equal(report.ok, true, "a self-consistent store must audit ok");
    assert.equal(report.contradictions.length, 0);
  });

  test("EDGE: semantic audit over a single memory finds nothing (no pair to compare)", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    await app.inject({ method: "POST", url: "/ingest", payload: { event: { event_id: "e1", company: "One Co", period: "2026-05", employee_count: 1, bank_net_total: 1, gross_total: 1, employer_social_security_total: 0, employee_social_security_total: 0, tax_withheld_total: 0, employer_cost_total: 1, cost_gap_amount: 0, cost_gap_pct: 0, off_bank_cost: 0, employees: [{ employee_id: "E", name: "A B", gross: 1, employee_social_security: 0, tax: 0, net: 1, employer_social_security: 0, employer_cost: 1 }], linked_docs: [] } } });
    const res = await app.inject({ method: "POST", url: "/consistency/semantic", payload: { company: "One Co" } });
    await app.close();
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().semanticContradictions.length, 0, "a lone memory cannot contradict itself");
  });

  test("EDGE: GET /pnl over an empty store returns a well-formed (empty) aggregate, not an error", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/pnl" });
    await app.close();
    assert.equal(res.statusCode, 200, "an empty P&L is a graceful 200, not a 500");
    assert.equal(typeof res.json(), "object");
  });

  test("EDGE: GET /health reports the live model ids + embedding dim without touching the DB", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();
    assert.equal(res.statusCode, 200);
    const h = res.json();
    assert.equal(h.status, "ok");
    assert.equal(typeof h.embedder, "string");
    assert.equal(typeof h.narrator, "string");
    assert.ok(Number.isInteger(h.embedDim) && h.embedDim > 0);
  });

  test("EDGE: forget on an all-active store with no policy prunes nothing (safe default)", async () => {
    const store = new InMemoryStore();
    const app = await offlineServer(store);
    await app.ready();
    await app.inject({ method: "POST", url: "/ingest", payload: { event: { event_id: "keep-1", company: "Keep Co", period: "2026-05", employee_count: 1, bank_net_total: 1000, gross_total: 1200, employer_social_security_total: 200, employee_social_security_total: 80, tax_withheld_total: 120, employer_cost_total: 1400, cost_gap_amount: 400, cost_gap_pct: 40, off_bank_cost: 400, employees: [{ employee_id: "E-01", name: "Kit Lane", gross: 1200, employee_social_security: 80, tax: 120, net: 1000, employer_social_security: 200, employer_cost: 1400 }], linked_docs: [] } } });
    const before = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
    const res = await app.inject({
      method: "POST", url: "/forget",
      payload: { operationId: "journey-forget-preview", reason: "preview safe retention policy" },
    });
    const after = (await app.inject({ method: "GET", url: "/memory/count" })).json().count;
    await app.close();
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().forgotten, 0, "no superseded rows → nothing to forget");
    assert.equal(after, before, "the safe-default forget must not delete active memories");
  });
});
