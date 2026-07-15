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
  configuredTrustProxy,
  DOCUMENT_INGEST_WORK_UNITS_PER_DOCUMENT,
  configuredHttpRateLimitMax,
  configuredJsonBodyLimit,
  DEFAULT_HTTP_RATE_LIMIT_MAX,
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  DEEP_READINESS_WORK_UNITS,
  LOGGER_REDACT_PATHS,
  makeDailyLimiter,
  RECALL_WORK_UNITS,
} from "../../src/server.js";
import {
  DEMO_COMPANY,
  DEMO_INVOICE_RECORD,
  DEMO_SEED_SENTINEL_SOURCE_REF,
  DEMO_SEED_VERSION,
  DEMO_TEMPLATES,
} from "../../src/demo-data.js";
import { InMemoryStore, type StoredMemory } from "../../src/memory/store.js";
import { FakeEmbedder, type Embedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { UI_HTML } from "../../src/ui.js";
import { consumeTwoTierQuota, InMemoryDailyQuotaBackend } from "../../src/server/quota.js";
import { pgPoolMax } from "../../src/db/client.js";
import { TieredQwenAdmission } from "../../src/server/admission.js";
import type { Reranker } from "../../src/memory/rerank.js";
import { rawDocumentSchema } from "../../src/server/validation.js";

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

test("GET /health returns embedder, narrator, and semantic-judge identity (no DB, no key)", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.ok(typeof body.embedder === "string" && body.embedder.length > 0);
  assert.ok(typeof body.narrator === "string" && body.narrator.length > 0);
  assert.ok(typeof body.judge === "string" && body.judge.length > 0);
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
    const res = await local.inject({
      method: "POST", url: "/consolidate",
      payload: { operationId: "missing-auth-config", reason: "verify fail-closed auth" },
    });
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
    const fictionalCurrency = await local.inject({
      method: "POST", url: "/ingest/invoice", payload: { invoice: { ...invoice, currency: "ABC" } },
    });
    assert.equal(fictionalCurrency.statusCode, 400);
    assert.match(fictionalCurrency.json().error, /supported ISO 4217/i);
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
  assert.equal((await quota.consume("recall:public:global", "public", 1)).ok, true);
  const rejected = await consumeTwoTierQuota(quota, "recall", "judge-a", 1, 1);
  assert.equal(rejected.ok, false);
  // If the failed batch had partially incremented the subject tier, this direct
  // first charge would also be rejected. Atomic rollback leaves it available.
  const subject = await quota.consume("recall:public:subject", "judge-a", 1);
  assert.equal(subject.ok, true);
  assert.equal(subject.remaining, 0);
});

test("weighted two-tier quota atomically reserves model-work units", async () => {
  const quota = new InMemoryDailyQuotaBackend(() => new Date("2026-07-15T12:00:00.000Z"));
  const accepted = await consumeTwoTierQuota(quota, "ingest", "reviewer", 20, 20, "judge", 20);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.remaining, 0);
  const rejected = await consumeTwoTierQuota(quota, "ingest", "reviewer", 20, 20, "judge", 1);
  assert.equal(rejected.ok, false);
});

test("a 20-document request reserves conservative model/write work before extraction", async () => {
  let seenUnits: number[] = [];
  const local = await buildServer({
    store: new InMemoryStore(),
    quotaBackend: {
      async consume() { throw new Error("route must use atomic two-tier metering"); },
      async consumeMany(charges) {
        seenUnits = charges.map((charge) => charge.units ?? 1);
        return { ok: false, remaining: 0, limit: 99, resetAt: "2026-07-16T00:00:00.000Z" };
      },
    },
  });
  await local.ready();
  try {
    const documents = Array.from({ length: 20 }, (_, index) => ({
      doc_id: `d${index}`,
      filename: `d${index}.json`,
      source_kind: "text",
      content: '{"doc_type":"payroll_register","gross_pay_total":1}',
      company: "C",
      period: "2026-07",
    }));
    const response = await local.inject({ method: "POST", url: "/ingest/documents", payload: { documents } });
    assert.equal(response.statusCode, 429);
    const expected = 20 * DOCUMENT_INGEST_WORK_UNITS_PER_DOCUMENT;
    assert.deepEqual(seenUnits, [expected, expected], "both atomic tiers reserve extraction and prospective writes");
  } finally {
    await local.close();
  }
});

test("POST /ingest charges exact prospective memories, derives ratios, and rejects amplification/inconsistent totals before provider work", async () => {
  const store = new InMemoryStore();
  const charged: number[][] = [];
  const local = await buildServer({
    store,
    embedder: new FakeEmbedder(),
    narrator: new FakeNarrator(),
    quotaBackend: {
      async consume() { throw new Error("route must use atomic two-tier metering"); },
      async consumeMany(charges) {
        charged.push(charges.map((charge) => charge.units ?? 1));
        return { ok: true, remaining: 95, limit: 100, resetAt: "2026-07-16T00:00:00.000Z" };
      },
    },
  });
  await local.ready();
  const makeEvent = (count: number) => ({
    event_id: `evt-direct-${count}`,
    company: "Direct Co",
    period: "2026-07",
    currency: "EUR",
    employee_count: count,
    bank_net_total: count * 80,
    gross_total: count * 100,
    employer_social_security_total: count * 20,
    employee_social_security_total: count * 10,
    tax_withheld_total: count * 10,
    employer_cost_total: count * 120,
    // Deliberately stale caller-derived values; trusted ingestion overwrites all.
    cost_gap_amount: 999,
    cost_gap_pct: 999,
    off_bank_cost: 999,
    off_bank_cost_pct: 999,
    employees: Array.from({ length: count }, (_, index) => ({
      employee_id: `E-${index + 1}`,
      name: `Employee ${index + 1}`,
      gross: 100,
      employee_social_security: 10,
      tax: 10,
      net: 80,
      employer_social_security: 20,
      employer_cost: 120,
    })),
    linked_docs: [],
  });
  try {
    const accepted = await local.inject({
      method: "POST", url: "/ingest", payload: { event: makeEvent(3) },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().written, 5);
    assert.deepEqual(charged, [[5, 5]], "summary + insight + three employee memories are reserved atomically");
    const insight = (await store.listForAudit({ company: "Direct Co", kind: "insight" }))[0]!;
    assert.equal(insight.metadata?.off_bank_cost, 120);
    assert.equal(insight.metadata?.off_bank_cost_pct, 50);
    assert.equal(insight.metadata?.cost_gap_amount, 60);
    assert.equal(insight.metadata?.cost_gap_pct, 25);

    const inconsistent = makeEvent(3);
    inconsistent.event_id = "evt-inconsistent";
    inconsistent.employer_cost_total += 1;
    const rejectedTotals = await local.inject({
      method: "POST", url: "/ingest", payload: { event: inconsistent },
    });
    assert.equal(rejectedTotals.statusCode, 400);
    assert.equal(charged.length, 1, "invalid arithmetic is rejected before quota/provider work");
    assert.equal(await store.count("Direct Co"), 5);

    const inconsistentEmployees = makeEvent(3);
    inconsistentEmployees.event_id = "evt-inconsistent-employees";
    inconsistentEmployees.gross_total += 1;
    inconsistentEmployees.employer_cost_total += 1;
    const rejectedEmployeeSums = await local.inject({
      method: "POST", url: "/ingest", payload: { event: inconsistentEmployees },
    });
    assert.equal(rejectedEmployeeSums.statusCode, 400);
    assert.match(rejectedEmployeeSums.json().error, /sum of employee rows/i);

    const missingEmployee = makeEvent(3);
    missingEmployee.event_id = "evt-missing-employee";
    missingEmployee.employees.pop();
    const rejectedCompleteness = await local.inject({
      method: "POST", url: "/ingest", payload: { event: missingEmployee },
    });
    assert.equal(rejectedCompleteness.statusCode, 400);
    assert.match(rejectedCompleteness.json().error, /exactly employee_count/i);

    const fictionalCurrencyEvent = makeEvent(3);
    fictionalCurrencyEvent.event_id = "evt-fictional-currency";
    fictionalCurrencyEvent.currency = "ABC";
    const rejectedCurrency = await local.inject({
      method: "POST", url: "/ingest", payload: { event: fictionalCurrencyEvent },
    });
    assert.equal(rejectedCurrency.statusCode, 400);
    assert.match(rejectedCurrency.json().error, /supported ISO 4217/i);
    assert.equal(charged.length, 1, "all invalid fused events fail before quota/provider work");

    const oversized = await local.inject({
      method: "POST", url: "/ingest", payload: { event: makeEvent(51) },
    });
    assert.equal(oversized.statusCode, 400, "the strict 50-employee request contract blocks provider amplification");
    assert.equal(charged.length, 1);
    assert.equal(await store.count("Direct Co"), 5);
  } finally {
    await local.close();
  }
});

test("structured logger redacts every supported reviewer credential header shape", () => {
  assert.ok(LOGGER_REDACT_PATHS.includes("req.headers.authorization"));
  assert.ok(LOGGER_REDACT_PATHS.includes('req.headers["x-api-key"]'));
  assert.ok(LOGGER_REDACT_PATHS.includes("req.headers.cookie"));
});

test("POST /demo/seed reconciles a failed partial seed, then the completion sentinel makes retries no-op", async () => {
  class FailAfterPipelineStore extends InMemoryStore {
    failOnce = true;
    override async rememberMany(memories: StoredMemory[]): Promise<string[]> {
      if (this.failOnce && memories.some((memory) => memory.idempotencyKey === "demo:contradiction:0")) {
        this.failOnce = false;
        throw new Error("injected post-pipeline seed failure");
      }
      return super.rememberMany(memories);
    }
  }
  const store = new FailAfterPipelineStore();
  const local = await buildServer({ store, embedder: new FakeEmbedder(), narrator: new FakeNarrator() });
  await local.ready();
  try {
    const failed = await local.inject({ method: "POST", url: "/demo/seed" });
    assert.equal(failed.statusCode, 503);
    const partial = await store.listForAudit({ company: DEMO_COMPANY });
    assert.ok(partial.some((memory) => memory.kind === "payroll_event"), "pipeline rows must expose the partial-state setup");
    assert.equal(partial.some((memory) => memory.sourceRef === DEMO_SEED_SENTINEL_SOURCE_REF), false);

    const repaired = await local.inject({ method: "POST", url: "/demo/seed" });
    assert.equal(repaired.statusCode, 200);
    assert.equal(repaired.json().reconciled, true);
    assert.equal(repaired.json().alreadySeeded, false);
    assert.equal(repaired.json().seedVersion, DEMO_SEED_VERSION);
    const complete = await store.listForAudit({ company: DEMO_COMPANY });
    assert.equal(complete.filter((memory) => memory.sourceRef === DEMO_SEED_SENTINEL_SOURCE_REF).length, 1);
    assert.equal(complete.filter((memory) => memory.kind === "invoice").length, 2);
    assert.equal(complete.filter((memory) => memory.kind === "insight" && /supplier invoices/.test(memory.content)).length, 2);

    const audit = await local.inject({ method: "POST", url: "/consistency", payload: { company: DEMO_COMPANY } });
    assert.equal(audit.statusCode, 200);
    assert.ok(audit.json().contradictions.some((finding: { subject: string }) => finding.subject === DEMO_INVOICE_RECORD));

    const countAfterRepair = await store.count(DEMO_COMPANY);
    const again = await local.inject({ method: "POST", url: "/demo/seed" });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().alreadySeeded, true);
    assert.equal(again.json().seeded, 0);
    assert.equal(await store.count(DEMO_COMPANY), countAfterRepair, "completed retries must not duplicate any row");
  } finally {
    await local.close();
  }
});

test("POST /demo/seed upgrades a completed legacy seed without idempotency conflict or stale financial rows", async () => {
  const store = new InMemoryStore();
  const legacyEventId = "evt-northwind-trading-monthly-consolidated-legacy-2026-05";
  const embedding = [1, 0, 0];
  await store.rememberMany([
    {
      kind: "payroll_event", company: DEMO_COMPANY, period: "2026-05", sourceRef: legacyEventId,
      content: `Workforce cost for ${DEMO_COMPANY} in 2026-05: 3 employees, gross 12,000 currency units, true employer cost 14,600 currency units, net paid from bank 10,800 currency units.`,
      metadata: { employer_cost_total: 14600, gross_total: 12000, bank_net_total: 10800, employee_count: 3 },
      idempotencyKey: `event:${legacyEventId}:summary`, embedding, embedModel: "legacy-fixture",
    },
    {
      kind: "insight", company: DEMO_COMPANY, period: "2026-05", sourceRef: legacyEventId,
      content: `Off-bank workforce cost at ${DEMO_COMPANY} for 2026-05: 3,800 currency units (24.1% of the transfer).`,
      metadata: { off_bank_cost: 3800, cost_gap_pct: 24.1 },
      idempotencyKey: `event:${legacyEventId}:insight`, embedding, embedModel: "legacy-fixture",
    },
    {
      kind: "payroll_event", company: DEMO_COMPANY, period: "2026-05", sourceRef: `${legacyEventId}:E-01`,
      content: `Ana Cole (id E-01) at ${DEMO_COMPANY} in 2026-05: gross 5,000 currency units, net 4,500 currency units, employer cost 5,900 currency units.`,
      metadata: { employee_id: "E-01", gross: 5000, net: 4500 },
      idempotencyKey: `event:${legacyEventId}:employee:E-01`, embedding, embedModel: "legacy-fixture",
    },
    {
      kind: "action", company: DEMO_COMPANY, period: "2026-05",
      sourceRef: "demo-seed:memoryagent-demo-v2:complete",
      content: "Built-in demo seed memoryagent-demo-v2 completed.",
      metadata: { demoSeedVersion: "memoryagent-demo-v2", status: "complete" },
      idempotencyKey: "demo-seed:memoryagent-demo-v2:complete", embedding, embedModel: "legacy-fixture",
    },
  ]);
  const local = await buildServer({ store, embedder: new FakeEmbedder(), narrator: new FakeNarrator() });
  await local.ready();
  try {
    const upgraded = await local.inject({ method: "POST", url: "/demo/seed" });
    assert.equal(upgraded.statusCode, 200, upgraded.payload);
    assert.equal(upgraded.json().reconciled, true);
    assert.equal(upgraded.json().seedVersion, DEMO_SEED_VERSION);

    const active = await store.listForAudit({ company: DEMO_COMPANY });
    assert.equal(active.some((memory) => memory.sourceRef?.startsWith(legacyEventId)), false);
    assert.equal(active.filter((memory) => memory.kind === "payroll_event" && /Workforce cost/.test(memory.content)).length, 1);
    const currentInsight = active.find((memory) =>
      memory.kind === "insight" && /Off-bank workforce-cost comparison/.test(memory.content)
    );
    assert.ok(currentInsight);
    assert.match(currentInsight.content, /EUR 3,800 \(35\.2% of the transfer\)/);
    assert.match(currentInsight.content, /EUR 2,600 \(24\.1% of the bank transfer\)/);

    const pnl = await local.inject({ method: "GET", url: "/pnl" });
    assert.equal(pnl.statusCode, 200);
    assert.equal(pnl.json().currency_status, "single");
    assert.equal(pnl.json().currency, "EUR");
    assert.equal(pnl.json().unknown_currency_records, 0);
    assert.equal(pnl.json().employer_cost_total, 14600);

    const count = await store.count(DEMO_COMPANY);
    const retry = await local.inject({ method: "POST", url: "/demo/seed" });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().alreadySeeded, true);
    assert.equal(await store.count(DEMO_COMPANY), count);
  } finally {
    await local.close();
  }
});

test("public quota exhaustion cannot starve the bounded authenticated judge reserve", async () => {
  const names = [
    "RECALL_DAILY_LIMIT",
    "RECALL_DAILY_LIMIT_GLOBAL",
    "RECALL_DAILY_LIMIT_JUDGE_RESERVE",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.RECALL_DAILY_LIMIT = String(RECALL_WORK_UNITS + 1);
  process.env.RECALL_DAILY_LIMIT_GLOBAL = String(RECALL_WORK_UNITS);
  process.env.RECALL_DAILY_LIMIT_JUDGE_RESERVE = String(RECALL_WORK_UNITS);
  const key = "judge-reserve-key-1234567890-abcdef"; // gitleaks:allow — deterministic non-secret test fixture
  const local = await buildServer({
    store: new InMemoryStore(),
    embedder: new FakeEmbedder(3),
    narrator: new FakeNarrator(),
    quotaBackend: new InMemoryDailyQuotaBackend(() => new Date("2026-07-15T12:00:00.000Z")),
    auth: { required: true, apiKeys: { "tenant-reserved": key } },
  });
  await local.ready();
  const recall = (headers?: Record<string, string>) => local.inject({
    method: "POST",
    url: "/recall",
    headers,
    payload: { question: "What is remembered?" },
  });
  try {
    const publicAccepted = await recall();
    assert.equal(publicAccepted.statusCode, 200);
    assert.equal(publicAccepted.headers["x-ratelimit-pool"], "public");
    assert.equal(publicAccepted.headers["x-ratelimit-remaining"], "0", "recall atomically reserves four logical model-work units");
    assert.equal((await recall()).statusCode, 429, "public global pool should now be exhausted");

    const invalid = await recall({ "x-api-key": "invalid-credential" });
    assert.equal(invalid.statusCode, 401, "invalid credentials must never enter the reserve");

    const judgeAccepted = await recall({ "x-api-key": key });
    assert.equal(judgeAccepted.statusCode, 200, "valid reviewer retains one bounded reserved call");
    assert.equal(judgeAccepted.headers["x-ratelimit-pool"], "judge");
    const judgeExhausted = await recall({ authorization: `Bearer ${key}` });
    assert.equal(judgeExhausted.statusCode, 429, "judge reserve remains finite and enforceable");
  } finally {
    await local.close();
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("public in-flight saturation starts no extra provider work and cannot consume the reviewer slot", async () => {
  const store = new InMemoryStore();
  await store.rememberMany([
    { tenantId: "_public", kind: "insight", company: "C", content: "Public fact.", embedding: [1, 0, 0], embedModel: "controlled-embedder" },
    { tenantId: "tenant-reviewer", kind: "insight", company: "C", content: "Reviewer fact.", embedding: [1, 0, 0], embedModel: "controlled-embedder" },
  ]);
  let calls = 0;
  const releases: Array<() => void> = [];
  const embedder: Embedder = {
    modelId: "controlled-embedder",
    dim: 3,
    async embed() {
      calls += 1;
      return new Promise<number[]>((resolve) => releases.push(() => resolve([1, 0, 0])));
    },
  };
  const key = "judge-admission-key-1234567890"; // gitleaks:allow — deterministic non-secret test fixture
  const admission = new TieredQwenAdmission(1, 1);
  const admissionAttempts: Array<"public" | "judge"> = [];
  const local = await buildServer({
    store,
    embedder,
    narrator: new FakeNarrator(),
    auth: { required: true, apiKeys: { "tenant-reviewer": key } },
    qwenAdmission: {
      tryAcquire(pool) {
        admissionAttempts.push(pool);
        return admission.tryAcquire(pool);
      },
    },
  });
  await local.ready();
  const waitForCalls = async (target: number) => {
    for (let i = 0; i < 100 && calls < target; i++) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    assert.equal(calls, target, `expected ${target} provider calls to start`);
  };
  try {
    const publicInFlight = local.inject({ method: "POST", url: "/recall", payload: { question: "public?" } });
    await waitForCalls(1);
    const publicDenied = await local.inject({ method: "POST", url: "/recall", payload: { question: "another public?" } });
    assert.equal(publicDenied.statusCode, 503);
    assert.equal(publicDenied.headers["retry-after"], "2");
    assert.equal(calls, 1, "denied public request must not enter the provider");

    for (const bogus of [
      { authorization: "Bearer definitely-not-a-valid-reviewer" },
      { "x-api-key": "also-not-a-valid-reviewer" },
    ]) {
      const denied = await local.inject({
        method: "POST", url: "/recall", headers: bogus, payload: { question: "steal reserve?" },
      });
      assert.equal(denied.statusCode, 401);
    }
    assert.equal(
      admissionAttempts.filter((pool) => pool === "judge").length,
      0,
      "bogus credential headers are rejected before any judge-pool acquisition attempt",
    );
    assert.deepEqual(admission.snapshot(), { public: 1, judge: 0 });

    const judgeInFlight = local.inject({
      method: "POST", url: "/recall", headers: { authorization: `Bearer ${key}` }, payload: { question: "reviewer?" },
    });
    await waitForCalls(2);
    assert.equal(admissionAttempts.filter((pool) => pool === "judge").length, 1);
    while (releases.length) releases.shift()!();
    assert.equal((await publicInFlight).statusCode, 200);
    assert.equal((await judgeInFlight).statusCode, 200, "reviewer reserve remains available during public saturation");
  } finally {
    while (releases.length) releases.shift()!();
    await local.close();
  }
});

test("timed-out reranks abort and drain before admission capacity is released", async () => {
  const store = new InMemoryStore();
  await store.rememberMany([
    { tenantId: "_public", kind: "insight", company: "C", content: "First recall candidate.", embedding: [1, 0, 0], embedModel: "controlled-embedder" },
    { tenantId: "_public", kind: "insight", company: "C", content: "Second recall candidate.", embedding: [1, 0, 0], embedModel: "controlled-embedder" },
  ]);
  const embedder: Embedder = { modelId: "controlled-embedder", dim: 3, async embed() { return [1, 0, 0]; } };
  let activeProviderCalls = 0;
  let maximumActiveProviderCalls = 0;
  let abortsObserved = 0;
  const reranker: Reranker = {
    modelId: "abort-drain-reranker",
    async rerank(_query, _docs, signal) {
      activeProviderCalls += 1;
      maximumActiveProviderCalls = Math.max(maximumActiveProviderCalls, activeProviderCalls);
      return new Promise((_resolve, reject) => {
        const abort = () => {
          abortsObserved += 1;
          // Model a provider that needs a short asynchronous cleanup after abort.
          setTimeout(() => {
            activeProviderCalls -= 1;
            reject(signal?.reason ?? new Error("aborted"));
          }, 500);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const admission = new TieredQwenAdmission(1, 1);
  const previousTimeout = process.env.RERANK_TIMEOUT_MS;
  process.env.RERANK_TIMEOUT_MS = "100";
  const local = await buildServer({ store, embedder, narrator: new FakeNarrator(), reranker, qwenAdmission: admission });
  await local.ready();
  const waitUntil = async (predicate: () => boolean, message: string) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    assert.equal(predicate(), true, message);
  };
  try {
    const first = local.inject({ method: "POST", url: "/recall", payload: { question: "candidate", limit: 2 } });
    await waitUntil(() => abortsObserved === 1 && activeProviderCalls === 1, "provider must be aborting but not drained yet");
    assert.deepEqual(admission.snapshot(), { public: 1, judge: 0 }, "slot stays held during provider cleanup");

    const burst = await Promise.all(Array.from({ length: 5 }, () =>
      local.inject({ method: "POST", url: "/recall", payload: { question: "burst", limit: 2 } })));
    assert.deepEqual(burst.map((response) => response.statusCode), [503, 503, 503, 503, 503]);
    assert.equal(maximumActiveProviderCalls, 1, "timed burst must never exceed provider capacity");

    const completed = await first;
    assert.equal(completed.statusCode, 200, "recall degrades to the already retrieved hybrid candidates");
    assert.equal(completed.json().retrieval.reranker.status, "fallback");
    assert.equal(activeProviderCalls, 0, "aborted provider work must fully drain");
    assert.deepEqual(admission.snapshot(), { public: 0, judge: 0 }, "capacity releases only after drain");
  } finally {
    await local.close();
    if (previousTimeout === undefined) delete process.env.RERANK_TIMEOUT_MS;
    else process.env.RERANK_TIMEOUT_MS = previousTimeout;
  }
});

test("Qwen admission releases its slot after a provider failure", async () => {
  const store = new InMemoryStore();
  await store.remember({ tenantId: "_public", kind: "insight", company: "C", content: "Fact.", embedding: [1, 0, 0], embedModel: "fail-once-embedder" });
  let calls = 0;
  const embedder: Embedder = {
    modelId: "fail-once-embedder",
    dim: 3,
    async embed() {
      calls += 1;
      if (calls === 1) throw new Error("injected provider failure");
      return [1, 0, 0];
    },
  };
  const local = await buildServer({
    store, embedder, narrator: new FakeNarrator(), qwenAdmission: new TieredQwenAdmission(1, 1),
  });
  await local.ready();
  try {
    assert.equal((await local.inject({ method: "POST", url: "/recall", payload: { question: "first" } })).statusCode, 503);
    assert.equal((await local.inject({ method: "POST", url: "/recall", payload: { question: "second" } })).statusCode, 200);
    assert.equal(calls, 2, "failure must release capacity for the next request");
  } finally {
    await local.close();
  }
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
  process.env.INGEST_DAILY_LIMIT = "5"; // one single-document reservation per IP
  process.env.INGEST_DAILY_LIMIT_GLOBAL = "50"; // generous global backstop
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
  process.env.INGEST_DAILY_LIMIT_GLOBAL = "10"; // two single-document reservations across all IPs
  const globalSpecifier = "../../src/server.js?global=1";
  const { buildServer: build } = await import(globalSpecifier);
  const local = await build({ store: new InMemoryStore(), trustProxy: 1 });
  await local.ready();
  try {
    const doc = { documents: [{ doc_id: "d1", filename: "d1.json", source_kind: "text", content: '{"doc_type":"payroll_register","gross_pay_total":1,"employer_cost_total":1,"employee_count":0}', company: "C", period: "2026-01" }] };
    // Two different IPs consume the global budget of 10 work units…
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
  assert.match(
    res.body,
    /const s = await api\('POST', '\/demo\/seed'\);\s*\$\('company'\)\.value = s\.company \|\| 'Northwind Trading';[\s\S]*?await refreshAll\(\);/,
    "one-click demo must scope the company before refreshing its P&L",
  );
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
  // Judge-visible resolution loop is real, not decorative: a Session A/B
  // provenance timeline drives authenticated, idempotent /feedback mutations.
  assert.match(res.body, /SESSION/);
  assert.match(res.body, /Accept recommendation/);
  assert.match(res.body, /Override with Session ' \+ session/);
  assert.match(res.body, /data-selected-memory-id/);
  assert.match(res.body, /alternatives\.forEach/);
  assert.doesNotMatch(res.body, /text: 'Override with Session A'/);
  assert.match(res.body, /Defer — no write/);
  assert.match(res.body, /api\('POST', '\/resolve-conflict'/);
  assert.match(res.body, /memory-ui-resolution-v1/);
  assert.doesNotMatch(res.body, /correctedFact: correctionFact/);
  assert.match(res.body, /before\/after provenance/i);
  assert.match(res.body, /sessionStorage/);
  assert.doesNotMatch(res.body, /Open Autopilot/);
  const csp = String(res.headers["content-security-policy"] ?? "");
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, "judge UI must receive a per-response script nonce");
  assert.doesNotMatch(csp, /unsafe-inline/, "judge UI CSP must not allow arbitrary inline script/style");
  assert.match(csp, /style-src-attr 'none'/, "judge UI must reject every inline style attribute");
  assert.match(res.body, new RegExp(`<script nonce="${nonce}"`));
  assert.match(res.body, new RegExp(`<style nonce="${nonce}"`));
  assert.doesNotMatch(res.body, /\sstyle=/i, "judge UI HTML must not contain inline style attributes");
  assert.doesNotMatch(res.body, /\b(?:spot|tip|overlay)\.style\./, "tour geometry must use trusted stylesheet CSSOM, not element styles");
  assert.equal(res.headers["cache-control"], "no-store");
});

test("reverse-proxy trust is disabled by default and accepts only bounded exact IP/CIDR entries", () => {
  assert.equal(configuredTrustProxy("", ""), false);
  assert.deepEqual(
    configuredTrustProxy("127.0.0.1, 10.10.0.0/16, 2001:db8::/32", ""),
    ["127.0.0.1", "10.10.0.0/16", "2001:db8::/32"],
  );
  assert.equal(configuredTrustProxy("", "1"), 1);
  for (const value of [
    "proxy.internal",
    "10.0.0.0/33",
    "2001:db8::/129",
    "10.0.0.1/01",
    "10.0.0.1,",
  ]) {
    assert.throws(() => configuredTrustProxy(value, ""), /1-16 exact IP or CIDR/);
  }
  assert.throws(
    () => configuredTrustProxy(Array.from({ length: 17 }, (_, index) => `10.0.0.${index}`).join(","), ""),
    /1-16 exact IP or CIDR/,
  );
  assert.throws(() => configuredTrustProxy("127.0.0.1", "1"), /only one/);
  assert.throws(() => configuredTrustProxy("", "4"), /integer from 1 to 3/);
});

test("document OpenAPI schema states that PDF input is caller-extracted text, not raw bytes", () => {
  assert.match(rawDocumentSchema.properties.source_kind.description, /caller-extracted plain text/i);
  assert.match(rawDocumentSchema.properties.source_kind.description, /does not parse raw PDF bytes/i);
  assert.match(rawDocumentSchema.properties.content.description, /image data URL\/base64/i);
});

test("review decision planner targets every non-selected value for 3-value accept and override", () => {
  const source = UI_HTML.match(/function planHumanDecision[\s\S]*?(?=\n\s*async function applyHumanDecision)/)?.[0];
  assert.ok(source, "planHumanDecision must remain present in the shipped UI");
  const plan = Function(`"use strict"; return (${source});`)() as (
    action: "accept" | "override",
    contradiction: Record<string, unknown>,
    selectedMemoryId?: string,
  ) => { selectedMemoryId: string; targetMemoryIds: string[] };
  const contradiction = {
    values: [
      { memoryId: "session-a", value: 8900 },
      { memoryId: "session-b", value: 8400 },
      { memoryId: "session-c", value: 9100 },
    ],
    resolution: { recommendedMemoryId: "session-a" },
  };
  assert.deepEqual(plan("accept", contradiction, "session-a"), {
    selectedMemoryId: "session-a",
    targetMemoryIds: ["session-b", "session-c"],
  });
  assert.deepEqual(plan("override", contradiction, "session-c"), {
    selectedMemoryId: "session-c",
    targetMemoryIds: ["session-a", "session-b"],
  });
  assert.throws(() => plan("override", contradiction, "session-a"), /non-recommended/);
});

test("reviewer feedback ids retain decision identity when subject text exceeds the 128-character cap", () => {
  const source = UI_HTML.match(/function stableDecisionHash[\s\S]*?(?=\n\s*function planHumanDecision)/)?.[0];
  assert.ok(source, "stable feedback-id planner must remain present in the shipped UI");
  const factory = Function(`${source}\nreturn { conflictDecisionId };`) as () => {
    conflictDecisionId: (action: string, c: object, selected: string, targets: string[]) => string;
  };
  const { conflictDecisionId } = factory();
  const c = { subject: "subject-" + "x".repeat(400), attribute: "amount" };
  const first = conflictDecisionId("override", c, "selected-memory-C", ["target-memory-A", "target-memory-B"]);
  const reordered = conflictDecisionId("override", c, "selected-memory-C", ["target-memory-B", "target-memory-A"]);
  const otherTarget = conflictDecisionId("override", c, "selected-memory-C", ["target-memory-A", "target-memory-D"]);
  const otherSelection = conflictDecisionId("override", c, "selected-memory-D", ["target-memory-A", "target-memory-B"]);
  assert.ok(first.length <= 128);
  assert.equal(first, reordered);
  assert.notEqual(first, otherTarget);
  assert.notEqual(first, otherSelection);
  assert.match(first, /^memory-ui-resolution-v1:override:selected-memory-C:[a-f0-9]{16}$/);
});

test("GET /ready is configuration-only while authenticated /ready/deep probes and caches Qwen", async () => {
  const key = "deep-readiness-test-key-1234567890";
  let embeddingCalls = 0;
  let narratorCalls = 0;
  const readinessCharges: Array<Array<{ bucket: string; units: number }>> = [];
  const readinessAdmission = new TieredQwenAdmission(1, 1);
  const local = await buildServer({
    store: new InMemoryStore(),
    embedder: {
      modelId: "text-embedding-v4",
      dim: 3,
      async embed() {
        embeddingCalls += 1;
        return [1, 0, 0];
      },
    },
    narrator: {
      modelId: "qwen-plus",
      async narrate(_question, hits) {
        narratorCalls += 1;
        return {
          answer: "The narrator readiness sentinel is operational [1].",
          citations: [{
            marker: "[1]",
            kind: hits[0]!.kind,
            score: hits[0]!.score,
            sourceRef: hits[0]!.sourceRef,
            content: hits[0]!.content,
          }],
          modelId: "qwen-plus",
          grounding: { status: "passed" as const, attempts: 1 as const },
        };
      },
    },
    reranker: {
      modelId: "qwen-plus",
      async rerank() { return []; },
    },
    quotaBackend: {
      async consume() { throw new Error("deep readiness must use atomic two-tier metering"); },
      async consumeMany(charges) {
        readinessCharges.push(charges.map((charge) => ({
          bucket: charge.bucket,
          units: charge.units ?? 1,
        })));
        return { ok: true, remaining: 27, limit: 30, resetAt: "2026-07-16T00:00:00.000Z" };
      },
    },
    qwenAdmission: readinessAdmission,
    auth: { required: true, apiKeys: { "tenant-ready": key } },
  });
  await local.ready();
  try {
    const cheap = await local.inject({ method: "GET", url: "/ready" });
    assert.equal(cheap.statusCode, 200);
    assert.equal(cheap.json().checks.qwen, "configured-not-probed");
    assert.equal(cheap.json().checks.narrator, "configured-not-probed");
    assert.equal(embeddingCalls, 0, "cheap readiness must not spend a model call");
    assert.equal(narratorCalls, 0);

    const unauthenticated = await local.inject({ method: "GET", url: "/ready/deep" });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(embeddingCalls, 0, "authentication must run before the probe");

    const first = await local.inject({
      method: "GET",
      url: "/ready/deep",
      headers: { "x-api-key": key },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().cached, false);
    assert.equal(first.json().checks.embedder.status, "operational");
    assert.equal(first.json().checks.narrator.grounding, "passed");
    assert.equal(first.headers["x-qwen-work-units"], String(DEEP_READINESS_WORK_UNITS));
    assert.deepEqual(readinessCharges, [[
      { bucket: "readiness:judge:subject", units: DEEP_READINESS_WORK_UNITS },
      { bucket: "readiness:judge:global", units: DEEP_READINESS_WORK_UNITS },
    ]]);
    assert.equal(embeddingCalls, 1);
    assert.equal(narratorCalls, 1);

    const releaseSaturation = readinessAdmission.tryAcquire("judge");
    assert.ok(releaseSaturation, "test must saturate the only reviewer provider slot");
    const cached = await local.inject({
      method: "GET",
      url: "/ready/deep",
      headers: { authorization: `Bearer ${key}` },
    });
    releaseSaturation();
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.json().cached, true);
    assert.equal(cached.json().checkedAt, first.json().checkedAt);
    assert.equal(cached.headers["x-qwen-work-units"], "0");
    assert.equal(readinessCharges.length, 1, "cache hit must reserve no durable work units");
    assert.deepEqual(readinessAdmission.snapshot(), { public: 0, judge: 0 });
    assert.equal(embeddingCalls, 1, "cached readiness must not re-embed");
    assert.equal(narratorCalls, 1, "cached readiness must not re-narrate");
  } finally {
    await local.close();
  }
});

test("GET /ready/deep durable quota rejects a fresh server before provider work", async () => {
  const key = "deep-readiness-durable-key-1234567890";
  let reservations = 0;
  let embeddingCalls = 0;
  let narratorCalls = 0;
  const quotaBackend = {
    async consume() { throw new Error("deep readiness must use atomic two-tier metering"); },
    async consumeMany(charges: ReadonlyArray<{ units?: number }>) {
      assert.deepEqual(charges.map((charge) => charge.units), [
        DEEP_READINESS_WORK_UNITS,
        DEEP_READINESS_WORK_UNITS,
      ]);
      reservations += 1;
      return reservations === 1
        ? { ok: true, remaining: 0, limit: 3, resetAt: "2026-07-16T00:00:00.000Z" }
        : { ok: false, remaining: 0, limit: 3, resetAt: "2026-07-16T00:00:00.000Z" };
    },
  };
  const createServer = () => buildServer({
    store: new InMemoryStore(),
    embedder: {
      modelId: "text-embedding-v4",
      dim: 3,
      async embed() { embeddingCalls += 1; return [1, 0, 0]; },
    },
    narrator: {
      modelId: "qwen-plus",
      async narrate(_question, hits) {
        narratorCalls += 1;
        return {
          answer: "The narrator readiness sentinel is operational [1].",
          citations: [{
            marker: "[1]",
            kind: hits[0]!.kind,
            score: hits[0]!.score,
            sourceRef: hits[0]!.sourceRef,
            content: hits[0]!.content,
          }],
          modelId: "qwen-plus",
          grounding: { status: "passed" as const, attempts: 1 as const },
        };
      },
    },
    reranker: { modelId: "qwen-plus", async rerank() { return []; } },
    auth: { required: true, apiKeys: { "tenant-ready-durable": key } },
    quotaBackend,
  });

  const firstServer = await createServer();
  await firstServer.ready();
  try {
    const accepted = await firstServer.inject({
      method: "GET",
      url: "/ready/deep",
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(accepted.statusCode, 200);
  } finally {
    await firstServer.close();
  }
  assert.equal(embeddingCalls, 1);
  assert.equal(narratorCalls, 1);

  const freshServer = await createServer();
  await freshServer.ready();
  try {
    const rejected = await freshServer.inject({
      method: "GET",
      url: "/ready/deep",
      headers: { "x-api-key": key },
    });
    assert.equal(rejected.statusCode, 429);
    assert.equal(rejected.headers["x-qwen-work-units"], "0");
    assert.equal(rejected.headers["x-ratelimit-pool"], "judge");
    assert.equal(rejected.json().error, "Daily readiness limit of 3 reached");
    assert.equal(embeddingCalls, 1, "quota denial must precede embedding");
    assert.equal(narratorCalls, 1, "quota denial must precede narration");
  } finally {
    await freshServer.close();
  }
});

test("GET /ready/deep caches a sanitized contention failure instead of amplifying 429s", async () => {
  const key = "deep-readiness-contention-key-123456";
  let narratorCalls = 0;
  const local = await buildServer({
    store: new InMemoryStore(),
    embedder: {
      modelId: "text-embedding-v4",
      dim: 3,
      async embed() { return [1, 0, 0]; },
    },
    narrator: {
      modelId: "qwen-plus",
      async narrate(): Promise<never> {
        narratorCalls += 1;
        throw Object.assign(new Error("sensitive provider detail"), { status: 429 });
      },
    },
    reranker: { modelId: "qwen-plus", async rerank() { return []; } },
    auth: { required: true, apiKeys: { "tenant-contention": key } },
  });
  await local.ready();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await local.inject({
        method: "GET",
        url: "/ready/deep",
        headers: { "x-api-key": key },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error, "service temporarily unavailable");
      assert.doesNotMatch(res.json().error, /sensitive|rate.?limit|429/i);
      assert.deepEqual(Object.keys(res.json()).sort(), ["error", "errorId", "requestId"]);
    }
    assert.equal(narratorCalls, 1, "the 60-second failure cache must collapse repeated probes");
  } finally {
    await local.close();
  }
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
  for (const path of ["/health", "/ready", "/ready/deep", "/recall", "/feedback", "/ingest", "/ingest/invoice", "/ingest/documents", "/pnl", "/memory/list", "/demo/seed", "/memory/count", "/consistency", "/consistency/semantic", "/consolidate", "/forget"]) {
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
      embedModel: "fake-hash-embedder",
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
    embedModel: "fake-hash-embedder",
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
