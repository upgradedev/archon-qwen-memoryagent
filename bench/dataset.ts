// Frozen benchmark dataset — the gold standard for the retrieval evaluation.
//
// IMPORTANT: this dataset is FROZEN. It was written and its relevance labels
// fixed BEFORE the enhanced retriever existed, so the benchmark measures the
// retriever, not the other way round. Do not tune the corpus or labels to make a
// condition win — report whatever the metrics say.
//
// The corpus is a realistic slice of an Archon MemoryAgent's persistent memory:
// fused payroll events, per-employee lines, control insights, and validation
// findings across several companies and periods, plus remembered user
// preferences (the MemoryAgent track's "accumulates experience / remembers
// preferences" requirement). Distractor memories share vocabulary with the
// answers so naive dense recall can be fooled.
//
// Each query lists the memory ids that genuinely answer it (gold). Queries span
// three genres on purpose:
//   - paraphrase   : meaning matches, few shared tokens        → favors dense
//   - specific     : exact ids / euro figures / company names  → favors lexical
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
  // ── Acme Foods AE — 2026-03 ────────────────────────────────────────────────
  { id: "m01", content: "Payroll for Acme Foods AE in 2026-03: 3 employees, gross €52,000, true employer cost €63,800, net paid from bank €41,000." },
  { id: "m02", content: "Hidden payroll cost at Acme Foods AE for 2026-03: the bank salary transfer of €41,000 understates the true employer cost by €22,800 (55.6%), mostly employer social-security contributions of €11,800." },
  { id: "m03", content: "Maria Papadopoulou (id E-01) at Acme Foods AE in 2026-03: gross €22,000, net €17,200, employer cost €27,000." },
  { id: "m04", content: "Nikos Georgiou (id E-02) at Acme Foods AE in 2026-03: gross €18,000, net €14,100, employer cost €22,100." },
  { id: "m05", content: "Elena Dimitriou (id E-03) at Acme Foods AE in 2026-03: gross €12,000, net €9,700, employer cost €14,700." },
  { id: "m06", content: "Validation finding for Acme Foods AE 2026-03: bank confirmation total matches the sum of payslips within 0.4% (rule R1 passed)." },

  // ── Acme Foods AE — 2026-04 (period-over-period distractors) ────────────────
  { id: "m07", content: "Payroll for Acme Foods AE in 2026-04: 4 employees, gross €61,000, true employer cost €74,900, net paid from bank €48,200." },
  { id: "m08", content: "Hidden payroll cost at Acme Foods AE for 2026-04: the bank salary transfer of €48,200 understates the true employer cost by €26,700, mostly employer social-security contributions of €13,900." },
  { id: "m09", content: "Acme Foods AE headcount grew from 3 to 4 between 2026-03 and 2026-04 after hiring a warehouse operator." },

  // ── Helios Retail EPE — 2026-02 ─────────────────────────────────────────────
  { id: "m10", content: "Payroll for Helios Retail EPE in 2026-02: 2 employees, gross €28,000, true employer cost €34,300, net paid from bank €22,000." },
  { id: "m11", content: "Hidden payroll cost at Helios Retail EPE for 2026-02: the bank salary transfer of €22,000 understates the true employer cost by €12,300, mostly employer social-security contributions of €6,300." },
  { id: "m12", content: "Georgios Alexiou (id H-01) at Helios Retail EPE in 2026-02: gross €16,000, net €12,500, employer cost €19,600." },
  { id: "m13", content: "Sofia Ioannou (id H-02) at Helios Retail EPE in 2026-02: gross €12,000, net €9,500, employer cost €14,700." },
  { id: "m14", content: "Validation finding for Helios Retail EPE 2026-02: a bank payment of €3,200 has no matching supplier invoice (rule R3 failed, severity high)." },

  // ── ByteCraft Software MIKE — 2026-05 ───────────────────────────────────────
  { id: "m15", content: "Payroll for ByteCraft Software MIKE in 2026-05: 5 employees, gross €95,000, true employer cost €116,900, net paid from bank €74,000." },
  { id: "m16", content: "Hidden payroll cost at ByteCraft Software MIKE for 2026-05: the bank salary transfer of €74,000 understates the true employer cost by €42,900, mostly employer social-security contributions of €21,900." },
  { id: "m17", content: "Dimitris Katsaros (id B-04) at ByteCraft Software MIKE in 2026-05: gross €26,000, net €19,800, employer cost €32,000." },
  { id: "m18", content: "ByteCraft Software MIKE 2026-05 EBITDA was €38,400 on revenue of €210,000, a 18.3% margin." },
  { id: "m19", content: "Validation finding for ByteCraft Software MIKE 2026-05: VAT on three sales invoices was recorded at 13% but should be 24% (rule R2 failed)." },

  // ── Cross-cutting insights + remembered preferences (track: accumulate experience) ──
  { id: "m20", content: "Across all clients, employer social-security contributions add roughly 28% on top of the net salary that actually leaves the bank account — the single most under-reported cost for small businesses." },
  { id: "m21", content: "Cash flow uses the bank-confirmation transfers (real money out), while the P&L uses the full employer cost — mixing the two double-counts or understates payroll every time." },
  { id: "m22", content: "User preference: the CFO wants every summary to lead with the true employer cost, not the net bank figure, and to always flag the hidden social-security wedge." },
  { id: "m23", content: "User preference: report all amounts in euros rounded to the nearest hundred, and quote period-over-period change whenever a prior period exists." },
  { id: "m24", content: "User preference: treat any bank payment without a matching invoice as high severity and surface it at the top of the validation section." },

  // ── Distractors: same vocabulary, different subject (to fool naive recall) ───
  { id: "m25", content: "Office rent for Acme Foods AE in 2026-03 was €4,100 paid by bank transfer to the landlord; unrelated to payroll." },
  { id: "m26", content: "A supplier invoice from Helios Retail EPE's packaging vendor totalled €6,300 in 2026-02 — coincidentally equal to that month's employer contributions but a different transaction." },
  { id: "m27", content: "ByteCraft Software MIKE bought laptops for €21,900 in 2026-05; the amount matches employer contributions that month but is a capital expense, not payroll." },
  { id: "m28", content: "General note: gross salary is what an employee earns before deductions; net is what lands in their bank account after tax and employee social-security." },
  { id: "m29", content: "Glossary: 'employer cost' means gross salary plus the employer's own social-security contribution — the real cost of employing someone." },
  { id: "m30", content: "Acme Foods AE's electricity bill for 2026-04 was €1,250, paid from the same bank account as salaries but recorded under utilities." },
];

export const QUERIES: BenchQuery[] = [
  // paraphrase (meaning matches, little token overlap) → dense should do well
  { id: "q01", genre: "paraphrase", text: "How much of our staffing expense never shows up on the bank statement?", gold: ["m02", "m20"] },
  { id: "q02", genre: "paraphrase", text: "Why might we accidentally count wages twice when comparing profit and money leaving the account?", gold: ["m21"] },
  { id: "q03", genre: "paraphrase", text: "What does it truly cost us to employ one person?", gold: ["m29", "m20"] },
  { id: "q04", genre: "paraphrase", text: "Which client is growing its team?", gold: ["m09"] },
  { id: "q05", genre: "paraphrase", text: "How does the CFO like the executive summary framed?", gold: ["m22"] },

  // specific (exact ids / euro figures / company names) → lexical should rescue
  { id: "q06", genre: "specific", text: "What did employee E-03 earn?", gold: ["m05"] },
  { id: "q07", genre: "specific", text: "Show me Georgios Alexiou H-01 pay", gold: ["m12"] },
  { id: "q08", genre: "specific", text: "What was ByteCraft Software MIKE EBITDA in 2026-05?", gold: ["m18"] },
  { id: "q09", genre: "specific", text: "Which validation failed for the 24% VAT rate?", gold: ["m19"] },
  { id: "q10", genre: "specific", text: "employee E-02 net salary", gold: ["m04"] },

  // mixed (need meaning AND a discriminating token) → hybrid should win
  { id: "q11", genre: "mixed", text: "What is the hidden employer cost wedge at Helios Retail EPE?", gold: ["m11"] },
  { id: "q12", genre: "mixed", text: "Was there a bank payment with no matching invoice, and how serious is it?", gold: ["m14", "m24"] },
  { id: "q13", genre: "mixed", text: "What is the true employer cost for Acme Foods AE in 2026-04?", gold: ["m07"] },
  { id: "q14", genre: "mixed", text: "How large is the social-security gap at ByteCraft Software MIKE for May 2026?", gold: ["m16"] },
  { id: "q15", genre: "mixed", text: "In what currency and rounding should amounts be reported?", gold: ["m23"] },
];
