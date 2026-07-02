// Unit tests for the self-auditing memory-consistency engine — no DB, no key.
// These pin the two guarantees the headline rests on: every injected cross-
// session contradiction / dangling reference is flagged (detection), and NOTHING
// in the consistent control set is flagged (precision — 0 false positives).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditConsistency,
  subjectKey,
  type AuditMemory,
} from "../../src/memory/consistency.js";
import { CONSISTENCY_CASE } from "../../bench/consistency-dataset.js";

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
