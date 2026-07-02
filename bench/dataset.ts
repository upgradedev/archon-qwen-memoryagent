// Frozen benchmark dataset — the gold standard for the retrieval evaluation.
//
// IMPORTANT: this dataset is FROZEN. Its relevance labels were fixed
// independently — each query's gold set is "the memories that genuinely answer
// it", assigned before any retrieval was run and never tuned to make a condition
// win. Report whatever the metrics say. (The honest results in BENCHMARK.md,
// including where hybrid does NOT beat dense on top-rank, are the proof we hold
// to this.)
//
// The corpus is a realistic slice of an Archon MemoryAgent's persistent memory
// for a unified financial-intelligence platform: it spans the FULL financial
// picture a small business accumulates — sales & purchase invoices, orders,
// customer receipts and supplier payments, bank statements and transfers,
// expenses, capital purchases, sales targets, P&L, EBITDA and cash position —
// together with the platform's own cross-checks (completeness, consistency and
// reconciliation findings), a couple of workforce-cost insights as ONE example
// among many, and remembered user preferences (the MemoryAgent track's
// "accumulates experience / remembers preferences" requirement). Distractor
// memories deliberately share vocabulary and euro figures with the answers so
// naive dense recall can be fooled.
//
// Each query lists the memory ids that genuinely answer it (gold). Queries span
// three genres on purpose:
//   - paraphrase   : meaning matches, few shared tokens        → favors dense
//   - specific     : terse exact ids / doc numbers             → favors lexical
//   - mixed        : needs both meaning and a specific token    → favors hybrid

export interface BenchMemory {
  id: string;
  content: string;
}

export interface BenchQuery {
  id: string;
  genre: "paraphrase" | "specific" | "mixed";
  text: string;
  gold: string[]; // ids of memories that correctly answer the query
}

export const CORPUS: BenchMemory[] = [
  // ── Sales invoices (revenue) ───────────────────────────────────────────────
  { id: "m01", content: "Sales invoice INV-2043 issued by Acme Foods to Northwind Traders on 2026-03: €18,400 for a wholesale grocery order, payable within 30 days." },
  { id: "m02", content: "Sales invoice INV-2051 issued by Acme Foods to Meridian Cafés on 2026-04: €9,250, paid on receipt." },

  // ── Purchase invoices (costs) ──────────────────────────────────────────────
  { id: "m03", content: "Purchase invoice PINV-771 from packaging supplier BoxLine to Helios Retail on 2026-02: €6,300 for shipping cartons, net 45 days." },
  { id: "m04", content: "Purchase invoice PINV-802 from wholesaler GrainCo to Acme Foods on 2026-03: €12,900 for raw materials." },

  // ── Orders (commitments, not yet costs/revenue) ────────────────────────────
  { id: "m05", content: "Purchase order PO-5590 from Acme Foods to GrainCo on 2026-03: 12 tonnes of flour at €1,075 per tonne, total €12,900." },
  { id: "m06", content: "Sales order SO-330 from Meridian Cafés to Acme Foods on 2026-04: a recurring monthly pastry supply worth €9,250." },

  // ── Receipts & payments (cash movements) ───────────────────────────────────
  { id: "m07", content: "Customer payment received by Acme Foods from Northwind Traders on 2026-04: €18,400 by bank transfer, settling sales invoice INV-2043." },
  { id: "m08", content: "Supplier payment by Helios Retail to BoxLine on 2026-03: €6,300 clearing purchase invoice PINV-771." },

  // ── Bank statements & transfers ────────────────────────────────────────────
  { id: "m09", content: "Bank statement for Helios Retail, 2026-02: opening balance €31,200, closing balance €19,700, across 14 transactions." },
  { id: "m10", content: "Bank transfer out of ByteCraft Software on 2026-05: €4,800 to CloudHost for annual server hosting." },

  // ── Expenses & capital purchases ───────────────────────────────────────────
  { id: "m11", content: "Office rent for Acme Foods in 2026-03: €4,100 paid by bank transfer to the landlord." },
  { id: "m12", content: "Electricity expense for Acme Foods in 2026-04: €1,250, recorded under utilities." },
  { id: "m13", content: "ByteCraft Software purchased laptops for €21,900 in 2026-05 — a capital expense, not an operating cost." },

  // ── Sales target ───────────────────────────────────────────────────────────
  { id: "m14", content: "Sales target for Acme Foods in 2026-Q2 is €95,000 in revenue; actual through 2026-04 stands at €61,300, about 65% of target." },

  // ── P&L, EBITDA, cash ──────────────────────────────────────────────────────
  { id: "m15", content: "P&L for Helios Retail in 2026-02: revenue €44,000, cost of goods sold €22,500, operating expenses €13,800, net profit €7,700." },
  { id: "m16", content: "P&L for ByteCraft Software in 2026-05: revenue €210,000, operating profit €41,200." },
  { id: "m17", content: "ByteCraft Software's 2026-05 EBITDA was €38,400 on revenue of €210,000, an 18.3% margin." },
  { id: "m18", content: "Cash position for Acme Foods at the end of 2026-04: €27,600 across two bank accounts, down €3,400 from the prior month." },

  // ── Workforce cost — ONE business aspect among many ────────────────────────
  { id: "m19", content: "Workforce cost for Acme Foods in 2026-03: 3 employees, gross €52,000, true employer cost €63,800, net paid from bank €41,000." },
  { id: "m20", content: "The €41,000 salary transfer at Acme Foods for 2026-03 understates the true cost of employing the team by €22,800 — mostly employer social-security contributions of €11,800 that never appear on the bank statement." },
  { id: "m21", content: "Across all clients, statutory employer contributions add roughly 28% on top of the net salary that leaves the bank account — a routinely under-counted cost." },

  // ── Completeness / consistency / reconciliation cross-checks ───────────────
  { id: "m22", content: "Completeness check for Helios Retail 2026-02: a €3,200 bank payment to Pallas Freight has no matching purchase invoice (high severity) — either the supplier never sent it, the accountant never recorded it, or the payment is wrong." },
  { id: "m23", content: "Completeness check for Acme Foods 2026-04: sales order SO-330 has no matching sales invoice yet, so €9,250 of revenue may be unrecorded." },
  { id: "m24", content: "Consistency check for ByteCraft Software 2026-05: VAT on three sales invoices was recorded at 13% but the standard rate is 24% — the invoices need correcting." },
  { id: "m25", content: "Reconciliation for Acme Foods 2026-03: purchase order PO-5590, purchase invoice PINV-802 and the supplier payment all agree at €12,900 — three-way match passed." },

  // ── Remembered user preferences (track: accumulate experience) ─────────────
  { id: "m26", content: "User preference: every summary should open with the consolidated P&L and cash position, then flag any missing or inconsistent documents." },
  { id: "m27", content: "User preference: report all amounts in euros rounded to the nearest hundred, and always quote the period-over-period change when a prior period exists." },
  { id: "m28", content: "User preference: treat any bank payment without a matching invoice as high severity and surface it at the top of the review." },

  // ── Distractors: same vocabulary / figures, different subject ──────────────
  { id: "m29", content: "General note: a purchase order is only a commitment to buy; it becomes a recorded cost when the matching invoice is received and approved." },
  { id: "m30", content: "Glossary: 'employer cost' means gross salary plus the employer's own social-security contribution — the real cost of employing someone." },
  { id: "m31", content: "A supplier statement from GrainCo showed €12,900 outstanding in 2026-03 — the same figure as invoice PINV-802, but a summary reminder, not a new charge." },
  { id: "m32", content: "Northwind Traders requested a €18,400 quote in 2026-02 for a possible order that was never placed — no invoice resulted." },
];

export const QUERIES: BenchQuery[] = [
  // paraphrase (meaning matches, little token overlap) → dense should do well
  { id: "q01", genre: "paraphrase", text: "Where might revenue be slipping through unbilled?", gold: ["m23"] },
  { id: "q02", genre: "paraphrase", text: "What does it truly cost us to keep someone on the team beyond their take-home pay?", gold: ["m30", "m21"] },
  { id: "q03", genre: "paraphrase", text: "Are we on track to hit our revenue goal this quarter?", gold: ["m14"] },
  { id: "q04", genre: "paraphrase", text: "How profitable was the software company last month?", gold: ["m16", "m17"] },
  { id: "q05", genre: "paraphrase", text: "How does the owner want the report laid out?", gold: ["m26"] },

  // specific (terse exact ids / doc numbers the way an agent pings memory) →
  // dense blurs bare alphanumeric tokens; lexical should rescue them
  { id: "q06", genre: "specific", text: "INV-2043 amount and terms", gold: ["m01"] },
  { id: "q07", genre: "specific", text: "PO-5590 flour order", gold: ["m05"] },
  { id: "q08", genre: "specific", text: "ByteCraft EBITDA 2026-05", gold: ["m17"] },
  { id: "q09", genre: "specific", text: "13% vs 24% VAT check", gold: ["m24"] },
  { id: "q10", genre: "specific", text: "PINV-771 supplier and terms", gold: ["m03"] },

  // mixed (need meaning AND a discriminating token) → hybrid should win
  { id: "q11", genre: "mixed", text: "Was there a bank payment with no matching invoice at Helios Retail, and how serious is it?", gold: ["m22", "m28"] },
  { id: "q12", genre: "mixed", text: "What is the hidden employer-cost gap at Acme Foods for 2026-03?", gold: ["m20"] },
  { id: "q13", genre: "mixed", text: "Did the flour purchase from GrainCo fully reconcile?", gold: ["m25"] },
  { id: "q14", genre: "mixed", text: "How much cash did Acme Foods hold at the end of April 2026?", gold: ["m18"] },
  { id: "q15", genre: "mixed", text: "In what currency and rounding should amounts be reported?", gold: ["m27"] },
];
