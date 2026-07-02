// Labelled dataset for the contradiction-RESOLUTION evaluation.
//
// Detection (bench/consistency-dataset.ts) proves the audit FINDS cross-session
// conflicts. This dataset measures the next step: for each conflict, does the
// recommender pick the value a defensible, domain-neutral policy would trust?
//
// The policy the engine implements is a fixed priority ladder over signals that
// already exist on the memories (no finance rulebook):
//   importance → source-authority → recency (default: the later write wins).
//
// Each case below is hand-labelled with the memory that SHOULD win and the rule
// that should decide it. The labels encode a defensible HUMAN policy — they were
// fixed to reflect what a reasonable analyst would choose, and the engine happens
// to implement that same policy. So this measures POLICY-CONFORMANCE of a pure,
// deterministic recommender, NOT a claim that the policy is universally optimal
// (the recommender is a recommender, never ground truth — see consistency.ts).
//
// Domain-neutral on purpose (invoices, accounts, policies — not payroll): the
// self-auditing + self-resolving capability is universal, not tied to any one
// document type, and NEVER encodes any country-specific tax-authority rule.

import type { AuditMemory } from "../src/memory/consistency.js";

// Three write-event timestamps standing in for three separate sessions.
const S_A = "2026-05-01T09:00:00.000Z";
const S_B = "2026-05-08T14:30:00.000Z";
const S_C = "2026-05-25T10:15:00.000Z";

export interface ResolutionCase {
  memories: AuditMemory[];
  // For every contradiction we expect the audit to raise, the memory that SHOULD
  // win and the rule that should decide it (the gold labels).
  expect: Array<{
    subject: string;
    attribute: string;
    winnerMemoryId: string;
    rule: "recency" | "importance" | "source-authority";
  }>;
}

function mem(
  id: string,
  record: string,
  createdAt: string,
  metadata: Record<string, unknown>,
  kind = "document"
): AuditMemory {
  return {
    id,
    kind,
    company: "Northwind Traders",
    period: "2026-05",
    sourceRef: record,
    content: `memory ${id} for ${record}`,
    metadata: { record, ...metadata },
    createdAt,
  };
}

export const RESOLUTION_CASE: ResolutionCase = {
  memories: [
    // ── RECENCY (default): no salience, same kind → the later write wins. ───────
    // INV-3001: total 100 (A) vs 120 (B). Nothing distinguishes them but time.
    mem("r1a", "INV-3001", S_A, { total: 100 }),
    mem("r1b", "INV-3001", S_B, { total: 120 }),
    // CUST-88: credit_limit 5000 (A) vs 8000 (C) — a wider write gap (higher conf).
    mem("r2a", "CUST-88", S_A, { credit_limit: 5000 }),
    mem("r2b", "CUST-88", S_C, { credit_limit: 8000 }),

    // ── IMPORTANCE: an explicitly flagged memory beats a LATER write with none. ─
    // POLICY-1: the OLDER memory (A) was flagged important (0.9); a later casual
    // write (B, no importance) lowered the limit. Salience should win over recency.
    mem("i1a", "POLICY-1", S_A, { limit: 1000, importance: 0.9 }),
    mem("i1b", "POLICY-1", S_B, { limit: 1500 }),

    // ── SOURCE-AUTHORITY: a structured record outranks a derived narrative. ─────
    // ACCT-7 balance: a STRUCTURED bank/document record (A, 5000) vs a later
    // DERIVED insight (B, 5200) that narrated an approximate figure. The
    // structured source is more authoritative for the raw value than the note,
    // even though the note is newer. (No importance on either → authority decides.)
    mem("s1a", "ACCT-7", S_A, { balance: 5000 }, "document"),
    mem("s1b", "ACCT-7", S_B, { balance: 5200 }, "insight"),
  ],
  expect: [
    { subject: "ACCT-7", attribute: "balance", winnerMemoryId: "s1a", rule: "source-authority" },
    { subject: "CUST-88", attribute: "credit_limit", winnerMemoryId: "r2b", rule: "recency" },
    { subject: "INV-3001", attribute: "total", winnerMemoryId: "r1b", rule: "recency" },
    { subject: "POLICY-1", attribute: "limit", winnerMemoryId: "i1a", rule: "importance" },
  ],
};
