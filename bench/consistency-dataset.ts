// Labelled dataset for the self-auditing memory-consistency evaluation.
//
// A MemoryAgent accumulates facts across many separate write events ("sessions").
// This dataset simulates that: for several business records, TWO sessions each
// wrote a memory. In some records the two sessions AGREE (the control); in others
// a later session stored a DIFFERENT value for the same attribute (an injected
// cross-session contradiction). Plus a few dangling references (a memory points
// at a record no session ever stored) and unrelated records that merely SHARE
// attribute names (a `total` on an invoice and a `total` on an order) — the trap
// a naive audit would false-positive on.
//
// The point of the labels is to measure BOTH halves of the claim:
//   detection  — every injected contradiction/absence is flagged (recall), and
//   precision  — nothing in the consistent control is flagged (0 false positives).
//
// Domain-neutral on purpose (invoices, orders, customers — not payroll): the
// self-auditing capability is universal, not tied to any one document type.

import type { AuditMemory } from "../src/memory/consistency.js";

// Two ISO timestamps standing in for "session A" (earlier) and "session B" (later
// write event). The audit's "session" signal is exactly this createdAt gap.
const S_A = "2026-05-01T09:00:00.000Z";
const S_B = "2026-05-08T14:30:00.000Z";

export interface ConsistencyCase {
  memories: AuditMemory[];
  // Expected findings (the gold labels).
  expectContradictions: Array<{ subject: string; attribute: string }>;
  expectAbsences: string[]; // subjects that should be flagged absent
}

function mem(
  id: string,
  record: string,
  createdAt: string,
  metadata: Record<string, unknown>,
  content = ""
): AuditMemory {
  return {
    id,
    kind: "document",
    company: "Northwind Traders",
    period: "2026-05",
    sourceRef: record,
    content: content || `memory ${id} for ${record}`,
    metadata: { record, ...metadata },
    createdAt,
  };
}

export const CONSISTENCY_CASE: ConsistencyCase = {
  memories: [
    // ── Injected CONTRADICTIONS (session B disagrees with session A) ──────────
    // INV-2043: total €18,400 (A) vs €18,900 (B) — a real conflict.
    mem("c1a", "INV-2043", S_A, { total: 18400 }, "Invoice INV-2043 total €18,400."),
    mem("c1b", "INV-2043", S_B, { total: 18900 }, "Invoice INV-2043 total €18,900."),
    // CUST-77: credit_limit 5000 (A) vs 8000 (B).
    mem("c2a", "CUST-77", S_A, { credit_limit: 5000 }),
    mem("c2b", "CUST-77", S_B, { credit_limit: 8000 }),
    // PO-5590: quantity 12 (A) vs 15 (B).
    mem("c3a", "PO-5590", S_A, { quantity: 12, unit_price: 1075 }),
    mem("c3b", "PO-5590", S_B, { quantity: 15, unit_price: 1075 }), // unit_price AGREES → only quantity flags
    // VENDOR-BoxLine: status "active" (A) vs "suspended" (B) — string contradiction.
    mem("c4a", "VENDOR-BoxLine", S_A, { status: "active" }),
    mem("c4b", "VENDOR-BoxLine", S_B, { status: "suspended" }),

    // ── Consistent CONTROL (must NEVER be flagged) ────────────────────────────
    // INV-2051: both sessions agree on €9,250 (re-ingested, unchanged).
    mem("k1a", "INV-2051", S_A, { total: 9250 }),
    mem("k1b", "INV-2051", S_B, { total: 9250 }),
    // INV-2051 within float tolerance (9250 vs 9250.3) — noise, not a conflict.
    mem("k1c", "INV-2051", S_B, { total: 9250.3 }),
    // CUST-91: agrees on credit_limit; different attribute (region) added later.
    mem("k2a", "CUST-91", S_A, { credit_limit: 12000 }),
    mem("k2b", "CUST-91", S_B, { credit_limit: 12000, region: "north" }),
    // Different subjects that SHARE the attribute name `total` — the classic
    // false-positive trap. Distinct records, so no contradiction.
    mem("k3", "PINV-802", S_A, { total: 12900 }),
    mem("k4", "SO-330", S_A, { total: 9250 }),
    // A single-write record (only session A saw it) — nothing to compare against.
    mem("k5", "INV-2099", S_A, { total: 4100 }),

    // ── Injected ABSENCE (dangling reference) ─────────────────────────────────
    // The reconciliation memory references PO-5590 (present), PINV-802 (present)
    // and a payment record PAY-118 that NO session ever stored → PAY-118 absent.
    mem("a1", "RECON-5590", S_B, { refs: ["PO-5590", "PINV-802", "PAY-118"] },
      "Three-way match references PO-5590, PINV-802 and payment PAY-118."),
  ],
  expectContradictions: [
    { subject: "CUST-77", attribute: "credit_limit" },
    { subject: "INV-2043", attribute: "total" },
    { subject: "PO-5590", attribute: "quantity" },
    { subject: "VENDOR-BoxLine", attribute: "status" },
  ],
  expectAbsences: ["PAY-118"],
};
