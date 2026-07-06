// Integration test — the document-ingestion pipeline routes against a REAL
// pgvector database (CI service container). Proves the full productized path:
// POST /ingest/documents runs Extractor → Classifier → EventLinker → Validator →
// P&L and WRITES the fused event into memory; GET /pnl then aggregates that same
// pipeline-fed memory. Fully OFFLINE (FakeExtractionClient + FakeEmbedder — the
// document `content` is the JSON the model would return; no key, no network).
//
// Gated on DATABASE_URL: skipped on a laptop with no DB, RUN in CI.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { PgVectorStore } from "../../src/memory/store.js";
import { closePool } from "../../src/db/client.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
let app: FastifyInstance;

const DOCS = [
  { doc_id: "d-reg", filename: "register.pdf", source_kind: "text", company: "ByteCraft", period: "2026-05",
    content: JSON.stringify({ doc_type: "payroll_register", gross_pay_total: 7000, employer_cost_total: 8600, employee_count: 2 }) },
  { doc_id: "d-bank", filename: "bank.pdf", source_kind: "text", company: "ByteCraft", period: "2026-05",
    content: JSON.stringify({ doc_type: "bank_confirmation", net_pay_total: 6500, payment_date: "2026-05-28" }) },
  { doc_id: "d-p1", filename: "p1.png", source_kind: "image", company: "ByteCraft", period: "2026-05",
    content: JSON.stringify({ doc_type: "payslip", employee: { employee_id: "E-01", name: "Ana Cole", gross: 4000, employee_social_security: 100, tax: 200, net: 3700, employer_social_security: 500, employer_cost: 4500 } }) },
  { doc_id: "d-p2", filename: "p2.png", source_kind: "image", company: "ByteCraft", period: "2026-05",
    content: JSON.stringify({ doc_type: "payslip", employee: { employee_id: "E-02", name: "Tom Reed", gross: 3000, employee_social_security: 80, tax: 120, net: 2800, employer_social_security: 1100, employer_cost: 4100 } }) },
];

before(async () => {
  if (!HAS_DB) return;
  delete process.env.DASHSCOPE_API_KEY; // force the offline Fakes
  await new PgVectorStore().clear();
  app = await buildServer();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePool();
});

test("POST /ingest/documents fuses the triplet and feeds memory", { skip: !HAS_DB }, async () => {
  const res = await app.inject({ method: "POST", url: "/ingest/documents", payload: { documents: DOCS } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.events, 1);
  assert.ok(body.written > 0);
  assert.ok(Array.isArray(body.memoryIds) && body.memoryIds.length === body.written);
  // The fused event carries the accurate employer cost + off-bank cost gap.
  const result = body.results[0];
  assert.equal(result.event.employer_cost_total, 8600);
  assert.equal(result.pnl.off_bank_cost, 2100);
  assert.equal(result.validation.length, 4);
});

test("GET /pnl aggregates the pipeline-fed memories", { skip: !HAS_DB }, async () => {
  const res = await app.inject({ method: "GET", url: "/pnl?company=ByteCraft" });
  assert.equal(res.statusCode, 200);
  const pnl = res.json();
  assert.equal(pnl.employer_cost_total, 8600);
  assert.equal(pnl.cash_out_total, 6500);
  assert.equal(pnl.off_bank_cost, 2100);
  assert.ok(pnl.by_company.length >= 1);
});

test("the agent can recall what the pipeline wrote", { skip: !HAS_DB }, async () => {
  const res = await app.inject({ method: "POST", url: "/recall", payload: { question: "what did it cost to employ the team?", company: "ByteCraft" } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.hits) && body.hits.length > 0);
});

test("POST /demo/seed feeds the demo memories + a contradiction the self-audit finds", { skip: !HAS_DB }, async () => {
  const seed = await app.inject({ method: "POST", url: "/demo/seed" });
  assert.equal(seed.statusCode, 200);
  const s = seed.json();
  assert.equal(s.company, "Northwind Trading");
  assert.ok(s.seeded > 0);

  // The deliberate contradiction is detected by the full self-audit.
  const audit = await app.inject({ method: "POST", url: "/consistency", payload: { company: "Northwind Trading" } });
  assert.equal(audit.statusCode, 200);
  const report = audit.json();
  assert.ok(Array.isArray(report.contradictions) && report.contradictions.length >= 1);
});

test("GET /memory/list returns a recent slice for the browse view", { skip: !HAS_DB }, async () => {
  const res = await app.inject({ method: "GET", url: "/memory/list?limit=5" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 5);
  const first = body.items[0];
  assert.ok(typeof first.kind === "string" && typeof first.snippet === "string");
});
