// Labelled dataset for the MEANING-LEVEL (semantic) self-audit evaluation.
//
// The rule-based audit (bench/consistency-dataset.ts) compares shared metadata
// fields. This dataset measures the OTHER half: memories that OPPOSE each other
// in MEANING while sharing no comparable metadata key — the class the rule-based
// path is blind to ("vendor always pays on time" vs "vendor is chronically late").
//
// METHOD — isolate the offline JUDGE, not the embedder.
// Each memory carries an EXPLICIT embedding on a per-subject orthogonal axis, so
// the subject gate is fully deterministic (same technique as the unit tests'
// V_SUBJECT / V_SUBJECT2). Two memories about the SAME subject share an axis
// (cosine ≈ 0.995 → clear the 0.9 gate); memories about DIFFERENT subjects are
// orthogonal (cosine 0 → the gate rejects them, so they are never judged). This
// makes precision/recall/FP a clean measurement of the offline opposition JUDGE's
// discrimination (the `FakeJudge` polarity/negation heuristic), free of embedder
// (bag-of-words) noise. The LIVE path swaps in real text-embedding-v4 vectors +
// the qwen-plus judge; this offline corpus measures exactly the CI path.
//
// The point of the labels is to measure BOTH halves of the claim:
//   recall     — same-subject opposed pairs the offline judge catches, and
//   PRECISION  — the load-bearing number: ZERO false positives on a hard control
//                of agreeing / negation-agreeing / complementary / different-
//                attribute / cross-cluster / different-subject pairs.
//
// Honesty (matches the repo's "measured, not aspirational" stance — cf.
// bench/accuracy-run.ts flooring grounding at its real 0.909, not 1.0): one gold
// contradiction is phrased with NO lexical polarity cue ("ahead of schedule" vs
// "behind schedule") that the offline heuristic can't see. The offline judge
// MISSES it by design — that miss is the honest motivation for the online
// qwen-plus judge, and it keeps recall at its measured value, not a hand-fit 100%.
//
// Domain-neutral on purpose (invoices, revenue, accounts — not payroll): the
// self-auditing capability is universal, not tied to any one document type.

import type { AuditMemory } from "../src/memory/consistency.js";
import type { SemanticMemory } from "../src/memory/semantic-consistency.js";

// Two ISO timestamps standing in for an earlier ("session A") and later ("session
// B") write event — the same cross-session signal the audit's resolution uses.
const S_A = "2026-05-01T09:00:00.000Z";
const S_B = "2026-05-20T14:30:00.000Z";

// The subject-similarity gate this corpus is built for. Same-subject axes land at
// cosine ≈ 0.995 (pass); different-subject axes at 0 (reject). 0.9 sits cleanly
// between, so the gate is unambiguous and the measurement is about the judge.
export const SEMANTIC_BENCH_THRESHOLD = 0.9;

// One labelled case: a pair of statements about a single subject, plus the label.
//   kind "contradiction"  — opposed in meaning; SHOULD be flagged.
//     `offlineDetectable=false` marks a contradiction with no lexical polarity cue
//     the offline heuristic can see (a deliberate, documented recall miss).
//   kind "control"        — same subject, NOT a contradiction; must NEVER flag.
//   kind "gate-reject"    — opposed prose but DIFFERENT subjects; the subject gate
//                           must reject the pair (it is never even judged).
interface SemanticCase {
  id: string;
  a: string;
  b: string;
  kind: "contradiction" | "control" | "gate-reject";
  note: string;
  offlineDetectable?: boolean; // contradiction cases only; default true
}

// ── The labelled corpus ───────────────────────────────────────────────────────
// 10 same-subject CONTRADICTIONS spanning every polarity cluster + a negation
// case (9 catchable offline, 1 cue-free miss), and 6 hard CONTROLS.
const CASES: SemanticCase[] = [
  // ── Contradictions (same subject, opposite meaning, no shared metadata field) ─
  {
    id: "punctuality",
    a: "Vendor Northwind always pays its supplier invoices on time.",
    b: "Vendor Northwind is chronically late paying its supplier invoices.",
    kind: "contradiction",
    note: "punctuality: on-time vs chronically late",
  },
  {
    id: "payment",
    a: "Invoice INV-90 has been settled in full.",
    b: "Invoice INV-90 is still outstanding.",
    kind: "contradiction",
    note: "payment: settled vs outstanding",
  },
  {
    id: "trend",
    a: "Quarterly revenue increased sharply this period.",
    b: "Quarterly revenue decreased sharply this period.",
    kind: "contradiction",
    note: "trend: increased vs decreased",
  },
  {
    id: "result",
    a: "The last quarter closed as a healthy profit.",
    b: "The last quarter closed as a loss.",
    kind: "contradiction",
    note: "result: profit vs loss",
  },
  {
    id: "decision",
    a: "The credit application was approved by the committee.",
    b: "The credit application was rejected by the committee.",
    kind: "contradiction",
    note: "decision: approved vs rejected",
  },
  {
    id: "status",
    a: "The customer account is currently active.",
    b: "The customer account was terminated last month.",
    kind: "contradiction",
    note: "status: active vs terminated",
  },
  {
    id: "solvency",
    a: "Independent review found the company fully solvent.",
    b: "Independent review found the company insolvent.",
    kind: "contradiction",
    note: "solvency: solvent vs insolvent (word-boundary trap: 'insolvent' contains 'solvent')",
  },
  {
    id: "compliance",
    a: "The supplier is fully compliant with the framework agreement.",
    b: "The supplier is in breach of the framework agreement.",
    kind: "contradiction",
    note: "compliance: compliant vs in breach",
  },
  {
    id: "negation",
    a: "This vendor never pays late.",
    b: "This vendor is chronically late with every invoice.",
    kind: "contradiction",
    note: "negation: 'never late' (negated-negative → positive) vs 'chronically late'",
  },
  {
    id: "cuefree",
    a: "The supplier delivers every shipment ahead of schedule.",
    b: "The supplier is consistently behind schedule.",
    kind: "contradiction",
    offlineDetectable: false,
    note: "cue-free: opposed in meaning but no lexical polarity cue — the honest offline MISS; the qwen-plus judge is what closes it",
  },

  // ── Controls (same subject, NOT a contradiction — must never be flagged) ──────
  {
    id: "ctl-agree",
    a: "Vendor Northwind always pays on time.",
    b: "Northwind is a reliable, punctual payer.",
    kind: "control",
    note: "agreeing: two same-direction punctuality statements",
  },
  {
    id: "ctl-neg-agree",
    a: "This vendor is not late with payments.",
    b: "This vendor pays every invoice on time.",
    kind: "control",
    note: "negation-agreement (the sharp trap): 'not late' AGREES with 'on time' — must NOT flag",
  },
  {
    id: "ctl-diff-attr",
    a: "The invoice total is 8,400 euros.",
    b: "The invoice is due on the 15th of the month.",
    kind: "control",
    note: "different attribute of the same invoice — no opposition",
  },
  {
    id: "ctl-complementary",
    a: "Revenue increased in the first quarter.",
    b: "Revenue increased again in the second quarter.",
    kind: "control",
    note: "complementary: same direction across two periods — not a contradiction",
  },
  {
    id: "ctl-cross-cluster",
    a: "The customer account is currently active.",
    b: "The account holder is fully compliant with the agreement.",
    kind: "control",
    note: "cross-cluster: 'active' (status) vs 'compliant' (compliance) — different axes, no opposition",
  },

  // ── Gate-reject (opposed prose, DIFFERENT subjects → the subject gate rejects) ─
  {
    id: "gate-diff-subject",
    a: "Vendor Alfa always pays its invoices on time.",
    b: "Vendor Beta is chronically late paying its invoices.",
    kind: "gate-reject",
    note: "opposed polarity BUT different subjects (orthogonal embeddings) — the gate must reject, never judged",
  },
];

// ── Deterministic per-subject orthogonal embeddings ───────────────────────────
// Axis `i` → the pair [e_i, normalize(e_i + 0.1·e_{N+i})]: within-subject cosine
// = 1/√1.01 ≈ 0.995 (clears the gate), cross-subject cosine = 0 (rejected). For a
// gate-reject case the two statements sit on TWO different axes, so they never
// pair. Dimension is 2·(#axes) — plenty of orthogonal room.
const AXES = CASES.length + 1; // one axis per case, +1 spare for the gate-reject's second subject
const DIM = 2 * AXES + 2;

function unit(vec: number[]): number[] {
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / n);
}
function axisA(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[i] = 1;
  return v; // already unit
}
function axisB(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[i] = 1;
  v[AXES + i] = 0.1; // small tilt into a private second block → cosine ≈ 0.995 with axisA(i)
  return unit(v);
}

// ── Assemble the flat memory corpus + the gold contradiction pair set ──────────
export interface SemanticBenchCorpus {
  memories: SemanticMemory[];
  // Gold same-subject contradiction pairs, as sorted "idA|idB" memory-id keys.
  goldPairs: Set<string>;
  // Gold pairs the OFFLINE judge is expected to miss (cue-free) — recall is scored
  // against ALL gold pairs; these document the honest gap, not a moved goalpost.
  offlineMissPairs: Set<string>;
}

function pairKey(id1: string, id2: string): string {
  return [id1, id2].sort().join("|");
}

export function buildSemanticBenchCorpus(): SemanticBenchCorpus {
  const memories: SemanticMemory[] = [];
  const goldPairs = new Set<string>();
  const offlineMissPairs = new Set<string>();

  CASES.forEach((c, idx) => {
    const idA = `${c.id}-a`;
    const idB = `${c.id}-b`;

    // Same subject → same axis for control + contradiction; different axes for the
    // gate-reject case (its two statements must NOT pair).
    const embA = axisA(idx);
    const embB = c.kind === "gate-reject" ? axisA(AXES) : axisB(idx);

    const base = (id: string, content: string, embedding: number[], createdAt: string): SemanticMemory => ({
      id,
      kind: "insight",
      company: "Acme",
      period: "2026-05",
      // Distinct sourceRefs + empty metadata → the RULE-BASED audit has nothing to
      // compare, so every finding here is genuinely meaning-level only.
      sourceRef: id,
      content,
      metadata: {},
      createdAt,
      importance: null,
      embedding,
    });

    memories.push(base(idA, c.a, embA, S_A));
    memories.push(base(idB, c.b, embB, S_B));

    if (c.kind === "contradiction") {
      const k = pairKey(idA, idB);
      goldPairs.add(k);
      if (c.offlineDetectable === false) offlineMissPairs.add(k);
    }
  });

  return { memories, goldPairs, offlineMissPairs };
}

// The plain AuditMemory view (drops embeddings) — lets the benchmark prove the
// RULE-BASED audit catches ZERO of these meaning-level contradictions (the number
// a naive store, and any field-level audit, would serve as truth).
export function corpusAsAuditMemories(): AuditMemory[] {
  return buildSemanticBenchCorpus().memories.map(({ embedding: _e, ...m }) => m);
}
