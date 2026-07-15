// Unit tests for the memory logic — NO database, NO key. Uses InMemoryStore so
// the write → embed → cosine-recall → top-k ordering is verifiable with zero
// infra, and the full MemoryAgent loop runs offline against the Fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { InMemoryStore } from "../../src/memory/store.js";
import {
  MAX_MEMORY_BATCH,
  remember,
  rememberMany,
  recall,
} from "../../src/memory/memory.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { cosineSimilarity } from "../../src/memory/retrieval.js";
import { toVectorLiteral } from "../../src/db/client.js";
import type { PayrollEvent } from "../../src/types.js";
import type { Reranker } from "../../src/memory/rerank.js";
import { FakeJudge } from "../../src/memory/semantic-consistency.js";
import type { Embedder } from "../../src/memory/embeddings.js";
import type { StoredMemory } from "../../src/memory/store.js";

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
  off_bank_cost: 22800,
  employees: [
    { employee_id: "E-01", name: "Elena Novak", gross: 22000, employee_social_security: 1800, tax: 3000, net: 17200, employer_social_security: 5000, employer_cost: 27000 },
    { employee_id: "E-02", name: "David Chen", gross: 18000, employee_social_security: 1500, tax: 2400, net: 14100, employer_social_security: 4100, employer_cost: 22100 },
  ],
  linked_docs: ["doc-bank-1", "doc-reg-1"],
};

test("toVectorLiteral renders the pgvector text form", () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
});

test("remember + recall round trip ranks the semantically closest memory first", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "insight", content: "off-bank employer social security contribution cost wedge" });
  await remember(embedder, store, { kind: "document", content: "quarterly sales invoice for office furniture" });
  assert.equal(await store.count(), 2);

  const hits = await recall(embedder, store, "what is the off-bank employer social security cost", { limit: 2 });
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.content, /employer social security/i);
  assert.ok(hits[0]!.score >= hits[1]!.score, "hits must be sorted by descending similarity");
});

test("hybrid recall reports the REAL cosine in `score` while RRF drives ordering", async () => {
  // Regression guard for the reproducibility exposure: the default (hybrid) recall
  // must surface a real cosine similarity in `hit.score` — NOT the tiny 1/(60+rank)
  // RRF fusion value, which used to leak into the field labelled as similarity and
  // made a healthy retriever look broken (score: 0.016) to anyone curling /recall.
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "payroll_event", content: "Elena Novak (id E-01) net €17,200 employer cost €27,000." });
  await remember(embedder, store, { kind: "document", content: "quarterly sales invoice for office furniture" });
  await remember(embedder, store, { kind: "insight", content: "electricity utilities bill for the quarter" });

  const queryText = "what did employee E-01 earn";
  const qvec = await embedder.embed(queryText);
  const hits = await store.recall(qvec, { hybrid: true, queryText, limit: 3 });
  assert.ok(hits.length > 0, "hybrid recall returned nothing");

  for (const h of hits) {
    // `score` is the ACTUAL cosine of this hit's embedding vs the query — recompute
    // it independently and require an exact match (proves it is cosine, not RRF).
    const expected = cosineSimilarity(qvec, await embedder.embed(h.content));
    assert.ok(Math.abs(h.score - expected) < 1e-9, `score must equal the real cosine (got ${h.score}, expected ${expected})`);
    assert.ok(h.score >= 0 && h.score <= 1 + 1e-9, `cosine similarity must be in [0,1] (got ${h.score})`);
    // distance mirrors it (1 - cosine), and the RRF fusion value is exposed separately.
    assert.ok(Math.abs(h.distance - (1 - h.score)) < 1e-9, "distance must be 1 - cosine");
    assert.equal(typeof h.rrfScore, "number", "the RRF fusion score must be surfaced separately");
    assert.ok(h.rrfScore! > 0 && h.rrfScore! < 0.1, `rrfScore is the small 1/(60+rank) fusion value (got ${h.rrfScore})`);
  }

  // The relevant hit (E-01) ranks first and shows a SUBSTANTIAL cosine — the whole
  // point: a curl of the default recall now shows sane similarity, not score==rrf.
  const top = hits[0]!;
  assert.match(top.content, /E-01/, "the E-01 memory must rank first under hybrid fusion");
  assert.ok(top.score > 0.1, `the relevant top hit must show a real cosine, not a tiny RRF value (got ${top.score})`);
  assert.ok(top.score - top.rrfScore! > 1e-3, "score (cosine) must not be the RRF value");
});

test("recall honours the company + kind pre-filters", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "insight", company: "Acme", content: "acme insight" });
  await remember(embedder, store, { kind: "insight", company: "Helios", content: "helios insight" });
  await remember(embedder, store, { kind: "document", company: "Acme", content: "acme document" });

  const scoped = await recall(embedder, store, "insight", { company: "Acme", kind: "insight" });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]!.company, "Acme");
  assert.equal(scoped[0]!.kind, "insight");
});

test("MemoryAgent.ingestEvent writes event + insight + per-employee memories", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new InMemoryStore(), new FakeNarrator());
  const ids = await agent.ingestEvent(EVENT);
  // event summary + insight + 2 per-employee lines = 4 memories.
  assert.equal(ids.length, 4);
});

test("company scope uses one NFKC/case/whitespace identity while preserving the display label", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  const display = "Ａcme   Ltd";
  await remember(embedder, store, { kind: "insight", company: display, content: "canonical company fact" });
  await remember(embedder, store, { kind: "insight", company: "Other Ltd", content: "other company fact" });

  const hits = await recall(embedder, store, "canonical company fact", {
    company: "  acme ltd  ", kind: "insight", limit: 5,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.company, display, "the original display value remains intact");
  assert.equal(await store.count("acme ltd"), 1);
  assert.equal((await store.listForAudit({ company: " ACME   LTD " })).length, 1);
});

test("recall never mixes incompatible embedding-model vector spaces", async () => {
  const store = new InMemoryStore();
  await store.remember({
    kind: "insight", company: "Acme", content: "historical model fact",
    embedding: [1, 0], embedModel: "model-v1",
  });
  await store.remember({
    kind: "insight", company: "Acme", content: "current model fact",
    embedding: [0, 1], embedModel: "model-v2",
  });
  const currentEmbedder: Embedder = {
    modelId: "model-v2", dim: 2, async embed() { return [1, 0]; },
  };

  const hits = await recall(currentEmbedder, store, "query", { company: "Acme", limit: 5 });
  assert.deepEqual(hits.map((hit) => hit.content), ["current model fact"]);
});

test("MemoryAgent keeps the full off-bank ratio distinct from employer social-security ratio", async () => {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator());
  await agent.ingestEvent(EVENT);
  const insight = (await store.listForAudit({ company: EVENT.company, kind: "insight" }))[0]!;

  assert.match(insight.content, /22,800 currency units \(55\.6% of the transfer\)/);
  assert.match(insight.content, /11,800 currency units \(28\.8% of the bank transfer\)/);
  assert.doesNotMatch(
    insight.content,
    /22,800 currency units \(28\.8%/,
    "the employer-SS percentage must never be attached to the full employer-cost gap",
  );
});

test("MemoryAgent.ingestPipelineBatch commits event + derived findings in one batch", async () => {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator());
  const ids = await agent.ingestPipelineBatch(EVENT, [{
    kind: "validation",
    company: EVENT.company,
    period: EVENT.period,
    sourceRef: EVENT.event_id,
    content: "Cross-document totals agree.",
    metadata: { rule: "R1", passed: true },
    idempotencyKey: `event:${EVENT.event_id}:validation:R1`,
  }]);
  assert.equal(ids.length, 5);
  assert.equal(await store.count(EVENT.company), 5);
});

test("MemoryAgent.ingestPipelineBatch leaves no partial event when any derived fact conflicts", async () => {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator());
  await assert.rejects(
    agent.ingestPipelineBatch(EVENT, [{
      kind: "validation",
      company: EVENT.company,
      period: EVENT.period,
      content: "A different payload illegally reused the event-summary key.",
      idempotencyKey: `event:${EVENT.event_id}:summary`,
    }]),
    /idempotency key/i,
  );
  assert.equal(await store.count(EVENT.company), 0, "the staged event rows must roll back with the bad finding");
});

test("idempotency requires the complete logical payload, not content alone", async () => {
  const store = new InMemoryStore();
  const base = {
    kind: "validation" as const,
    company: "Acme",
    period: "2026-05",
    sourceRef: "R1",
    content: "Validation R1 passed.",
    metadata: { passed: true, observed: 100 },
    importance: 0.7,
    idempotencyKey: "validation:R1",
    embedding: [1, 0, 0],
    embedModel: "model-v1",
  };
  const first = await store.remember(base);
  assert.equal(await store.remember({ ...base, embedModel: "model-v2", embedding: [0, 1, 0] }), first,
    "embedding/model rotation is not a logical payload change");
  await assert.rejects(
    store.remember({ ...base, metadata: { passed: true, observed: 999 } }),
    /different logical memory/i,
  );
  await assert.rejects(
    store.remember({ ...base, company: "Other Co" }),
    /different logical memory/i,
  );
  assert.equal(await store.count("Acme"), 1);
  assert.equal(await store.count("Other Co"), 0);
});

test("MemoryAgent.auditConsistency surfaces a cross-session contradiction", async () => {
  // The demo "aha": session A stores one value for a record; a later session
  // stores a DIFFERENT value for the same record → the agent's self-audit
  // surfaces the disagreement instead of silently returning one of them.
  const agent = new MemoryAgent(new FakeEmbedder(), new InMemoryStore(), new FakeNarrator());
  // Session A — invoice INV-2043 remembered at €18,400.
  await agent.remember("document", "Invoice INV-2043 total €18,400.", {
    company: "Northwind", sourceRef: "INV-2043", metadata: { record: "INV-2043", total: 18400 },
  });
  // Session B (a separate write) — same invoice remembered at €18,900.
  await agent.remember("document", "Invoice INV-2043 total €18,900.", {
    company: "Northwind", sourceRef: "INV-2043", metadata: { record: "INV-2043", total: 18900 },
  });
  // A consistent, unrelated record that must NOT be flagged.
  await agent.remember("document", "Invoice INV-2051 total €9,250.", {
    company: "Northwind", sourceRef: "INV-2051", metadata: { record: "INV-2051", total: 9250 },
  });

  const report = await agent.auditConsistency({ company: "Northwind" });
  assert.equal(report.contradictions.length, 1, "exactly one contradiction");
  assert.equal(report.contradictions[0]!.subject, "INV-2043");
  assert.equal(report.contradictions[0]!.attribute, "total");
  assert.deepEqual(report.contradictions[0]!.values.map((v) => v.value).sort(), [18400, 18900]);
  assert.equal(report.ok, false);
});

test("MemoryAgent semantic audit reuses stored tenant-scoped embeddings", async () => {
  const store = new InMemoryStore();
  for (const [content, sourceRef] of [
    ["Vendor Northwind always pays invoices on time.", "a"],
    ["Vendor Northwind is chronically late paying invoices.", "b"],
  ] as const) {
    await store.remember({
      tenantId: "tenant-a", kind: "insight", company: "Acme", period: "2026-05",
      sourceRef, content, embedding: [1, 0, 0], embedModel: "stored-model",
    });
  }
  const noReembed = {
    modelId: "stored-model",
    dim: 3,
    async embed(): Promise<number[]> {
      throw new Error("semantic audit must use stored vectors");
    },
  };
  const agent = new MemoryAgent(noReembed, store, new FakeNarrator(), new FakeJudge(), undefined, "tenant-a");
  const report = await agent.auditSemanticConsistency({ company: "Acme" }, { similarityThreshold: 0.9 });
  assert.equal(report.audited, 2);
  assert.equal(report.embeddingFailed, 0);
  assert.equal(report.semanticContradictions.length, 1);
});

test("MemoryAgent.recallAnswer grounds a cited answer in the recalled memories", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new InMemoryStore(), new FakeNarrator());
  await agent.ingestEvent(EVENT);
  const { answer, hits, citations, modelId } = await agent.recallAnswer(
    "What was our real employer payroll cost last month?",
    { company: "Acme Foods AE", limit: 3 }
  );
  assert.ok(hits.length > 0, "vector recall returned no memories");
  assert.equal(modelId, "fake-narrator");
  for (const c of citations) assert.ok(answer.includes(c.marker), `answer missing marker ${c.marker}`);
  const allContent = citations.map((c) => c.content).join(" ");
  assert.ok(
    allContent.includes("63,800 currency units") || allContent.includes("22,800 currency units"),
    "recalled memories must include the employer-cost figures"
  );
  assert.doesNotMatch(allContent, /€/, "a currency-less PayrollEvent must not fabricate EUR");
});

test("MemoryAgent.recallAnswer degrades gracefully when the narrator is down (returns the recalled memories, flagged)", async () => {
  // A narrator that always throws stands in for a qwen-plus outage. The memories
  // are already retrieved by the time narration runs, so the recall must NOT be
  // lost to a hard error — the agent returns them as citations plus a `degraded`
  // flag and a plain fallback answer.
  const throwingNarrator = {
    modelId: "qwen-plus",
    async narrate(): Promise<never> {
      throw new Error("DashScope unreachable");
    },
  };
  const agent = new MemoryAgent(new FakeEmbedder(), new InMemoryStore(), throwingNarrator);
  await agent.ingestEvent(EVENT);
  const res = await agent.recallAnswer("What was our real employer payroll cost last month?", {
    company: "Acme Foods AE",
    limit: 3,
  });
  // Still returns the retrieved memories (not an empty/error result).
  assert.ok(res.hits.length > 0, "degraded recall must still return the retrieved memories");
  assert.ok(res.citations.length > 0, "degraded answer must stay grounded in citations");
  // Flagged as degraded, with the documented reason.
  assert.equal(res.degraded, "narrator unavailable — returning raw recalled memories");
  assert.equal(res.degradationCode, "unexpected_narrator_failure");
  assert.equal(res.modelId, "degraded");
  // The fallback answer is composed from the recalled memories, cited by marker.
  for (const c of res.citations) assert.ok(res.answer.includes(c.marker), `fallback missing marker ${c.marker}`);
  // The self-audit still runs over the recalled memories in the degraded path.
  assert.ok(res.consistency && typeof res.consistency.audited === "number");
});

test("rememberMany bounds embedding concurrency and preserves input order", async () => {
  let active = 0;
  let maxActive = 0;
  const embedder: Embedder = {
    modelId: "timed-embedder",
    dim: 1,
    async embed(text) {
      active++;
      maxActive = Math.max(maxActive, active);
      const index = Number(text.slice(1));
      await new Promise((resolve) => setTimeout(resolve, (8 - index) * 2));
      active--;
      return [index];
    },
  };
  class CapturingStore extends InMemoryStore {
    batch: StoredMemory[] = [];
    override async rememberMany(memories: StoredMemory[]): Promise<string[]> {
      this.batch = memories;
      return memories.map((_, index) => `id-${index}`);
    }
  }
  const store = new CapturingStore();
  const inputs = Array.from({ length: 8 }, (_, index) => ({
    kind: "document" as const,
    content: `m${index}`,
  }));

  const ids = await rememberMany(embedder, store, inputs, { concurrency: 3 });

  assert.ok(maxActive <= 3, `provider concurrency exceeded the cap: ${maxActive}`);
  assert.deepEqual(ids, inputs.map((_, index) => `id-${index}`));
  assert.deepEqual(store.batch.map((memory) => memory.content), inputs.map((memory) => memory.content));
  assert.deepEqual(store.batch.map((memory) => memory.embedding[0]), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("rememberMany aborts siblings, drains active embeddings, and writes nothing after a failure", async () => {
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let aborted = 0;
  const embedder: Embedder = {
    modelId: "failing-embedder",
    dim: 1,
    async embed(text, signal) {
      active++;
      started++;
      maxActive = Math.max(maxActive, active);
      try {
        if (text === "fail") {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("embedding failed");
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted++;
            reject(Object.assign(new Error("aborted sibling"), { name: "AbortError" }));
          }, { once: true });
        });
        return [1];
      } finally {
        active--;
      }
    },
  };
  const store = new InMemoryStore();
  const inputs = ["fail", "slow-1", "slow-2", "queued-1", "queued-2"].map((content) => ({
    kind: "document" as const,
    content,
  }));

  await assert.rejects(
    rememberMany(embedder, store, inputs, { concurrency: 3 }),
    /embedding failed/,
  );

  assert.equal(active, 0, "the batch must drain every provider request before rejecting");
  assert.equal(started, 3, "queued work must never start after the first failure");
  assert.equal(aborted, 2, "both in-flight siblings receive the abort signal");
  assert.equal(maxActive, 3);
  assert.equal(await store.count(), 0, "a failed embedding batch cannot partially persist");
});

test("rememberMany rejects an oversized batch before invoking the provider", async () => {
  let calls = 0;
  const embedder: Embedder = {
    modelId: "must-not-run",
    dim: 1,
    async embed() {
      calls++;
      return [1];
    },
  };
  await assert.rejects(
    rememberMany(
      embedder,
      new InMemoryStore(),
      Array.from({ length: MAX_MEMORY_BATCH + 1 }, (_, index) => ({
        kind: "document" as const,
        content: `memory-${index}`,
      })),
    ),
    /hard cap/,
  );
  assert.equal(calls, 0);
});

test("MemoryAgent preserves recall and classifies account-level narrator contention", async () => {
  const rateLimitedNarrator = {
    modelId: "qwen-plus",
    async narrate(): Promise<never> {
      throw Object.assign(new Error("provider is busy"), { status: 429 });
    },
  };
  const agent = new MemoryAgent(new FakeEmbedder(), new InMemoryStore(), rateLimitedNarrator);
  await agent.ingestEvent(EVENT);
  const res = await agent.recallAnswer("What was our real employer payroll cost last month?", {
    company: "Acme Foods AE",
    limit: 3,
  });
  assert.equal(res.modelId, "degraded");
  assert.equal(res.degradationCode, "upstream_rate_limited");
  assert.ok(res.citations.length > 0);
  assert.equal(
    JSON.stringify(res).includes("provider is busy"),
    false,
    "provider detail must not leak into the API-shaped result",
  );
});

test("MemoryAgent.recallAnswer runs the production rerank stage and exposes provenance", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "insight", company: "Acme", content: "generic payroll note" });
  await remember(embedder, store, { kind: "insight", company: "Acme", content: "authoritative corrected employer cost EUR 63,800" });
  const reranker: Reranker = {
    modelId: "qwen-rerank-test",
    async rerank(_query, docs) {
      return docs.map((doc) => ({ id: doc.id, score: doc.content.includes("63,800") ? 1 : 0 }));
    },
  };
  const agent = new MemoryAgent(embedder, store, new FakeNarrator(), undefined, reranker);
  const result = await agent.recallAnswer("What is the corrected employer cost?", {
    company: "Acme",
    limit: 1,
  });
  assert.match(result.hits[0]!.content, /63,800/);
  assert.equal(result.retrieval.reranker.status, "applied");
  assert.equal(result.retrieval.reranker.modelId, "qwen-rerank-test");
  assert.equal(result.retrieval.candidateCount, 2);
  assert.equal(result.retrieval.returnedCount, 1);
});

test("MemoryAgent.recallAnswer aborts and drains a timed-out reranker before continuing with hybrid fallback", async () => {
  const embedder = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(embedder, store, { kind: "insight", content: "first memory" });
  await remember(embedder, store, { kind: "insight", content: "second memory" });
  let activeProviderCalls = 0;
  let providerObservedAbort = false;
  let providerSettled = false;
  let narrationStartedAfterDrain = false;
  const abortable: Reranker = {
    modelId: "abortable-reranker",
    rerank: async (_query, _docs, signal) => {
      activeProviderCalls += 1;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          providerObservedAbort = true;
          activeProviderCalls -= 1;
          providerSettled = true;
          reject(signal?.reason ?? new Error("aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const fakeNarrator = new FakeNarrator();
  const observingNarrator = {
    modelId: fakeNarrator.modelId,
    async narrate(question: string, hits: Parameters<FakeNarrator["narrate"]>[1]) {
      narrationStartedAfterDrain = providerSettled && activeProviderCalls === 0;
      return fakeNarrator.narrate(question, hits);
    },
  };
  const agent = new MemoryAgent(embedder, store, observingNarrator, undefined, abortable);
  const result = await agent.recallAnswer("memory", { limit: 2, rerankTimeoutMs: 100 });
  assert.equal(result.hits.length, 2, "successful hybrid candidates survive a reranker timeout");
  assert.equal(result.retrieval.reranker.status, "fallback");
  assert.equal(providerObservedAbort, true, "deadline must abort the underlying provider request");
  assert.equal(providerSettled, true);
  assert.equal(activeProviderCalls, 0);
  assert.equal(narrationStartedAfterDrain, true, "fallback must not continue until cancellation settles");
});

async function threeWayConflict(store: InMemoryStore, tenantId = "tenant-resolution") {
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator(), new FakeJudge(), undefined, tenantId);
  const ids: string[] = [];
  for (const [index, amount] of [8900, 8400, 9100].entries()) {
    ids.push(await agent.remember("document", `Invoice INV-3WAY amount ${amount}.`, {
      tenantId,
      company: "Resolution Co",
      period: "2026-05",
      sourceRef: `session-${index + 1}`,
      metadata: { record: "INV-3WAY", amount },
      importance: index === 0 ? 0.9 : 0.5,
      idempotencyKey: `${tenantId}:three-way:${index}`,
    }));
  }
  return { agent, ids };
}

for (const scenario of [
  { name: "accept", selectedIndex: 0 },
  { name: "override", selectedIndex: 2 },
] as const) {
  test(`atomic conflict resolution ${scenario.name}: one existing carrier remains, retry is idempotent, no row is created`, async () => {
    const store = new InMemoryStore();
    const { agent, ids } = await threeWayConflict(store);
    const selected = ids[scenario.selectedIndex]!;
    const targets = ids.filter((id) => id !== selected);
    const beforeCount = await store.count(undefined, "tenant-resolution");
    assert.equal((await agent.auditConsistency({ tenantId: "tenant-resolution" })).contradictions.length, 1);
    const first = await agent.resolveConflict("INV-3WAY", "amount", selected, targets, {
      tenantId: "tenant-resolution",
      decisionId: `decision-${scenario.name}-0001`,
      actor: "judge:tenant-resolution",
      reason: `${scenario.name} after source review`,
    });
    assert.equal(first.selectedMemoryId, selected);
    assert.deepEqual(first.supersededMemoryIds, [...targets].sort());
    assert.deepEqual({ before: first.before.activeCarriers, after: first.after.activeCarriers }, { before: 3, after: 1 });
    assert.equal(first.actor, "judge:tenant-resolution");
    assert.equal(first.reason, `${scenario.name} after source review`);
    assert.equal(await store.count(undefined, "tenant-resolution"), beforeCount, "selection must create zero correction rows");
    const active = await store.listForAudit({ tenantId: "tenant-resolution", company: "Resolution Co" });
    assert.deepEqual(active.map((row) => row.id), [selected]);
    assert.equal((await agent.auditConsistency({ tenantId: "tenant-resolution" })).ok, true);
    const replay = await agent.resolveConflict("INV-3WAY", "amount", selected, [...targets].reverse(), {
      tenantId: "tenant-resolution",
      decisionId: `decision-${scenario.name}-0001`,
      actor: "judge:tenant-resolution",
      reason: `${scenario.name} after source review`,
    });
    assert.deepEqual(replay, first);
    await assert.rejects(
      agent.resolveConflict("INV-3WAY", "amount", selected, targets, {
        tenantId: "tenant-resolution",
        decisionId: `decision-${scenario.name}-0001`,
        actor: "judge:tenant-resolution",
        reason: "changed reason on an existing decision",
      }),
      /decision id was already used for a different request/i,
    );
  });
}

test("atomic conflict resolution rejects incomplete, stale, mismatched and cross-tenant sets without partial changes", async () => {
  const store = new InMemoryStore();
  const { agent, ids } = await threeWayConflict(store);
  const other = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator(), new FakeJudge(), undefined, "tenant-other");
  const crossTenantId = await other.remember("document", "Foreign INV-3WAY amount 1.", {
    tenantId: "tenant-other", company: "Resolution Co", period: "2026-05",
    metadata: { record: "INV-3WAY", amount: 1 }, idempotencyKey: "other:conflict",
  });
  await assert.rejects(
    agent.resolveConflict("INV-3WAY", "amount", ids[0]!, [ids[1]!], { tenantId: "tenant-resolution", decisionId: "decision-incomplete" }),
    /every active non-selected/i,
  );
  await assert.rejects(
    agent.resolveConflict("OTHER", "amount", ids[0]!, [ids[1]!, ids[2]!], { tenantId: "tenant-resolution", decisionId: "decision-scope" }),
    /scope|every active/i,
  );
  await assert.rejects(
    agent.resolveConflict("INV-3WAY", "amount", ids[0]!, [ids[1]!, crossTenantId], { tenantId: "tenant-resolution", decisionId: "decision-cross" }),
    /every active non-selected/i,
  );
  assert.equal((await store.listForAudit({ tenantId: "tenant-resolution" })).length, 3);
  const completed = await agent.resolveConflict("INV-3WAY", "amount", ids[0]!, [ids[1]!, ids[2]!], {
    tenantId: "tenant-resolution", decisionId: "decision-complete",
  });
  assert.equal(completed.after.activeCarriers, 1);
  await assert.rejects(
    agent.resolveConflict("INV-3WAY", "amount", ids[2]!, [ids[0]!, ids[1]!], { tenantId: "tenant-resolution", decisionId: "decision-stale" }),
    /stale|active non-selected/i,
  );
  assert.deepEqual((await store.listForAudit({ tenantId: "tenant-resolution" })).map((row) => row.id), [ids[0]!]);
});

test("atomic conflict resolution rolls back an injected mid-operation failure", async () => {
  class FaultStore extends InMemoryStore {
    fail = true;
    protected override beforeConflictResolutionCommit(): void {
      if (this.fail) throw new Error("injected conflict transaction failure");
    }
  }
  const store = new FaultStore();
  const { agent, ids } = await threeWayConflict(store);
  await assert.rejects(
    agent.resolveConflict("INV-3WAY", "amount", ids[2]!, [ids[0]!, ids[1]!], {
      tenantId: "tenant-resolution", decisionId: "decision-rollback",
    }),
    /injected conflict transaction failure/,
  );
  assert.equal((await store.listForAudit({ tenantId: "tenant-resolution" })).length, 3);
  assert.equal((await agent.auditConsistency({ tenantId: "tenant-resolution" })).contradictions.length, 1);
  store.fail = false;
  const repaired = await agent.resolveConflict("INV-3WAY", "amount", ids[2]!, [ids[0]!, ids[1]!], {
    tenantId: "tenant-resolution", decisionId: "decision-rollback",
  });
  assert.equal(repaired.after.activeCarriers, 1);
});

test("competing atomic conflict decisions serialize so exactly one wins", async () => {
  const store = new InMemoryStore();
  const { agent, ids } = await threeWayConflict(store);
  const outcomes = await Promise.allSettled([
    agent.resolveConflict("INV-3WAY", "amount", ids[0]!, [ids[1]!, ids[2]!], { tenantId: "tenant-resolution", decisionId: "decision-race-a" }),
    agent.resolveConflict("INV-3WAY", "amount", ids[2]!, [ids[0]!, ids[1]!], { tenantId: "tenant-resolution", decisionId: "decision-race-c" }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal((await store.listForAudit({ tenantId: "tenant-resolution" })).length, 1);
  assert.equal((await agent.auditConsistency({ tenantId: "tenant-resolution" })).ok, true);
});

test("atomic conflict resolution cannot select a same-subject non-carrier", async () => {
  const store = new InMemoryStore();
  const { agent, ids } = await threeWayConflict(store);
  const nonCarrier = await agent.remember("insight", "INV-3WAY was reviewed by a human.", {
    tenantId: "tenant-resolution",
    company: "Resolution Co",
    period: "2026-05",
    metadata: { record: "INV-3WAY", review_status: "reviewed" },
    idempotencyKey: "tenant-resolution:three-way:non-carrier",
  });
  await assert.rejects(
    agent.resolveConflict("INV-3WAY", "amount", nonCarrier, ids, {
      tenantId: "tenant-resolution", decisionId: "decision-non-carrier",
    }),
    /does not carry the disputed attribute/i,
  );
  const active = await store.listForAudit({ tenantId: "tenant-resolution", company: "Resolution Co" });
  assert.equal(active.length, 4, "a rejected non-carrier selection must mutate zero rows");
  assert.equal((await agent.auditConsistency({ tenantId: "tenant-resolution" })).contradictions.length, 1);
});
