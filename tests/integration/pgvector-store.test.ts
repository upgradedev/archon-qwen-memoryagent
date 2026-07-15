// Integration test — the PgVectorStore against a REAL pgvector database (the CI
// service container, or a local pgvector docker). Exercises the actual vector
// SQL: insert with `$n::vector`, cosine recall `ORDER BY embedding <=> $q`, the
// company/kind pre-filters, and count. Fully OFFLINE (FakeEmbedder — no key).
//
// Gated on DATABASE_URL: skipped on a laptop with no DB, RUN in CI (which stands
// pgvector up + applies the schema before `npm test`).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { PgVectorStore } from "../../src/memory/store.js";
import { remember, recall } from "../../src/memory/memory.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { auditConsistency } from "../../src/memory/consistency.js";
import { closePool } from "../../src/db/client.js";
import { consumeTwoTierQuota, PgDailyQuotaBackend } from "../../src/server/quota.js";
import { randomUUID } from "node:crypto";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const embedder = new FakeEmbedder();
const store = new PgVectorStore();

before(async () => {
  if (!HAS_DB) return;
  await store.clear();
});

after(async () => {
  // Always release the pg pool, or `node --test` never exits (CI would hang).
  await closePool();
});

test("PgVectorStore persists a memory and recalls it by cosine similarity", { skip: !HAS_DB }, async () => {
  await remember(embedder, store, {
    kind: "insight",
    company: "Acme Foods AE",
    period: "2026-03",
    sourceRef: "evt-1",
    content: "Off-bank employer social-security cost of €11,800 at Acme Foods.",
    metadata: { off_bank_cost: 22800 },
  });
  await remember(embedder, store, {
    kind: "document",
    company: "Acme Foods AE",
    content: "Quarterly sales invoice for office furniture.",
  });
  assert.equal(await store.count(), 2);

  const hits = await recall(embedder, store, "what employer social security cost is off-bank", { limit: 2 });
  assert.ok(hits.length > 0, "vector recall returned nothing");
  // The social-security memory must rank above the invoice memory under cosine distance.
  assert.match(hits[0]!.content, /social-security/i);
  assert.ok(hits[0]!.score >= hits[hits.length - 1]!.score, "hits must be sorted by similarity");
  // Round-trip fidelity: metadata + distance survive the DB.
  assert.equal(hits[0]!.metadata?.off_bank_cost, 22800);
  assert.ok(hits[0]!.distance >= 0 && hits[0]!.distance <= 2);
});

test("PgVectorStore applies the company + kind pre-filters in SQL", { skip: !HAS_DB }, async () => {
  await store.clear();
  await remember(embedder, store, { kind: "insight", company: "Acme", content: "acme insight one" });
  await remember(embedder, store, { kind: "insight", company: "Helios", content: "helios insight two" });
  await remember(embedder, store, { kind: "document", company: "Acme", content: "acme document three" });

  const scoped = await recall(embedder, store, "insight", { company: "Acme", kind: "insight", limit: 5 });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]!.company, "Acme");
  assert.equal(scoped[0]!.kind, "insight");

  assert.equal(await store.count("Acme"), 2);
});

test("PgVectorStore canonicalizes company scope and exact-scans a selective filtered set", { skip: !HAS_DB }, async () => {
  await store.clear();
  const displayCompany = "Ａcme   Labs";
  await remember(embedder, store, {
    kind: "insight", company: displayCompany, content: "selective target cash-flow fact",
  });
  // Out-of-scope rows dominate the global ANN graph. The scoped query must not
  // underfill after HNSW post-filtering, and must keep the original display name.
  await Promise.all(Array.from({ length: 40 }, (_, index) => remember(embedder, store, {
    kind: "insight", company: `Distractor ${index}`, content: `selective target cash-flow distractor ${index}`,
  })));

  const hits = await recall(embedder, store, "selective target cash-flow fact", {
    company: "  acme labs ", kind: "insight", limit: 5,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.company, displayCompany);
  assert.equal(await store.count("ACME LABS"), 1);
  assert.equal((await store.listForAudit({ company: "acme    labs" })).length, 1);
});

test("PgVectorStore hybrid recall fuses dense + full-text (lexical rescue)", { skip: !HAS_DB }, async () => {
  await store.clear();
  await remember(embedder, store, { kind: "payroll_event", company: "Acme", content: "Elena Dimitriou (id E-03) net €9,700 employer cost €14,700." });
  await remember(embedder, store, { kind: "document", company: "Acme", content: "Office rent paid by bank transfer to the landlord." });
  await remember(embedder, store, { kind: "insight", company: "Acme", content: "Electricity utilities bill for the quarter." });

  const hits = await recall(embedder, store, "what did employee E-03 earn", {
    company: "Acme",
    hybrid: true,
    limit: 3,
  });
  assert.ok(hits.length > 0, "hybrid recall returned nothing");
  assert.match(hits[0]!.content, /E-03/, "the exact-id memory must rank first under hybrid fusion");
  // Reproducibility guard: the hybrid hit must report its REAL cosine similarity in
  // `score` (a sane value, not the tiny 1/(60+rank) RRF value that used to leak in),
  // with the RRF fusion value surfaced separately as `rrfScore`. RRF still ordered.
  for (const h of hits) {
    assert.ok(h.score >= 0 && h.score <= 1 + 1e-9, `score must be a real cosine similarity in [0,1], got ${h.score}`);
    assert.ok(Math.abs(h.distance - (1 - h.score)) < 1e-9, "distance must be 1 - cosine");
    assert.equal(typeof h.rrfScore, "number", "the RRF fusion score must be surfaced separately");
    assert.ok(h.rrfScore! > 0 && h.rrfScore! < 0.1, `rrfScore is the small fusion value, got ${h.rrfScore}`);
  }
  // The relevant E-03 hit shows a SUBSTANTIAL, real cosine — not the tiny RRF value.
  assert.ok(hits[0]!.score > 0.1, `the relevant top hit must expose a real cosine, got ${hits[0]!.score}`);
  assert.ok(hits[0]!.score > hits[0]!.rrfScore!, "the real cosine must be larger than the tiny RRF fusion value");
});

// Regression — the LIVE `POST /consistency` 500 (`win.latest.createdAt.slice is
// not a function`). The real `pg` driver returns a Date object for the
// `created_at timestamptz` column, but `AuditMemory.createdAt` is typed `string`
// and the consistency resolver calls `.slice()` / `Date.parse()` on it. Every
// unit test uses InMemoryStore, which already hands back ISO strings, so the crash
// only ever appeared on the pgvector path — exactly what this integration test now
// covers. It ingests two CONTRADICTING writes for the SAME record (same sourceRef,
// different `total`), reads them back through the REAL store, asserts createdAt is
// coerced to an ISO string, and runs auditConsistency so the resolver's
// `.slice()`/`Date.parse()` recency path actually executes without throwing.
//
// Without the store.ts Date→ISO coercion this test throws inside the resolver
// (`createdAt.slice is not a function`); with it, the audit returns a resolution.
test("PgVectorStore audit read coerces createdAt to ISO string so the consistency resolver never crashes on real pg Dates", { skip: !HAS_DB }, async () => {
  await store.clear();
  const company = "Contradiction Co AE";
  // Two separate write events (two "sessions") disagree on the SAME record's total.
  await remember(embedder, store, {
    kind: "document",
    company,
    sourceRef: "inv-INV-2043",
    content: "Invoice INV-2043 total recorded as €18,400.",
    metadata: { total: 18400 },
  });
  // Force a distinct created_at so the resolver takes the NON-tie recency branch,
  // which is the branch that calls createdAt.slice()/Date.parse() — the crash site.
  await new Promise((r) => setTimeout(r, 20));
  await remember(embedder, store, {
    kind: "document",
    company,
    sourceRef: "inv-INV-2043",
    content: "Invoice INV-2043 total recorded as €18,900.",
    metadata: { total: 18900 },
  });

  // Read the memories back through the REAL pgvector store (the path that used to
  // return Date-typed createdAt and blow up the resolver).
  const rows = await store.listForAudit({ company });
  assert.equal(rows.length, 2, "both contradicting writes must be audited");
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  for (const r of rows) {
    assert.equal(typeof r.createdAt, "string", "createdAt must be coerced to a string, not a Date");
    assert.match(r.createdAt, ISO, "createdAt must be an ISO-8601 timestamp");
  }

  // The resolver's .slice()/Date.parse() path executes here. Pre-fix this throws
  // `createdAt.slice is not a function`; post-fix it returns a resolution.
  const report = auditConsistency(rows);
  assert.equal(report.contradictions.length, 1, "the two disagreeing totals are one contradiction");
  const c = report.contradictions[0]!;
  assert.equal(c.attribute, "total");
  assert.ok(c.resolution, "a resolution must be recommended without throwing");
  assert.ok(
    typeof c.resolution.recommendedMemoryId === "string" && c.resolution.recommendedMemoryId.length > 0,
    "resolution must name a real winning memory id"
  );
  assert.equal(c.resolution.recommendedValue, 18900, "recency resolves to the later write's value");
  assert.equal(c.resolution.rule, "recency", "distinct timestamps + equal salience → recency rule");
});

test("PgVectorStore consolidate supersedes duplicates and recall hides them", { skip: !HAS_DB }, async () => {
  await store.clear();
  const agent = new MemoryAgent(embedder, store, new FakeNarrator());
  const fact = "Off-bank employer social-security cost wedge at Acme for 2026-03.";
  await agent.remember("insight", fact, { company: "Acme" });
  await agent.remember("insight", fact, { company: "Acme" });
  await agent.remember("insight", fact, { company: "Acme" });
  assert.equal(await store.count("Acme"), 3);

  const consolidateOptions = {
    company: "Acme", threshold: 0.99, operationId: `pg-consolidate-${randomUUID()}`,
    actor: "test:pg", reason: "collapse integration-test duplicates",
  };
  const res = await agent.consolidate(consolidateOptions);
  assert.equal(res.superseded, 2, "two of three identical memories superseded");
  assert.deepEqual(await agent.consolidate(consolidateOptions), res, "confirmed lifecycle retry replays durable audit result");
  assert.equal(res.audit.persisted, true);

  // Active recall now hides the superseded rows (count still 3 until forgotten).
  const active = await recall(embedder, store, fact, { company: "Acme", limit: 10 });
  assert.equal(active.filter((h) => h.content === fact).length, 1);
  assert.equal(await store.count("Acme"), 3);

  const { forgotten, audit } = await agent.forget(
    { deleteSuperseded: true }, "Acme", undefined, false,
    { operationId: `pg-forget-${randomUUID()}`, actor: "test:pg", reason: "delete superseded integration rows" },
  );
  assert.equal(forgotten, 2);
  assert.equal(audit.persisted, true);
  assert.equal(await store.count("Acme"), 1);
});

test("PgDailyQuotaBackend atomically enforces one shared limit under concurrency", { skip: !HAS_DB }, async () => {
  const quota = new PgDailyQuotaBackend(() => new Date("2026-07-14T12:00:00Z"));
  const subject = `integration-${randomUUID()}`;
  const results = await Promise.all(
    Array.from({ length: 10 }, () => quota.consume("recall:subject", subject, 3)),
  );
  assert.equal(results.filter((result) => result.ok).length, 3);
  assert.equal(results.filter((result) => !result.ok).length, 7);
});

test("PgDailyQuotaBackend rejects a pooled request without charging its subject when global is full", { skip: !HAS_DB }, async () => {
  const quota = new PgDailyQuotaBackend(() => new Date("2026-07-14T12:00:00Z"));
  const nonce = randomUUID();
  const bucket = `atomic-${nonce.slice(0, 8)}`;
  const subject = `subject-${nonce}`;
  assert.equal((await quota.consume(`${bucket}:public:global`, "public", 1)).ok, true);
  assert.equal((await consumeTwoTierQuota(quota, bucket, subject, 1, 1)).ok, false);
  assert.equal(
    (await quota.consume(`${bucket}:public:subject`, subject, 1)).ok,
    true,
    "global rejection must leave the pooled subject tier untouched",
  );
});

test("PgDailyQuotaBackend rolls back an earlier successful charge when a later existing tier is full", { skip: !HAS_DB }, async () => {
  const quota = new PgDailyQuotaBackend(() => new Date("2026-07-14T12:00:00Z"));
  const nonce = randomUUID();
  const earlierBucket = `a-subject-${nonce}`;
  const laterBucket = `z-global-${nonce}`;
  const subject = `subject-${nonce}`;
  assert.equal((await quota.consume(laterBucket, "public", 1)).ok, true);
  assert.equal((await quota.consumeMany([
    { bucket: earlierBucket, subject, limit: 1 },
    { bucket: laterBucket, subject: "public", limit: 1 },
  ])).ok, false);
  assert.equal(
    (await quota.consume(earlierBucket, subject, 1)).ok,
    true,
    "transaction rollback must remove the earlier inserted charge",
  );
});

test("PgDailyQuotaBackend rejects an oversized first charge without creating a counter", { skip: !HAS_DB }, async () => {
  const quota = new PgDailyQuotaBackend(() => new Date("2026-07-14T12:00:00Z"));
  const bucket = `oversized-first-${randomUUID()}`;
  const subject = `subject-${randomUUID()}`;
  assert.equal((await quota.consumeMany([{ bucket, subject, limit: 10, units: 25 }])).ok, false);
  const exact = await quota.consumeMany([{ bucket, subject, limit: 10, units: 10 }]);
  assert.equal(exact.ok, true, "the rejected first charge must leave no row behind");
  assert.equal(exact.remaining, 0);
});

test("PgDailyQuotaBackend preflights a whole batch before writing any tier", { skip: !HAS_DB }, async () => {
  const quota = new PgDailyQuotaBackend(() => new Date("2026-07-14T12:00:00Z"));
  const first = { bucket: `batch-first-${randomUUID()}`, subject: `subject-${randomUUID()}`, limit: 10, units: 5 };
  const oversized = { bucket: `batch-second-${randomUUID()}`, subject: `subject-${randomUUID()}`, limit: 10, units: 25 };
  assert.equal((await quota.consumeMany([first, oversized])).ok, false);
  const untouched = await quota.consumeMany([{ ...first, units: 10 }]);
  assert.equal(untouched.ok, true, "an invalid later tier must not debit an earlier tier");
  assert.equal(untouched.remaining, 0);
});

test("PgVectorStore applies incorrect feedback atomically and idempotently", { skip: !HAS_DB }, async () => {
  await store.clear();
  const agent = new MemoryAgent(embedder, store, new FakeNarrator());
  const memoryId = await agent.remember("insight", "Payroll cost was EUR 100.", {
    company: "Feedback Co",
    period: "2026-05",
    importance: 0.2,
  });
  const feedbackId = `feedback-${randomUUID()}`;
  const first = await agent.applyFeedback(
    memoryId,
    "incorrect",
    "Payroll cost was EUR 1,200.",
    { feedbackId },
  );
  const retry = await agent.applyFeedback(
    memoryId,
    "incorrect",
    "Payroll cost was EUR 1,200.",
    { feedbackId },
  );
  assert.deepEqual(retry, first);
  const active = await store.listForAudit({ company: "Feedback Co" });
  assert.equal(active.length, 1);
  assert.match(active[0]!.content, /1,200/);
  const corrected = await store.getMemoryForFeedback(first.correctedMemoryId!, "_public");
  assert.equal(corrected?.importance, 0.95);
  await assert.rejects(
    agent.applyFeedback(memoryId, "incorrect", "Payroll cost was EUR 9,999.", { feedbackId }),
    /different request/i,
  );
  await store.clear();
  assert.equal(await store.getFeedback(feedbackId, "_public"), null, "clear removes feedback provenance before memories");
});

test("PgVectorStore resolves a 3-way conflict transactionally, replays retries, and serializes competing decisions", { skip: !HAS_DB }, async () => {
  await store.clear();
  const tenantId = `resolution-${randomUUID()}`;
  const agent = new MemoryAgent(embedder, store, new FakeNarrator(), undefined, undefined, tenantId);
  const seed = async (record: string, amount: number, suffix: string) => agent.remember(
    "document",
    `Invoice ${record} amount ${amount}.`,
    {
      tenantId, company: "Atomic Resolution Co", period: "2026-05", sourceRef: suffix,
      metadata: { record, amount }, idempotencyKey: `${record}:${suffix}`,
    },
  );
  const nonCarrierIds = await Promise.all([
    seed("INV-PG-NONCARRIER", 100, "noncarrier-a"),
    seed("INV-PG-NONCARRIER", 200, "noncarrier-b"),
  ]);
  const nonCarrier = await agent.remember("insight", "INV-PG-NONCARRIER was reviewed.", {
    tenantId, company: "Atomic Resolution Co", period: "2026-05", sourceRef: "noncarrier-note",
    metadata: { record: "INV-PG-NONCARRIER", review_status: "reviewed" },
    idempotencyKey: "INV-PG-NONCARRIER:note",
  });
  await assert.rejects(
    agent.resolveConflict("INV-PG-NONCARRIER", "amount", nonCarrier, nonCarrierIds, {
      tenantId, decisionId: `noncarrier-${randomUUID()}`,
    }),
    /does not carry the disputed attribute/i,
  );
  assert.equal((await store.listForAudit({ tenantId, company: "Atomic Resolution Co" })).length, 3);
  await store.clear();

  const ids = await Promise.all([
    seed("INV-PG-3WAY", 100, "a"),
    seed("INV-PG-3WAY", 200, "b"),
    seed("INV-PG-3WAY", 300, "c"),
  ]);
  const decisionId = `decision-${randomUUID()}`;
  const first = await agent.resolveConflict("INV-PG-3WAY", "amount", ids[2]!, [ids[0]!, ids[1]!], { tenantId, decisionId });
  const retry = await agent.resolveConflict("INV-PG-3WAY", "amount", ids[2]!, [ids[1]!, ids[0]!], { tenantId, decisionId });
  assert.deepEqual(retry, first);
  assert.equal(await store.count("Atomic Resolution Co", tenantId), 3, "atomic selection creates no correction row");
  assert.deepEqual((await store.listForAudit({ tenantId, company: "Atomic Resolution Co" })).map((row) => row.id), [ids[2]!]);

  await store.clear();
  const raceIds = await Promise.all([
    seed("INV-PG-RACE", 100, "race-a"),
    seed("INV-PG-RACE", 200, "race-b"),
    seed("INV-PG-RACE", 300, "race-c"),
  ]);
  const race = await Promise.allSettled([
    agent.resolveConflict("INV-PG-RACE", "amount", raceIds[0]!, [raceIds[1]!, raceIds[2]!], { tenantId, decisionId: `race-a-${randomUUID()}` }),
    agent.resolveConflict("INV-PG-RACE", "amount", raceIds[2]!, [raceIds[0]!, raceIds[1]!], { tenantId, decisionId: `race-c-${randomUUID()}` }),
  ]);
  assert.equal(race.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(race.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal((await store.listForAudit({ tenantId, company: "Atomic Resolution Co" })).length, 1);
});
