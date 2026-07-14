// Unit tests for the self-auditing memory-consistency engine — no DB, no key.
// These pin the two guarantees the headline rests on: every injected cross-
// session contradiction / dangling reference is flagged (detection), and NOTHING
// in the consistent control set is flagged (precision — 0 false positives).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditConsistency,
  resolveContradiction,
  subjectKey,
  type AuditMemory,
} from "../../src/memory/consistency.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { CONSISTENCY_CASE } from "../../bench/consistency-dataset.js";
import { RESOLUTION_CASE } from "../../bench/resolution-dataset.js";

const S_A = "2026-05-01T09:00:00.000Z";
const S_B = "2026-05-08T14:30:00.000Z";

function mem(
  id: string,
  record: string | null,
  createdAt: string,
  metadata: Record<string, unknown> | null,
  sourceRef: string | null = record
): AuditMemory {
  return {
    id,
    kind: "document",
    company: "Acme",
    period: "2026-05",
    sourceRef,
    content: `mem ${id}`,
    metadata: metadata ? { ...(record ? { record } : {}), ...metadata } : null,
    createdAt,
  };
}

test("subjectKey prefers metadata.record, then sourceRef, else null", () => {
  assert.equal(subjectKey(mem("1", "R1", S_A, {})), "R1");
  assert.equal(
    subjectKey({ ...mem("2", null, S_A, {}), sourceRef: "evt-1:E-03", metadata: {} }),
    "evt-1:E-03"
  );
  assert.equal(subjectKey({ ...mem("3", null, S_A, null), sourceRef: null }), null);
});

test("flags a cross-session contradiction on the same record + attribute", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "INV-1", S_B, { total: 200 }),
  ]);
  assert.equal(report.contradictions.length, 1);
  const c = report.contradictions[0]!;
  assert.equal(c.subject, "INV-1");
  assert.equal(c.attribute, "total");
  assert.deepEqual(c.values.map((v) => v.value).sort(), [100, 200]);
  // earliest write listed first (session ordering by timestamp)
  assert.equal(c.values[0]!.createdAt, S_A);
  assert.equal(report.ok, false);
});

test("agreeing re-ingests are NOT a contradiction (idempotent memory)", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "INV-1", S_B, { total: 100 }),
  ]);
  assert.equal(report.contradictions.length, 0);
  assert.equal(report.ok, true);
});

test("numbers within tolerance are treated as equal (float noise)", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 9250 }),
    mem("b", "INV-1", S_B, { total: 9250.3 }),
  ]);
  assert.equal(report.contradictions.length, 0);
});

test("distinct records sharing an attribute name do NOT collapse (no false positive)", () => {
  // The company::period trap: two different records both have `total`.
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "PO-9", S_A, { total: 200 }),
  ]);
  assert.equal(report.contradictions.length, 0, "different subjects must never contradict");
});

test("the same record id never collides across company or period scope", () => {
  const base = mem("a", "INV-1", S_A, { total: 100 });
  const report = auditConsistency([
    base,
    { ...mem("b", "INV-1", S_B, { total: 200 }), company: "OtherCo" },
    { ...mem("c", "INV-1", S_B, { total: 300 }), period: "2026-06" },
  ]);
  assert.equal(report.contradictions.length, 0);
});

test("per-record sourceRef keeps two employees in one event distinct", () => {
  // Real ingest shape: sourceRef = evt:employee, both carry `net`.
  const report = auditConsistency([
    { ...mem("e1", null, S_A, { net: 1000 }), sourceRef: "evt-1:E-01", metadata: { net: 1000 } },
    { ...mem("e2", null, S_A, { net: 2000 }), sourceRef: "evt-1:E-02", metadata: { net: 2000 } },
  ]);
  assert.equal(report.contradictions.length, 0);
});

test("only shared attributes are compared; a new attribute is not a conflict", () => {
  const report = auditConsistency([
    mem("a", "CUST-1", S_A, { credit_limit: 5000 }),
    mem("b", "CUST-1", S_B, { credit_limit: 5000, region: "north" }),
  ]);
  assert.equal(report.contradictions.length, 0);
});

test("flags a dangling reference (absence) and not present references", () => {
  const report = auditConsistency([
    mem("a", "RECON-1", S_A, { refs: ["INV-1", "MISSING-9"] }),
    mem("b", "INV-1", S_A, { total: 100 }),
  ]);
  assert.equal(report.absences.length, 1);
  assert.equal(report.absences[0]!.subject, "MISSING-9");
  assert.equal(report.absences[0]!.referencedBy[0]!.memoryId, "a");
});

test("a reference is only satisfied inside the same company and period", () => {
  const reference = mem("a", "RECON-1", S_A, { refs: ["INV-1"] });
  const otherTenant = { ...mem("b", "INV-1", S_A, { total: 100 }), company: "OtherCo" };
  const report = auditConsistency([reference, otherTenant]);
  assert.equal(report.absences.length, 1);
  assert.equal(report.absences[0]!.subject, "INV-1");
});

test("memories with no record key are counted but never flagged", () => {
  const report = auditConsistency([
    { ...mem("x", null, S_A, { total: 1 }), sourceRef: null, metadata: { total: 1 } },
    { ...mem("y", null, S_B, { total: 2 }), sourceRef: null, metadata: { total: 2 } },
  ]);
  assert.equal(report.audited, 2);
  assert.equal(report.contradictions.length, 0);
});

// The measured claim, pinned as a test: perfect detection + zero false positives
// on the labelled dataset (same data bench:consistency reports).
test("MEASURED: detects every injected contradiction/absence with 0 false positives", () => {
  const { memories, expectContradictions, expectAbsences } = CONSISTENCY_CASE;
  const report = auditConsistency(memories);

  const gotC = report.contradictions.map((c) => `${c.subject}::${c.attribute}`).sort();
  const goldC = expectContradictions.map((e) => `${e.subject}::${e.attribute}`).sort();
  assert.deepEqual(gotC, goldC, "contradictions must match the gold labels exactly");

  const gotA = report.absences.map((a) => a.subject).sort();
  const goldA = [...expectAbsences].sort();
  assert.deepEqual(gotA, goldA, "absences must match the gold labels exactly");

  // Exactly the injected problems, nothing from the control set.
  assert.equal(
    report.contradictions.length + report.absences.length,
    expectContradictions.length + expectAbsences.length
  );
});

// ── Resolution (recommender) — DETECT+RESOLVE ────────────────────────────────

test("every contradiction carries a resolution recommending a real memory", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "INV-1", S_B, { total: 200 }),
  ]);
  const r = report.contradictions[0]!.resolution;
  assert.ok(r, "resolution must be present");
  assert.ok(["recency", "importance", "source-authority"].includes(r.rule));
  assert.ok(r.confidence >= 0 && r.confidence <= 1, "confidence in [0,1]");
  assert.ok(["a", "b"].includes(r.recommendedMemoryId), "must point at a real memory");
  assert.ok(r.rationale.length > 0);
});

test("recency (default): the later write wins", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "INV-1", S_B, { total: 200 }),
  ]);
  const r = report.contradictions[0]!.resolution;
  assert.equal(r.rule, "recency");
  assert.equal(r.recommendedMemoryId, "b");
  assert.equal(r.recommendedValue, 200);
});

test("importance overrides recency: a flagged older memory beats a later one", () => {
  const report = auditConsistency([
    { ...mem("a", "P-1", S_A, { limit: 1000 }), metadata: { record: "P-1", limit: 1000, importance: 0.9 } },
    mem("b", "P-1", S_B, { limit: 1500 }),
  ]);
  const r = report.contradictions[0]!.resolution;
  assert.equal(r.rule, "importance");
  assert.equal(r.recommendedMemoryId, "a");
  assert.equal(r.recommendedValue, 1000);
});

test("source-authority overrides recency: a structured record beats a derived insight", () => {
  const report = auditConsistency([
    { ...mem("a", "ACCT-1", S_A, { balance: 5000 }), kind: "document" },
    { ...mem("b", "ACCT-1", S_B, { balance: 5200 }), kind: "insight" },
  ]);
  const r = report.contradictions[0]!.resolution;
  assert.equal(r.rule, "source-authority");
  assert.equal(r.recommendedMemoryId, "a");
  assert.equal(r.recommendedValue, 5000);
});

test("resolveContradiction falls back to recency for equal kinds + no importance", () => {
  const r = resolveContradiction([
    { value: 1, memories: [mem("a", "X", S_A, { v: 1 })] },
    { value: 2, memories: [mem("b", "X", S_B, { v: 2 })] },
  ]);
  assert.equal(r.rule, "recency");
  assert.equal(r.recommendedMemoryId, "b");
});

test("a timestamp tie is resolved deterministically with low confidence", () => {
  const r = resolveContradiction([
    { value: 1, memories: [mem("z", "X", S_A, { v: 1 })] },
    { value: 2, memories: [mem("a", "X", S_A, { v: 2 })] },
  ]);
  assert.equal(r.rule, "recency");
  assert.ok(r.confidence <= 0.5, "tie confidence must be modest");
  // deterministic tie-break: lexically smallest id among the latest carriers
  assert.equal(r.recommendedMemoryId, "a");
});

test("importance rule fires on a PRODUCTION-shaped memory (importance = the column)", async () => {
  // Real ingest writes salience to the top-level `importance` COLUMN, never into
  // metadata. This proves the whole chain end-to-end: store.remember(column) →
  // listForAudit → AuditMemory.importance → resolver's importance rule — with
  // NOTHING hand-placed in metadata. Both writes land at ~the same instant, so a
  // recency-only resolver would tie; importance must be what decides it.
  const store = new InMemoryStore();
  const embed = [1, 0, 0];
  const idImportant = await store.remember({
    kind: "document",
    company: "Acme",
    sourceRef: "INV-1",
    content: "Invoice INV-1 total 100 (flagged important).",
    metadata: { record: "INV-1", total: 100 }, // NB: no `importance` in metadata
    importance: 0.9, // ← the column, the production path
    embedding: embed,
    embedModel: "fake",
  });
  await store.remember({
    kind: "document",
    company: "Acme",
    sourceRef: "INV-1",
    content: "Invoice INV-1 total 200 (casual later write).",
    metadata: { record: "INV-1", total: 200 },
    importance: 0.3, // ← the column
    embedding: embed,
    embedModel: "fake",
  });

  const audit = await store.listForAudit({ company: "Acme" });
  // the column survived the store → AuditMemory mapping
  assert.ok(
    audit.every((m) => typeof m.importance === "number"),
    "listForAudit must surface the importance column"
  );

  const report = auditConsistency(audit);
  assert.equal(report.contradictions.length, 1);
  const r = report.contradictions[0]!.resolution;
  assert.equal(r.rule, "importance", "the top-priority rule must fire on column-sourced salience");
  assert.equal(r.recommendedMemoryId, idImportant);
  assert.equal(r.recommendedValue, 100);
});

// The measured resolution claim, pinned as a test (same data bench:resolution reports).
test("MEASURED: recommends the labelled winner + rule on every resolution case", () => {
  const { memories, expect } = RESOLUTION_CASE;
  const report = auditConsistency(memories);
  const byKey = new Map(report.contradictions.map((c) => [`${c.subject}::${c.attribute}`, c]));
  for (const e of expect) {
    const c = byKey.get(`${e.subject}::${e.attribute}`);
    assert.ok(c, `expected a contradiction for ${e.subject}.${e.attribute}`);
    assert.equal(c!.resolution.recommendedMemoryId, e.winnerMemoryId, `${e.subject} winner`);
    assert.equal(c!.resolution.rule, e.rule, `${e.subject} rule`);
  }
});
