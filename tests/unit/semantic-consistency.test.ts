// Unit tests for the SEMANTIC self-auditing layer — no DB, no key.
//
// The headline these pin: the semantic audit catches a class of contradiction
// the rule-based audit is BLIND to (two memories opposed in MEANING, sharing no
// comparable metadata key), read-only, with the SAME resolution recommendation
// shape, and ZERO false positives on unrelated or agreeing pairs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { auditConsistency, type AuditMemory } from "../../src/memory/consistency.js";
import {
  detectSemanticContradictions,
  auditSemanticConsistency,
  FakeJudge,
  QwenJudge,
  parseVerdict,
  defaultSemanticJudge,
  type SemanticMemory,
  type SemanticJudge,
  type JudgeVerdict,
} from "../../src/memory/semantic-consistency.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { DEMO_SEMANTIC, DEMO_COMPANY } from "../../src/demo-data.js";
import type { QwenChatClient } from "../../src/qwen/client.js";

const S_A = "2026-05-01T09:00:00.000Z";
const S_B = "2026-05-20T14:30:00.000Z";

// A memory carrying an explicit embedding vector for the PURE-detector tests, so
// the similarity gate is fully deterministic (no reliance on the fake embedder's
// token overlap). Metadata is IDENTICAL where present, so the rule-based audit
// has nothing to compare — the contradiction lives ONLY in the prose.
function smem(
  id: string,
  content: string,
  embedding: number[],
  createdAt: string,
  extra: Partial<SemanticMemory> = {}
): SemanticMemory {
  return {
    id,
    kind: "insight",
    company: "Acme",
    period: "2026-05",
    sourceRef: extra.sourceRef ?? id,
    content,
    metadata: extra.metadata ?? { vendor: "Northwind" },
    createdAt,
    importance: extra.importance ?? null,
    embedding,
  };
}

// Two unit vectors used across the pure tests: NEAR (same subject) and FAR.
const V_SUBJECT = [1, 0, 0];
const V_SUBJECT2 = [0.98, 0.199, 0]; // cosine ≈ 0.98 with V_SUBJECT
const V_OTHER = [0, 1, 0]; // cosine 0 with V_SUBJECT

// A trivially-deterministic judge that says "contradict" for a named pair of ids,
// so the pure detector can be tested independently of any polarity heuristic.
function scriptedJudge(contradictIds: Set<string>): SemanticJudge {
  return {
    modelId: "scripted-judge",
    async judge(a: string, b: string): Promise<JudgeVerdict> {
      const key = [a, b].sort().join("|");
      return contradictIds.has(key)
        ? { contradict: true, confidence: 0.9, reason: "scripted" }
        : { contradict: false, confidence: 0.5, reason: "scripted" };
    },
  };
}

test("PURE: rule-based MISSES a semantic contradiction that the semantic audit CATCHES", async () => {
  // Same vendor, opposed meaning, NO comparable metadata attribute → the exact
  // gap the semantic layer exists to close.
  const a = smem("a", "Vendor Northwind always pays its invoices on time.", V_SUBJECT, S_A);
  const b = smem("b", "Vendor Northwind is chronically late paying invoices.", V_SUBJECT2, S_B);

  // 1) Rule-based audit finds NOTHING (identical `vendor` metadata, no numeric clash).
  const ruleReport = auditConsistency([a as AuditMemory, b as AuditMemory]);
  assert.equal(ruleReport.contradictions.length, 0, "rule-based must be blind to the prose conflict");
  assert.equal(ruleReport.ok, true);

  // 2) Semantic audit CATCHES exactly one, read-only, with a resolution.
  const report = await detectSemanticContradictions([a, b], new FakeJudge(), {
    similarityThreshold: 0.8,
  });
  assert.equal(report.semanticContradictions.length, 1, "semantic must catch the meaning conflict");
  assert.equal(report.ok, false);
  const c = report.semanticContradictions[0]!;
  assert.equal(c.type, "semantic-contradiction");
  assert.ok(c.similarity >= 0.8);
  // earliest write listed first (session ordering)
  assert.equal(c.memories[0]!.memoryId, "a");
  assert.equal(c.memories[0]!.createdAt, S_A);
  // read-only recommendation, real memory id, same Resolution shape
  assert.ok(["recency", "importance", "source-authority"].includes(c.resolution.rule));
  assert.ok(["a", "b"].includes(c.resolution.recommendedMemoryId));
  assert.ok(c.resolution.confidence >= 0 && c.resolution.confidence <= 1);
  // default resolution here = recency (equal kind, no importance) → later write wins
  assert.equal(c.resolution.rule, "recency");
  assert.equal(c.resolution.recommendedMemoryId, "b");
});

test("PURE: input memories are never mutated (read-only guarantee)", async () => {
  const a = smem("a", "Vendor Northwind always pays on time.", V_SUBJECT, S_A);
  const b = smem("b", "Vendor Northwind is chronically late.", V_SUBJECT2, S_B);
  const snapshot = JSON.stringify([a, b]);
  await detectSemanticContradictions([a, b], new FakeJudge(), { similarityThreshold: 0.8 });
  assert.equal(JSON.stringify([a, b]), snapshot, "the audit must not mutate its inputs");
});

test("PURE: no false positive when the subject gate rejects an opposed-but-unrelated pair", async () => {
  // Opposite polarity, but DIFFERENT subjects (far embeddings) → not judged → no flag.
  const a = smem("a", "Vendor Northwind always pays on time.", V_SUBJECT, S_A, {
    metadata: { vendor: "Northwind" },
  });
  const b = smem("b", "Contoso's overdue account is chronically late.", V_OTHER, S_B, {
    metadata: { vendor: "Contoso" },
  });
  const report = await detectSemanticContradictions([a, b], new FakeJudge(), {
    similarityThreshold: 0.8,
  });
  assert.equal(report.compared, 0, "the subject gate must reject the unrelated pair (no judge call)");
  assert.equal(report.semanticContradictions.length, 0);
  assert.equal(report.ok, true);
});

test("PURE: no false positive on same-subject AGREEING memories", async () => {
  // Same subject, same polarity → judged, but NOT a contradiction.
  const a = smem("a", "Vendor Northwind always pays its invoices on time.", V_SUBJECT, S_A);
  const b = smem("b", "Northwind is a reliable, punctual payer.", V_SUBJECT2, S_B);
  const report = await detectSemanticContradictions([a, b], new FakeJudge(), {
    similarityThreshold: 0.8,
  });
  assert.equal(report.compared, 1, "same-subject pair must be judged");
  assert.equal(report.semanticContradictions.length, 0, "agreeing memories are not a contradiction");
});

test("PURE: resolution honours the importance ladder over recency", async () => {
  // Same conflict, but the EARLIER memory is flagged important → it must win,
  // proving the shared importance→authority→recency ladder is reused.
  const a = smem("a", "Vendor Northwind always pays on time.", V_SUBJECT, S_A, { importance: 0.9 });
  const b = smem("b", "Vendor Northwind is chronically late.", V_SUBJECT2, S_B);
  const report = await detectSemanticContradictions([a, b], new FakeJudge(), {
    similarityThreshold: 0.8,
  });
  const c = report.semanticContradictions[0]!;
  assert.equal(c.resolution.rule, "importance");
  assert.equal(c.resolution.recommendedMemoryId, "a");
});

test("PURE: judge calls are bounded by maxPairs", async () => {
  // Three mutually-similar memories = 3 pairs, but maxPairs caps the judge calls.
  const mems = [
    smem("a", "Northwind pays on time.", V_SUBJECT, S_A),
    smem("b", "Northwind is punctual.", V_SUBJECT2, S_A),
    smem("c", "Northwind is reliable.", [0.99, 0.14, 0], S_A),
  ];
  const report = await detectSemanticContradictions(mems, new FakeJudge(), {
    similarityThreshold: 0.8,
    maxPairs: 2,
  });
  assert.equal(report.compared, 2, "must not exceed the judge-call cap");
});

test("FakeJudge: detects opposing polarity including negation, ignores unrelated", async () => {
  const j = new FakeJudge();
  assert.equal((await j.judge("pays on time", "is chronically late")).contradict, true);
  assert.equal((await j.judge("the account is paid", "the account is unpaid")).contradict, true);
  assert.equal((await j.judge("revenue increased", "revenue decreased")).contradict, true);
  // negation flips polarity: "always on time" vs "does not pay on time"
  assert.equal((await j.judge("always on time", "does not pay on time").then((v) => v.contradict)), true);
  // unrelated / same-direction → no contradiction
  assert.equal((await j.judge("pays on time", "is a punctual reliable payer")).contradict, false);
  assert.equal((await j.judge("the invoice is for 100 euros", "the vendor is in Athens")).contradict, false);
});

test("E2E (offline): auditSemanticConsistency runs through FakeEmbedder + FakeJudge with zero creds", async () => {
  // Full wrapper path — embeds real content with the deterministic FakeEmbedder,
  // then judges. Threshold tuned for the bag-of-words fake (NOT the prod default).
  const memories: AuditMemory[] = [
    {
      id: "m1",
      kind: "insight",
      company: "Acme",
      period: "2026-05",
      sourceRef: "note-1",
      content: "Vendor Northwind Trading reliably pays every invoice on time each month.",
      metadata: { vendor: "Northwind Trading" },
      createdAt: S_A,
      importance: null,
    },
    {
      id: "m2",
      kind: "insight",
      company: "Acme",
      period: "2026-05",
      sourceRef: "note-2",
      content: "Vendor Northwind Trading pays every invoice late; chronically late each month.",
      metadata: { vendor: "Northwind Trading" },
      createdAt: S_B,
      importance: null,
    },
    {
      // A clearly-unrelated memory (different vocabulary) — must not be flagged.
      id: "m3",
      kind: "insight",
      company: "Acme",
      period: "2026-05",
      sourceRef: "note-3",
      content: "Office electricity spend rose sharply after the summer heatwave.",
      metadata: { vendor: "PowerCo" },
      createdAt: S_A,
      importance: null,
    },
  ];

  // Rule-based sees no conflict (identical vendor metadata, no numeric clash).
  assert.equal(auditConsistency(memories).contradictions.length, 0);

  const report = await auditSemanticConsistency(memories, new FakeEmbedder(), new FakeJudge(), {
    similarityThreshold: 0.3,
  });
  assert.equal(report.audited, 3);
  assert.equal(report.semanticContradictions.length, 1, "only the opposed same-subject pair is flagged");
  const c = report.semanticContradictions[0]!;
  assert.deepEqual(c.memories.map((m) => m.memoryId).sort(), ["m1", "m2"]);
  assert.equal(report.ok, false);
});

// ── QwenJudge (online path) — exercised offline via an injected fake client ───

function chatClientReturning(content: string | null): QwenChatClient {
  return {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

test("QwenJudge: parses a clean JSON verdict from the model", async () => {
  const j = new QwenJudge(chatClientReturning('{"contradict": true, "confidence": 0.88, "reason": "opposite"}'));
  const v = await j.judge("pays on time", "chronically late");
  assert.equal(v.contradict, true);
  assert.equal(v.confidence, 0.88);
  assert.equal(v.reason, "opposite");
});

test("QwenJudge: strips markdown code fences before parsing", async () => {
  const fenced = "```json\n{\"contradict\": false, \"confidence\": 0.2, \"reason\": \"different subject\"}\n```";
  const j = new QwenJudge(chatClientReturning(fenced));
  const v = await j.judge("a", "b");
  assert.equal(v.contradict, false);
  assert.equal(v.confidence, 0.2);
});

test("QwenJudge: FAILS CLOSED on unparseable output (never invents a contradiction)", async () => {
  const j = new QwenJudge(chatClientReturning("I think these might disagree, hard to say."));
  const v = await j.judge("a", "b");
  assert.equal(v.contradict, false, "garbage must not become a contradiction");
  assert.equal(v.confidence, 0);
});

test("QwenJudge: FAILS CLOSED when the client throws", async () => {
  const throwing: QwenChatClient = {
    chat: { completions: { async create() { throw new Error("upstream 500"); } } },
  };
  const j = new QwenJudge(throwing);
  const v = await j.judge("a", "b");
  assert.equal(v.contradict, false);
  assert.equal(v.reason, "judge unavailable");
});

test("parseVerdict: clamps confidence and ignores a missing boolean", () => {
  assert.deepEqual(parseVerdict('{"contradict": true, "confidence": 5}').confidence, 1);
  assert.equal(parseVerdict('{"confidence": 0.5}').contradict, false); // no boolean → fail closed
  assert.equal(parseVerdict("not json at all").contradict, false);
  // tolerates trailing prose after the JSON block
  assert.equal(parseVerdict('{"contradict": true, "confidence": 0.7} — done').contradict, true);
});

test("defaultSemanticJudge: picks the Fake offline (no DashScope key)", () => {
  const prev = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  try {
    assert.equal(defaultSemanticJudge().modelId, "fake-polarity-judge");
  } finally {
    if (prev !== undefined) process.env.DASHSCOPE_API_KEY = prev;
  }
});

// The SHIPPED demo fixture (src/demo-data.ts DEMO_SEMANTIC) must actually be
// detectable offline, so POST /consistency/semantic on a seeded box (and the demo
// video's semantic beat) has a real finding — not a hopeful curl. Uses the same
// FakeEmbedder + FakeJudge the offline stack uses; the FakeEmbedder's bag-of-words
// scale differs from real vectors, so a low subject-gate threshold is passed (the
// live box uses real text-embedding-v4 vectors at the tuned 0.75 default).
test("DEMO_SEMANTIC fixture: the shipped opposing pair is detected offline", async () => {
  const now = new Date().toISOString();
  const memories: AuditMemory[] = DEMO_SEMANTIC.map((s, i) => ({
    id: `demo-sem-${i}`,
    kind: "insight",
    company: DEMO_COMPANY,
    period: "2026-05",
    sourceRef: null,
    content: s.content,
    metadata: {},
    createdAt: now,
    importance: null,
  }));
  const report = await auditSemanticConsistency(memories, new FakeEmbedder(), new FakeJudge(), {
    similarityThreshold: 0.1,
  });
  assert.equal(report.ok, false, "the shipped demo pair must be flagged");
  assert.equal(report.semanticContradictions.length, 1, "exactly one meaning-level contradiction");
  assert.ok(
    report.semanticContradictions[0]!.resolution,
    "the finding carries a read-only resolution recommendation",
  );
});
