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
import {
  buildServer,
  configuredHttpRateLimitMax,
  configuredJsonBodyLimit,
  DEFAULT_HTTP_RATE_LIMIT_MAX,
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  makeDailyLimiter,
} from "../../src/server.js";
import { DEMO_TEMPLATES } from "../../src/demo-data.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { consumeTwoTierQuota, InMemoryDailyQuotaBackend } from "../../src/server/quota.js";
import { pgPoolMax } from "../../src/db/client.js";

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

test("CORS: an unconfigured cross-origin GET is not granted browser access", async () => {
  const origin = "https://archon-memoryagent-web.oss-website-ap-southeast-1.aliyuncs.com";
  const res = await app.inject({ method: "GET", url: "/health", headers: { origin } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("production refuses fake Qwen traffic and /ready reports the provider as unavailable", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllowFake = process.env.ALLOW_FAKE_QWEN;
  process.env.NODE_ENV = "production";
  delete process.env.ALLOW_FAKE_QWEN;
  const key = "production-test-key-1234567890-abcdef";
  const local = await buildServer({
    store: new InMemoryStore(), embedder: new FakeEmbedder(), narrator: new FakeNarrator(),
    auth: { required: true, apiKeys: { "tenant-prod": key } },
  });
  await local.ready();
  try {
    assert.equal((await local.inject({ method: "GET", url: "/health" })).statusCode, 200);
    const ready = await local.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().error, "service temporarily unavailable");
    assert.equal(typeof ready.json().requestId, "string");
    assert.match(ready.json().errorId, /^[0-9a-f-]{36}$/i);
    const recall = await local.inject({ method: "POST", url: "/recall", payload: { question: "test" } });
    assert.equal(recall.statusCode, 503);
    assert.equal(recall.json().error, "service temporarily unavailable");
    assert.doesNotMatch(recall.payload, /Qwen provider|fake models/i);
    assert.equal(typeof recall.json().requestId, "string");
    assert.match(recall.json().errorId, /^[0-9a-f-]{36}$/i);
  } finally {
    await local.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAllowFake === undefined) delete process.env.ALLOW_FAKE_QWEN;
    else process.env.ALLOW_FAKE_QWEN = previousAllowFake;
  }
});

test("missing required auth configuration is an opaque correlated 503", async () => {
  const local = await buildServer({
    store: new InMemoryStore(),
    auth: { required: true, apiKeys: {} },
  });
  await local.ready();
  try {
    const res = await local.inject({ method: "POST", url: "/consolidate", payload: {} });
    assert.equal(res.statusCode, 503);
    const body = res.json();
    assert.equal(body.error, "service temporarily unavailable");
    assert.equal(typeof body.requestId, "string");
    assert.match(body.errorId, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(res.payload, /credential|authentication|configured/i);
  } finally {
    await local.close();
  }
});

test("CORS: only an exact configured dashboard origin receives ACAO", async () => {
  const origin = "https://trusted.example";
  const local = await buildServer({ corsOrigins: [origin] });
  await local.ready();
  try {
    const allowed = await local.inject({ method: "GET", url: "/health", headers: { origin } });
    const denied = await local.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    assert.equal(allowed.headers["access-control-allow-origin"], origin);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  } finally {
    await local.close();
  }
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

test("POST /ingest/documents validates an empty array and enforces an aggregate body cap", async () => {
  const res = await app.inject({ method: "POST", url: "/ingest/documents", payload: { documents: [] } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /documents/);

  // The production default must fit the route's single 8M-character image
  // contract. A small injected ceiling proves Fastify rejects oversized JSON
  // before auth, quota, extraction, or model work is reached.
  assert.ok(DEFAULT_JSON_BODY_LIMIT_BYTES > 8_000_000);
  assert.equal(configuredJsonBodyLimit(undefined), DEFAULT_JSON_BODY_LIMIT_BYTES);
  assert.throws(() => configuredJsonBodyLimit("999"), /1048576/);
  const bounded = await buildServer({ bodyLimitBytes: 1_024 });
  await bounded.ready();
  try {
    const tooLarge = await bounded.inject({
      method: "POST",
      url: "/ingest/documents",
      payload: {
        documents: [{
          doc_id: "large",
          filename: "large.txt",
          source_kind: "text",
          content: "x".repeat(1_100),
        }],
      },
    });
    assert.equal(tooLarge.statusCode, 413);
  } finally {
    await bounded.close();
  }
});

test("global HTTP limiter bounds database/auth route abuse and emits retry metadata", async () => {
  assert.equal(configuredHttpRateLimitMax(undefined), DEFAULT_HTTP_RATE_LIMIT_MAX);
  assert.throws(() => configuredHttpRateLimitMax("0"), /1 to 100000/);
  const limited = await buildServer({ requestRateLimitMax: 2 });
  await limited.ready();
  try {
    assert.equal((await limited.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await limited.inject({ method: "GET", url: "/health" })).statusCode, 200);
    const blocked = await limited.inject({ method: "GET", url: "/health" });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error, "request rate limit exceeded");
    assert.equal(blocked.headers["x-ratelimit-limit"], "2");
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
  } finally {
    await limited.close();
  }
});

test("global HTTP limiter isolates forwarded clients behind the configured one-hop proxy", async () => {
  const limited = await buildServer({ requestRateLimitMax: 2, trustProxy: 1 });
  await limited.ready();
  try {
    const clientA = { "x-forwarded-for": "203.0.113.10" };
    const clientB = { "x-forwarded-for": "198.51.100.20" };
    assert.equal((await limited.inject({ method: "GET", url: "/health", headers: clientA })).statusCode, 200);
    assert.equal((await limited.inject({ method: "GET", url: "/health", headers: clientA })).statusCode, 200);
    assert.equal((await limited.inject({ method: "GET", url: "/health", headers: clientA })).statusCode, 429);
    assert.equal(
      (await limited.inject({ method: "GET", url: "/health", headers: clientB })).statusCode,
      200,
      "one client must not consume another forwarded client's rate-limit bucket",
    );
  } finally {
    await limited.close();
  }
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

test("makeDailyLimiter: buckets independently per key (per-IP isolation)", () => {
  const day = "2026-07-06T10:00:00Z";
  const take = makeDailyLimiter(2, () => new Date(day));
  // IP a exhausts its own bucket…
  assert.equal(take("1.1.1.1").ok, true);
  assert.equal(take("1.1.1.1").ok, true);
  assert.equal(take("1.1.1.1").ok, false); // a is blocked
  // …but IP b still has a fresh, untouched bucket.
  assert.equal(take("2.2.2.2").ok, true);
  assert.equal(take("2.2.2.2").ok, true);
  assert.equal(take("2.2.2.2").ok, false);
  // The default key is a distinct shared bucket, untouched by either IP.
  assert.equal(take().ok, true);
});

test("POST /ingest/invoice is strict, idempotent, and rejects changed retries", async () => {
  const store = new InMemoryStore();
  const local = await buildServer({ store, embedder: new FakeEmbedder(), narrator: new FakeNarrator() });
  await local.ready();
  const invoice = {
    type: "purchase",
    company: "Acme Ltd",
    period: "2026-07",
    date: "2026-07-10",
    currency: "EUR",
    total: 1_250,
    invoice_ref: "SUP-77",
    vendor: "Northwind",
    paid_amount: 500,
    status: "partial",
    payment_date: "2026-07-12",
  };
  try {
    const unexpected = await local.inject({
      method: "POST",
      url: "/ingest/invoice",
      payload: { invoice: { ...invoice, tenant_id: "attacker", approve: true } },
    });
    assert.equal(unexpected.statusCode, 400);
    assert.equal(await store.count(), 0);

    const first = await local.inject({ method: "POST", url: "/ingest/invoice", payload: { invoice } });
    const retry = await local.inject({ method: "POST", url: "/ingest/invoice", payload: { invoice } });
    assert.equal(first.statusCode, 200);
    assert.equal(retry.statusCode, 200);
    assert.equal(first.json().id, retry.json().id);
    assert.equal(await store.count(), 1);
    const [stored] = await store.listForAudit({ company: "Acme Ltd" });
    assert.equal(stored?.kind, "invoice");
    assert.deepEqual(stored?.metadata, {
      type: "purchase", record: "invoice:purchase:northwind:sup-77",
      currency: "EUR", total: 1_250, invoice_date: "2026-07-10",
      invoice_number: "SUP-77", vendor: "Northwind", vendor_ref: "SUP-77",
      paid_amount: 500, payment_status: "partial", payment_date: "2026-07-12",
    });

    const conflict = await local.inject({
      method: "POST", url: "/ingest/invoice", payload: { invoice: { ...invoice, total: 1_500 } },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(await store.count(), 1);

    const wrongParty = await local.inject({
      method: "POST", url: "/ingest/invoice", payload: { invoice: { ...invoice, vendor: undefined, customer: "Wrong" } },
    });
    assert.equal(wrongParty.statusCode, 400);
    const wrongPeriod = await local.inject({
      method: "POST", url: "/ingest/invoice", payload: { invoice: { ...invoice, period: "2026-06" } },
    });
    assert.equal(wrongPeriod.statusCode, 400);
    const impossiblePaymentDate = await local.inject({
      method: "POST", url: "/ingest/invoice", payload: { invoice: { ...invoice, payment_date: "2026-07-01" } },
    });
    assert.equal(impossiblePaymentDate.statusCode, 400);
  } finally {
    await local.close();
  }
});

test("two-tier quota is atomic: a full global tier does not burn subject budget", async () => {
  const quota = new InMemoryDailyQuotaBackend(() => new Date("2026-07-14T12:00:00.000Z"));
  assert.equal((await quota.consume("recall:global", "global", 1)).ok, true);
  const rejected = await consumeTwoTierQuota(quota, "recall", "judge-a", 1, 1);
  assert.equal(rejected.ok, false);
  // If the failed batch had partially incremented the subject tier, this direct
  // first charge would also be rejected. Atomic rollback leaves it available.
  const subject = await quota.consume("recall:subject", "judge-a", 1);
  assert.equal(subject.ok, true);
  assert.equal(subject.remaining, 0);
});

test("PostgreSQL pool size is finite, integral, and safely clamped", () => {
  assert.equal(pgPoolMax(undefined), 5);
  assert.equal(pgPoolMax("NaN"), 5);
  assert.equal(pgPoolMax("0"), 1);
  assert.equal(pgPoolMax("7.9"), 7);
  assert.equal(pgPoolMax("999"), 50);
});

test("POST /ingest/documents: per-IP + global backstop both meter, per-IP is isolated", async () => {
  // A fresh server with tiny caps proves the two-tier guard end to end over the
  // real route (no DB is reached — the 429 fires before the pipeline runs).
  const prevIp = process.env.INGEST_DAILY_LIMIT;
  const prevGlobal = process.env.INGEST_DAILY_LIMIT_GLOBAL;
  const prevTrust = process.env.TRUST_PROXY_HOPS;
  process.env.INGEST_DAILY_LIMIT = "1"; // 1 ingest per IP
  process.env.INGEST_DAILY_LIMIT_GLOBAL = "10"; // generous global backstop
  process.env.TRUST_PROXY_HOPS = "1";
  // Re-import with the fresh env (module reads the caps at import time). The
  // query string busts the ESM cache; a variable specifier keeps tsc from
  // statically resolving the (intentionally cache-busting) path.
  const perIpSpecifier = "../../src/server.js?perip=1";
  const { buildServer: build } = await import(perIpSpecifier);
  const local = await build({ store: new InMemoryStore(), trustProxy: 1 });
  await local.ready();
  try {
    const doc = { documents: [{ doc_id: "d1", filename: "d1.json", source_kind: "text", content: '{"doc_type":"payroll_register","gross_pay_total":1,"employer_cost_total":1,"employee_count":0}', company: "C", period: "2026-01" }] };
    const hdrA = { "x-forwarded-for": "9.9.9.9" };
    const hdrB = { "x-forwarded-for": "8.8.8.8" };
    // IP A: first ingest is allowed past the guard (may 500 on no DB — that is the
    // point past the limiter), second is 429.
    const a1 = await local.inject({ method: "POST", url: "/ingest/documents", headers: hdrA, payload: doc });
    assert.notEqual(a1.statusCode, 429, "IP A first ingest must pass the per-IP guard");
    const a2 = await local.inject({ method: "POST", url: "/ingest/documents", headers: hdrA, payload: doc });
    assert.equal(a2.statusCode, 429, "IP A second ingest must be blocked by the per-IP cap");
    // IP B is a different bucket → its first ingest still passes the per-IP guard.
    const b1 = await local.inject({ method: "POST", url: "/ingest/documents", headers: hdrB, payload: doc });
    assert.notEqual(b1.statusCode, 429, "IP B has its own per-IP bucket");
  } finally {
    await local.close();
    if (prevIp === undefined) delete process.env.INGEST_DAILY_LIMIT;
    else process.env.INGEST_DAILY_LIMIT = prevIp;
    if (prevGlobal === undefined) delete process.env.INGEST_DAILY_LIMIT_GLOBAL;
    else process.env.INGEST_DAILY_LIMIT_GLOBAL = prevGlobal;
    if (prevTrust === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = prevTrust;
  }
});

test("POST /ingest/documents: global backstop blocks once total spend is exhausted, across IPs", async () => {
  const prevIp = process.env.INGEST_DAILY_LIMIT;
  const prevGlobal = process.env.INGEST_DAILY_LIMIT_GLOBAL;
  process.env.INGEST_DAILY_LIMIT = "100"; // per-IP is not the binding tier here
  process.env.INGEST_DAILY_LIMIT_GLOBAL = "2"; // total budget of 2 across all IPs
  const globalSpecifier = "../../src/server.js?global=1";
  const { buildServer: build } = await import(globalSpecifier);
  const local = await build({ store: new InMemoryStore(), trustProxy: 1 });
  await local.ready();
  try {
    const doc = { documents: [{ doc_id: "d1", filename: "d1.json", source_kind: "text", content: '{"doc_type":"payroll_register","gross_pay_total":1,"employer_cost_total":1,"employee_count":0}', company: "C", period: "2026-01" }] };
    // Two different IPs consume the global budget of 2…
    const r1 = await local.inject({ method: "POST", url: "/ingest/documents", headers: { "x-forwarded-for": "1.0.0.1" }, payload: doc });
    assert.notEqual(r1.statusCode, 429);
    const r2 = await local.inject({ method: "POST", url: "/ingest/documents", headers: { "x-forwarded-for": "1.0.0.2" }, payload: doc });
    assert.notEqual(r2.statusCode, 429);
    // …a third IP, still under its own per-IP cap, is stopped by the global tier.
    const r3 = await local.inject({ method: "POST", url: "/ingest/documents", headers: { "x-forwarded-for": "1.0.0.3" }, payload: doc });
    assert.equal(r3.statusCode, 429, "global backstop must block once total budget is spent");
  } finally {
    await local.close();
    if (prevIp === undefined) delete process.env.INGEST_DAILY_LIMIT;
    else process.env.INGEST_DAILY_LIMIT = prevIp;
    if (prevGlobal === undefined) delete process.env.INGEST_DAILY_LIMIT_GLOBAL;
    else process.env.INGEST_DAILY_LIMIT_GLOBAL = prevGlobal;
  }
});

test("GET / serves the memory explorer as HTML (200, text/html)", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.match(res.body, /<!doctype html>/i);
  assert.match(res.body, /Archon MemoryAgent/);
  // The page wires the real recall endpoint (not a placeholder).
  assert.match(res.body, /\/recall/);
  // Guided tour assets (inline, no CDN) + the "Take the tour" trigger.
  assert.match(res.body, /Take the tour/);
  assert.match(res.body, /tour-overlay/);
  assert.match(res.body, /data-tour=/);
  // One-click Run demo → seeds via the pipeline, then recalls.
  assert.match(res.body, /Run demo/);
  assert.match(res.body, /\/demo\/seed/);
  // Clear empty-state instead of a blank panel.
  assert.match(res.body, /No memories yet/);
  // Supporting P&L + records views wired to their endpoints.
  assert.match(res.body, /\/pnl/);
  assert.match(res.body, /\/memory\/list/);
  // Template chips are INJECTED from DEMO_TEMPLATES (single source of truth) — the
  // placeholder must have been replaced, so the served page carries the real
  // questions, not the empty-array fallback.
  assert.doesNotMatch(res.body, /\/\*__ARCHON_TEMPLATES__\*\//, "template placeholder was not replaced");
  for (const t of DEMO_TEMPLATES) {
    assert.ok(res.body.includes(t.q), `served UI is missing template chip "${t.q}"`);
  }
  // Browse-memories affordance: the "memories N" count badge is a clickable door
  // into the stored memories (FIX 2 — count → browsable list), not a dead number.
  assert.match(res.body, /class="pill pill-btn" id="count"/);
  assert.match(res.body, /Browse memories/);
  assert.match(res.body, /browseMore/);
  assert.match(res.body, /id="judgeToken"/);
  assert.match(res.body, /id="semanticBtn"/);
  assert.match(res.body, /headers\.authorization = 'Bearer ' \+ token/);
  assert.match(res.body, /\/consistency\/semantic/);
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
  for (const path of ["/health", "/ready", "/recall", "/feedback", "/ingest", "/ingest/invoice", "/ingest/documents", "/pnl", "/memory/list", "/demo/seed", "/memory/count", "/consistency", "/consistency/semantic", "/consolidate", "/forget"]) {
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

test("POST /consistency/semantic flags a meaning-only contradiction the rule-based audit misses", async () => {
  // Seed two same-vendor memories opposed ONLY in prose (identical metadata) plus
  // an unrelated one, then hit the semantic route with the offline Fakes.
  const store = new InMemoryStore();
  const seed = async (content: string) =>
    store.remember({
      kind: "insight",
      company: "Acme",
      period: "2026-05",
      sourceRef: null,
      content,
      metadata: { vendor: "Northwind Trading" },
      embedding: [1, 0, 0],
      embedModel: "fake",
    });
  await seed("Vendor Northwind Trading reliably pays every invoice on time each month.");
  await seed("Vendor Northwind Trading pays every invoice late; chronically late each month.");
  await store.remember({
    kind: "insight",
    company: "Acme",
    period: "2026-05",
    sourceRef: null,
    content: "Office electricity spend rose sharply after the summer heatwave.",
    metadata: { vendor: "PowerCo" },
    embedding: [0, 1, 0],
    embedModel: "fake",
  });

  const local = await buildServer({ store });
  await local.ready();
  try {
    const res = await local.inject({
      method: "POST",
      url: "/consistency/semantic",
      payload: { company: "Acme", similarityThreshold: 0.3 },
    });
    assert.equal(res.statusCode, 200);
    const report = res.json();
    assert.equal(report.audited, 3);
    assert.equal(report.semanticContradictions.length, 1);
    assert.equal(report.semanticContradictions[0].type, "semantic-contradiction");
    assert.ok(report.semanticContradictions[0].resolution.recommendedMemoryId);
    assert.equal(report.ok, false);
  } finally {
    await local.close();
  }
});

test("global error handler: a server fault becomes an opaque correlated 503", async () => {
  // A store whose count() throws a generic error exercises the /memory/count
  // handler → the global setErrorHandler, which must answer a generic envelope
  // with correlation ids. The detailed exception belongs only in server logs.
  const brokenStore = {
    ...new InMemoryStore(),
    async count(): Promise<number> {
      throw new Error("memory store unreachable");
    },
  } as unknown as NonNullable<Parameters<typeof buildServer>[0]>["store"];
  const local = await buildServer({ store: brokenStore });
  await local.ready();
  try {
    const res = await local.inject({ method: "GET", url: "/memory/count" });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(Object.keys(res.json()).sort(), ["error", "errorId", "requestId"]);
    assert.equal(res.json().error, "service temporarily unavailable");
    assert.equal(typeof res.json().requestId, "string");
    assert.match(res.json().errorId, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(res.payload, /memory store unreachable/);
    assert.doesNotMatch(res.json().error, /at .*\(.*:\d+:\d+\)/); // no stack frames leaked
  } finally {
    await local.close();
  }
});

test("global error handler: a thrown client (4xx) status is preserved, not masked as 503", async () => {
  // An error carrying its own 4xx status (e.g. a bad-request-shaped store error)
  // must keep that status — the handler only defaults server faults to 503.
  const badRequestStore = {
    ...new InMemoryStore(),
    async count(): Promise<number> {
      throw Object.assign(new Error("bad memory query"), { statusCode: 400 });
    },
  } as unknown as NonNullable<Parameters<typeof buildServer>[0]>["store"];
  const local = await buildServer({ store: badRequestStore });
  await local.ready();
  try {
    const res = await local.inject({ method: "GET", url: "/memory/count" });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /bad memory query/);
  } finally {
    await local.close();
  }
});
