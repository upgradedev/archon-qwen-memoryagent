// Unit test — the HTTP shell (src/server.ts) via Fastify's in-process `inject`,
// with NO database and NO key. buildServer() wires the deterministic offline
// Fakes (no DASHSCOPE_API_KEY) and a PgVectorStore whose pg pool is created
// lazily, so the routes that never touch the DB — the /health probe and the
// request-validation guards — are exercised end-to-end without any infra.
//
// The DB-backed handler bodies (/ingest success, /recall, /consistency,
// /consolidate, /forget, /memory/count) are covered by the integration + e2e
// suites, which run against the real pgvector service container in CI.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer, makeDailyLimiter } from "../../src/server.js";

let app: FastifyInstance;

before(async () => {
  // Guarantee the offline Fakes (never a real Qwen call) regardless of env.
  delete process.env.DASHSCOPE_API_KEY;
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
});

test("GET /health returns ok with embedder/narrator identity (no DB, no key)", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.ok(typeof body.embedder === "string" && body.embedder.length > 0);
  assert.ok(typeof body.narrator === "string" && body.narrator.length > 0);
  assert.ok(Number.isInteger(body.embedDim) && body.embedDim > 0);
});

test("CORS: a cross-origin GET reflects the request origin (browser dashboards can call the API)", async () => {
  const origin = "https://archon-memoryagent-web.oss-website-ap-southeast-1.aliyuncs.com";
  const res = await app.inject({ method: "GET", url: "/health", headers: { origin } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], origin);
});

test("CORS: preflight OPTIONS on /recall is allowed for a browser POST", async () => {
  const origin = "https://example.com";
  const res = await app.inject({
    method: "OPTIONS",
    url: "/recall",
    headers: { origin, "access-control-request-method": "POST" },
  });
  assert.ok(res.statusCode === 204 || res.statusCode === 200);
  assert.equal(res.headers["access-control-allow-origin"], origin);
});

test("POST /ingest without a body.event → 400", async () => {
  const res = await app.inject({ method: "POST", url: "/ingest", payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /event/);
});

test("POST /ingest with an event missing event_id → 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/ingest",
    payload: { event: { company: "Acme" } },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /event/);
});

test("POST /recall without a body.question → 400", async () => {
  const res = await app.inject({ method: "POST", url: "/recall", payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /question/);
});

test("POST /ingest/documents without documents → 400", async () => {
  const res = await app.inject({ method: "POST", url: "/ingest/documents", payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /documents/);
});

test("POST /ingest/documents with an empty array → 400", async () => {
  const res = await app.inject({ method: "POST", url: "/ingest/documents", payload: { documents: [] } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /documents/);
});

test("makeDailyLimiter: allows N takes then blocks, resets on a new UTC day", () => {
  let day = "2026-07-06T10:00:00Z";
  const take = makeDailyLimiter(2, () => new Date(day));
  assert.equal(take().ok, true);
  const second = take();
  assert.equal(second.ok, true);
  assert.equal(second.remaining, 0);
  assert.equal(take().ok, false); // third → blocked
  day = "2026-07-07T00:01:00Z"; // next UTC day
  assert.equal(take().ok, true); // counter reset
});

test("GET / serves the memory explorer as HTML (200, text/html)", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.match(res.body, /<!doctype html>/i);
  assert.match(res.body, /Archon MemoryAgent/);
  // The page wires the real recall endpoint (not a placeholder).
  assert.match(res.body, /\/recall/);
});

test("GET /ui serves the same memory explorer (alias)", async () => {
  const res = await app.inject({ method: "GET", url: "/ui" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
});

test("GET /openapi.json returns 200 and documents the core routes", async () => {
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(res.statusCode, 200);
  const spec = res.json();
  assert.equal(spec.openapi?.startsWith("3."), true);
  assert.equal(spec.info?.title, "Archon MemoryAgent API");
  // The onRoute capture must have picked up every registered handler.
  for (const path of ["/health", "/recall", "/ingest", "/ingest/documents", "/pnl", "/memory/count", "/consistency", "/consolidate", "/forget"]) {
    assert.ok(spec.paths?.[path], `spec should document ${path}`);
  }
  // The raw-spec meta-route is hidden from the rendered spec.
  assert.equal(spec.paths?.["/openapi.json"], undefined);
});

test("GET /docs serves the interactive Swagger UI", async () => {
  const res = await app.inject({ method: "GET", url: "/docs" });
  // swagger-ui redirects /docs → /docs/ (trailing slash) before serving the page.
  assert.ok([200, 301, 302].includes(res.statusCode));
  if (res.statusCode >= 300) {
    const follow = await app.inject({ method: "GET", url: res.headers.location as string });
    assert.equal(follow.statusCode, 200);
  }
});
