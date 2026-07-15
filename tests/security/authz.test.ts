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
import {
  buildServer,
  DOCUMENT_INGEST_WORK_UNITS_PER_DOCUMENT,
} from "../../src/server.js";
import { InMemoryStore, type MemoryStore } from "../../src/memory/store.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { FakeJudge } from "../../src/memory/semantic-consistency.js";
import {
  DEFAULT_JUDGE_TENANT,
  DEFAULT_PUBLIC_TENANT,
  loadJudgeAuth,
} from "../../src/server/auth.js";
import type { QwenQuotaPolicy } from "../../src/server/quota.js";

const TEST_QUOTA_POLICY: QwenQuotaPolicy = {
  readinessPerSubject: 10_000,
  readinessJudgeReserve: 10_000,
  recallPerSubject: 10_000,
  recallPublicGlobal: 10_000,
  recallJudgeReserve: 10_000,
  ingestPerSubject: 10_000,
  ingestPublicGlobal: 10_000,
  ingestJudgeReserve: 10_000,
  semanticPerSubject: 10_000,
  semanticPublicGlobal: 10_000,
  semanticJudgeReserve: 10_000,
};

function offlineServer(
  store: MemoryStore,
  quotaPolicy: QwenQuotaPolicy = TEST_QUOTA_POLICY,
): Promise<FastifyInstance> {
  delete process.env.DASHSCOPE_API_KEY;
  return buildServer({
    store,
    embedder: new FakeEmbedder(),
    narrator: new FakeNarrator(),
    judge: new FakeJudge(),
    quotaPolicy,
  });
}

const minimalDocs = [
  {
    doc_id: "sec-doc-register",
    filename: "reg.txt",
    source_kind: "text",
    company: "PenTest Co",
    period: "2026-05",
    content: JSON.stringify({ doc_type: "payroll_register", gross_pay_total: 1000, employer_cost_total: 1200, employee_count: 1 }),
  },
  {
    doc_id: "sec-doc-bank",
    filename: "bank.txt",
    source_kind: "text",
    company: "PenTest Co",
    period: "2026-05",
    content: JSON.stringify({ doc_type: "bank_confirmation", net_pay_total: 800 }),
  },
] as const;

const JUDGE_KEY = "test-judge-key-at-least-16";
const OTHER_KEY = "other-judge-key-at-least-16"; // gitleaks:allow — deterministic non-secret test fixture
const EVENT = {
  event_id: "evt-secure-1",
  company: "Acme",
  period: "2026-05",
  employee_count: 1,
  bank_net_total: 800,
  gross_total: 1000,
  employer_social_security_total: 200,
  employee_social_security_total: 80,
  tax_withheld_total: 120,
  employer_cost_total: 1200,
  cost_gap_amount: 200,
  cost_gap_pct: 25,
  off_bank_cost: 400,
  employees: [{
    employee_id: "E-1", name: "Alex Doe", gross: 1000,
    employee_social_security: 80, tax: 120, net: 800,
    employer_social_security: 200, employer_cost: 1200,
  }],
  linked_docs: [],
};

test("default reviewer tenant is private and startup refuses a reviewer/public tenant collision", () => {
  assert.notEqual(DEFAULT_JUDGE_TENANT, DEFAULT_PUBLIC_TENANT);
  assert.doesNotThrow(() => loadJudgeAuth({
    required: true,
    publicTenantId: DEFAULT_PUBLIC_TENANT,
    apiKeys: { [DEFAULT_JUDGE_TENANT]: JUDGE_KEY },
  }));
  assert.throws(() => loadJudgeAuth({
    required: true,
    publicTenantId: DEFAULT_PUBLIC_TENANT,
    apiKeys: { [DEFAULT_PUBLIC_TENANT]: JUDGE_KEY },
  }), /judge tenant must differ/i);
});

test("credentialed demo seed stays private; removing the token switches to a separate public synthetic tenant", async () => {
  const store = new InMemoryStore();
  const app = await buildServer({
    store,
    embedder: new FakeEmbedder(),
    narrator: new FakeNarrator(),
    judge: new FakeJudge(),
    auth: { required: true, publicTenantId: DEFAULT_PUBLIC_TENANT, apiKeys: { [DEFAULT_JUDGE_TENANT]: JUDGE_KEY } },
    quotaPolicy: TEST_QUOTA_POLICY,
  });
  await app.ready();
  try {
    const privateSeed = await app.inject({
      method: "POST", url: "/demo/seed", headers: { authorization: `Bearer ${JUDGE_KEY}` },
    });
    assert.equal(privateSeed.statusCode, 200);
    assert.equal(privateSeed.json().tenantMode, "reviewer");
    const privateCount = await app.inject({ method: "GET", url: "/memory/count", headers: { authorization: `Bearer ${JUDGE_KEY}` } });
    const publicBefore = await app.inject({ method: "GET", url: "/memory/count" });
    const publicListBefore = await app.inject({ method: "GET", url: "/memory/list?limit=100" });
    assert.ok(privateCount.json().count > 0);
    assert.equal(publicBefore.json().count, 0, "private reviewer seed must not be visible without a credential");
    assert.deepEqual(publicListBefore.json().items, []);

    const publicSeed = await app.inject({ method: "POST", url: "/demo/seed" });
    assert.equal(publicSeed.statusCode, 200);
    assert.equal(publicSeed.json().tenantMode, "public-synthetic");
    const publicAfter = await app.inject({ method: "GET", url: "/memory/count" });
    const privateAfter = await app.inject({ method: "GET", url: "/memory/count", headers: { "x-api-key": JUDGE_KEY } });
    assert.ok(publicAfter.json().count > 0);
    assert.equal(privateAfter.json().count, privateCount.json().count, "public seed must not alter the reviewer tenant");
  } finally {
    await app.close();
  }
});

describe("AuthZ: production mutations are authenticated and tenant-derived", () => {
  test("missing/invalid credentials cannot write; valid credentials write only their mapped tenant", async () => {
    const store = new InMemoryStore();
    const app = await buildServer({
      store,
      embedder: new FakeEmbedder(),
      narrator: new FakeNarrator(),
      judge: new FakeJudge(),
      auth: {
        required: true,
        apiKeys: { "tenant-a": JUDGE_KEY, "tenant-b": OTHER_KEY },
      },
      quotaPolicy: TEST_QUOTA_POLICY,
    });
    await app.ready();
    try {
      const anonymous = await app.inject({ method: "POST", url: "/ingest", payload: { event: EVENT } });
      const invalid = await app.inject({
        method: "POST", url: "/ingest", headers: { authorization: "Bearer wrong-secret-value" }, payload: { event: EVENT },
      });
      assert.equal(anonymous.statusCode, 401);
      assert.equal(invalid.statusCode, 401);
      assert.equal(await store.count(undefined, "tenant-a"), 0);

      const allowed = await app.inject({
        method: "POST", url: "/ingest", headers: { authorization: `Bearer ${JUDGE_KEY}` }, payload: { event: EVENT },
      });
      assert.equal(allowed.statusCode, 200);
      assert.equal(await store.count("Acme", "tenant-a"), 3);
      assert.equal(await store.count("Acme", "tenant-b"), 0);
      assert.equal(await store.count("Acme"), 0, "private writes never leak into the public tenant");

      const tenantARead = await app.inject({ method: "GET", url: "/memory/count", headers: { "x-api-key": JUDGE_KEY } });
      const tenantBRead = await app.inject({ method: "GET", url: "/memory/count", headers: { "x-api-key": OTHER_KEY } });
      assert.equal(tenantARead.json().count, 3);
      assert.equal(tenantBRead.json().count, 0);
    } finally {
      await app.close();
    }
  });

  test("protected lifecycle routes reject anonymous calls and default to a non-mutating preview", async () => {
    const store = new InMemoryStore();
    for (const suffix of ["a", "b"]) {
      await store.remember({
        tenantId: "tenant-a", kind: "insight", company: "Acme", period: "2026-05",
        content: "same duplicate fact", sourceRef: suffix, metadata: null,
        embedding: [1, 0, 0], embedModel: "fake-hash-embedder", importance: 0.5,
      });
    }
    const app = await buildServer({
      store,
      embedder: new FakeEmbedder(), narrator: new FakeNarrator(), judge: new FakeJudge(),
      auth: { required: true, apiKeys: { "tenant-a": JUDGE_KEY } },
      quotaPolicy: TEST_QUOTA_POLICY,
    });
    await app.ready();
    try {
      const denied = await app.inject({
        method: "POST", url: "/consolidate",
        payload: { operationId: "auth-denied-preview", reason: "review duplicate scope" },
      });
      assert.equal(denied.statusCode, 401);
      const preview = await app.inject({
        method: "POST", url: "/consolidate", headers: { "x-api-key": JUDGE_KEY },
        payload: { threshold: 0.99, operationId: "auth-preview", reason: "review duplicate scope" },
      });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json().dryRun, true);
      assert.equal((await store.listForAudit({ tenantId: "tenant-a" })).length, 2);

      // JSON types are security-significant: string "true" must never be
      // coerced into the destructive confirmation flag by Fastify/Ajv.
      const coercedConsolidate = await app.inject({
        method: "POST", url: "/consolidate", headers: { "x-api-key": JUDGE_KEY },
        payload: { threshold: "0.99", confirm: "true", operationId: "coerced-consolidate", reason: "test strict types" },
      });
      const coercedForget = await app.inject({
        method: "POST", url: "/forget", headers: { "x-api-key": JUDGE_KEY },
        payload: { deleteSuperseded: "true", confirm: "true", operationId: "coerced-forget", reason: "test strict types" },
      });
      assert.equal(coercedConsolidate.statusCode, 400);
      assert.equal(coercedForget.statusCode, 400);
      assert.equal((await store.listForAudit({ tenantId: "tenant-a" })).length, 2);

      const applied = await app.inject({
        method: "POST", url: "/consolidate", headers: { "x-api-key": JUDGE_KEY },
        payload: { threshold: 0.99, confirm: true, operationId: "auth-apply", reason: "remove exact duplicates" },
      });
      assert.equal(applied.statusCode, 200);
      assert.equal(applied.json().superseded, 1);
      assert.equal(applied.json().audit.actor, "judge:tenant-a");
      assert.equal(applied.json().audit.reason, "remove exact duplicates");
      assert.equal(applied.json().audit.persisted, true);
      assert.equal((await store.listForAudit({ tenantId: "tenant-a" })).length, 1);
    } finally {
      await app.close();
    }
  });

  test("conflict decisions require a reason and persist a server-derived actor", async () => {
    const store = new InMemoryStore();
    const ids = await Promise.all([100, 200].map((amount, index) => store.remember({
      tenantId: "tenant-a", kind: "document", company: "Acme", period: "2026-05",
      sourceRef: `source-${index}`, content: `Invoice INV-AUTH amount ${amount}.`,
      metadata: { record: "INV-AUTH", amount }, embedding: [1, 0, 0], embedModel: "fake",
    })));
    const app = await buildServer({
      store,
      embedder: new FakeEmbedder(), narrator: new FakeNarrator(), judge: new FakeJudge(),
      auth: { required: true, apiKeys: { "tenant-a": JUDGE_KEY } },
      quotaPolicy: TEST_QUOTA_POLICY,
    });
    await app.ready();
    const base = {
      decisionId: "auth-conflict-001", subject: "INV-AUTH", attribute: "amount",
      selectedMemoryId: ids[1]!, targetMemoryIds: [ids[0]!],
    };
    try {
      const missingReason = await app.inject({
        method: "POST", url: "/resolve-conflict", headers: { "x-api-key": JUDGE_KEY }, payload: base,
      });
      assert.equal(missingReason.statusCode, 400);
      const forgedActor = await app.inject({
        method: "POST", url: "/resolve-conflict", headers: { "x-api-key": JUDGE_KEY },
        payload: { ...base, actor: "attacker", reason: "reviewed invoice evidence" },
      });
      assert.equal(forgedActor.statusCode, 400, "caller identity is not accepted by the contract");
      const first = await app.inject({
        method: "POST", url: "/resolve-conflict", headers: { "x-api-key": JUDGE_KEY },
        payload: { ...base, reason: "reviewed invoice evidence" },
      });
      assert.equal(first.statusCode, 200);
      assert.equal(first.json().actor, "judge:tenant-a");
      assert.equal(first.json().reason, "reviewed invoice evidence");
      const retry = await app.inject({
        method: "POST", url: "/resolve-conflict", headers: { "x-api-key": JUDGE_KEY },
        payload: { ...base, reason: "reviewed invoice evidence" },
      });
      assert.deepEqual(retry.json(), first.json());
    } finally {
      await app.close();
    }
  });

  test("feedback is tenant-scoped, idempotent, and turns a correction into the active high-importance memory", async () => {
    const store = new InMemoryStore();
    const wrongId = await store.remember({
      tenantId: "tenant-a", kind: "insight", company: "Acme", period: "2026-05",
      content: "Acme payroll cost was EUR 100.", metadata: { employer_cost_total: 100, staleField: "wrong" },
      embedding: [1, 0, 0], embedModel: "fake", importance: 0.2,
    });
    const app = await buildServer({
      store,
      embedder: new FakeEmbedder(), narrator: new FakeNarrator(), judge: new FakeJudge(),
      auth: { required: true, apiKeys: { "tenant-a": JUDGE_KEY, "tenant-b": OTHER_KEY } },
      quotaPolicy: TEST_QUOTA_POLICY,
    });
    await app.ready();
    const payload = {
      memoryId: wrongId,
      outcome: "incorrect",
      correctedFact: "Acme payroll cost was EUR 1,200.",
      feedbackId: "review-2026-05-001",
    };
    try {
      const crossTenant = await app.inject({
        method: "POST", url: "/feedback", headers: { "x-api-key": OTHER_KEY }, payload,
      });
      assert.equal(crossTenant.statusCode, 404);

      const corrected = await app.inject({
        method: "POST", url: "/feedback", headers: { "x-api-key": JUDGE_KEY }, payload,
      });
      assert.equal(corrected.statusCode, 200);
      assert.equal(corrected.json().outcome, "incorrect");
      assert.ok(corrected.json().correctedMemoryId);
      assert.equal(corrected.json().after.supersededBy, corrected.json().correctedMemoryId);

      const retry = await app.inject({
        method: "POST", url: "/feedback", headers: { "x-api-key": JUDGE_KEY }, payload,
      });
      assert.deepEqual(retry.json(), corrected.json(), "same feedbackId returns the original result");

      const mismatch = await app.inject({
        method: "POST", url: "/feedback", headers: { "x-api-key": JUDGE_KEY },
        payload: { ...payload, correctedFact: "Acme payroll cost was EUR 9,999." },
      });
      assert.equal(mismatch.statusCode, 409, "a feedback id cannot be reused for a different correction");
      assert.match(mismatch.json().error, /different request/i);
      const active = await store.listForAudit({ tenantId: "tenant-a", company: "Acme" });
      assert.equal(active.length, 1);
      assert.match(active[0]!.content, /1,200/);
      const target = await store.getMemoryForFeedback(corrected.json().correctedMemoryId, "tenant-a");
      assert.equal(target?.importance, 0.95);
      assert.equal(target?.metadata?.employer_cost_total, undefined, "wrong structured values must not survive correction");
      assert.deepEqual(
        Object.keys(target?.metadata ?? {}).sort(),
        ["correctedFrom", "feedbackId"],
        "corrected metadata carries provenance only",
      );
    } finally {
      await app.close();
    }
  });

  test("correct feedback protects future recall without spending Qwen quota or embedding", async () => {
    const store = new InMemoryStore();
    const memoryId = await store.remember({
      tenantId: "tenant-a", kind: "insight", company: "Acme", period: "2026-05",
      content: "Acme payroll cost was EUR 1,200.", embedding: [1, 0, 0], embedModel: "fake", importance: 0.2,
    });
    class CountingEmbedder extends FakeEmbedder {
      calls = 0;
      override async embed(text: string): Promise<number[]> {
        this.calls += 1;
        return super.embed(text);
      }
    }
    const embedder = new CountingEmbedder();
    const app = await buildServer({
      store, embedder, narrator: new FakeNarrator(), judge: new FakeJudge(),
      auth: { required: true, apiKeys: { "tenant-a": JUDGE_KEY } },
      quotaPolicy: TEST_QUOTA_POLICY,
      quotaBackend: {
        async consume() {
          throw new Error("correct feedback must not reserve Qwen quota");
        },
        async consumeMany() {
          throw new Error("correct feedback must not reserve Qwen quota");
        },
      },
    });
    await app.ready();
    const payload = {
      memoryId,
      outcome: "correct",
      // Extraneous correction text is ignored for a correct outcome.
      correctedFact: "this must not be embedded or persisted",
      feedbackId: "review-correct-001",
    };
    try {
      const first = await app.inject({
        method: "POST", url: "/feedback", headers: { "x-api-key": JUDGE_KEY }, payload,
      });
      assert.equal(first.statusCode, 200);
      assert.equal(first.json().outcome, "correct");
      assert.equal(first.json().correctedMemoryId, null);
      assert.equal(embedder.calls, 0);
      assert.equal((await store.getMemoryForFeedback(memoryId, "tenant-a"))?.importance, 0.95);

      const retry = await app.inject({
        method: "POST", url: "/feedback", headers: { authorization: `Bearer ${JUDGE_KEY}` }, payload,
      });
      assert.deepEqual(retry.json(), first.json());
      assert.equal(embedder.calls, 0, "idempotent retry must not invoke the embedder");
    } finally {
      await app.close();
    }
  });
});

describe("AuthZ: canonical company scoping rejects substring/wildcard overreach", () => {
  test("company filters are canonical-exact inside a tenant", async () => {
    const store = new InMemoryStore();
    for (const company of ["Acme", "Acme Holdings"]) {
      await store.remember({
        tenantId: "tenant-a", kind: "insight", company, content: `${company} fact`,
        embedding: [1, 0, 0], embedModel: "fake",
      });
    }
    assert.equal((await store.listForAudit({ tenantId: "tenant-a", company: "Acme" })).length, 1);
    assert.equal((await store.listForAudit({ tenantId: "tenant-a", company: "%" })).length, 0);
    assert.equal((await store.recall([1, 0, 0], { tenantId: "tenant-a", company: " acme " })).length, 1);
  });
});

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
  test("POST /ingest/documents meters every document and returns 429 once the per-IP work-unit budget is exhausted", async () => {
    // Drive the real weighted budget. Each document reserves extraction plus a
    // conservative share of the downstream event/finding memory writes.
    const workUnits = minimalDocs.length * DOCUMENT_INGEST_WORK_UNITS_PER_DOCUMENT;
    const allowedBatches = 5;
    const testLimit = allowedBatches * workUnits;
    const app = await offlineServer(new InMemoryStore(), {
      ...TEST_QUOTA_POLICY,
      ingestPerSubject: testLimit,
      ingestPublicGlobal: testLimit,
    });
    await app.ready();
    try {
      for (let i = 0; i < allowedBatches; i++) {
        const ok = await app.inject({ method: "POST", url: "/ingest/documents", payload: { documents: minimalDocs } });
        assert.equal(ok.statusCode, 200, `call ${i + 1} within budget must be 200`);
      }
      const blocked = await app.inject({ method: "POST", url: "/ingest/documents", payload: { documents: minimalDocs } });
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
