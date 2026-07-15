// Labelled QA set for the objective figure-traceability benchmark.
// "hard, measured number on our own pipeline".
//
// Each row reuses a FROZEN retrieval query (so its real text-embedding-v4 vector
// is already in bench/fixtures/embeddings.json — no re-embed needed) and adds the
// gold euro FIGURE(S) that correctly answer it, read straight from the gold
// memory in bench/dataset.ts. We grade two things, both OBJECTIVELY (number
// presence, no LLM-judge, no prose grading — see BENCHMARK.md on why this
// sidesteps the brittleness/circularity we otherwise avoid):
//
//   GOLD EUR-TOKEN HIT — at least one developer-labelled amount appears with an
//                 explicit € / EUR marker in the answer.
//   COMPLETE EUR-LABELLED TRACEABILITY — every explicitly EUR-labelled amount
//                 in the answer also occurs, EUR-labelled, in recalled memory.
//
// Only number-bearing queries are included (preference/percentage-only queries
// like q05/q09/q15 have no single gold euro figure to grade objectively).

export interface AccuracyQuery {
  id: string; // matches a query id in bench/dataset.ts (reuses its cached embedding)
  question: string; // the exact frozen query text (embedded + narrated)
  goldFigures: number[]; // labelled euro figures (>=1 present ⇒ gold-figure hit)
  goldMemory: string; // the gold memory the figure comes from (provenance, not graded)
}

export const ACCURACY_SET: AccuracyQuery[] = [
  { id: "q01", question: "Where might revenue be slipping through unbilled?", goldFigures: [9250], goldMemory: "m23" },
  { id: "q03", question: "Are we on track to hit our revenue goal this quarter?", goldFigures: [95000, 61300], goldMemory: "m14" },
  { id: "q04", question: "How profitable was the software company last month?", goldFigures: [210000, 41200, 38400], goldMemory: "m16/m17" },
  { id: "q06", question: "INV-2043 amount and terms", goldFigures: [18400], goldMemory: "m01" },
  { id: "q07", question: "PO-5590 flour order", goldFigures: [12900], goldMemory: "m05" },
  { id: "q08", question: "ByteCraft EBITDA 2026-05", goldFigures: [38400], goldMemory: "m17" },
  { id: "q10", question: "PINV-771 supplier and terms", goldFigures: [6300], goldMemory: "m03" },
  { id: "q11", question: "Was there a bank payment with no matching invoice at Helios Retail, and how serious is it?", goldFigures: [3200], goldMemory: "m22" },
  { id: "q12", question: "What is the off-bank employer-cost gap at Acme Foods for 2026-03?", goldFigures: [22800], goldMemory: "m20" },
  { id: "q13", question: "Did the flour purchase from GrainCo fully reconcile?", goldFigures: [12900], goldMemory: "m25" },
  { id: "q14", question: "How much cash did Acme Foods hold at the end of April 2026?", goldFigures: [27600], goldMemory: "m18" },
];
