// Built-in demo data for the "Run demo" button — universal financial terms only.
//
// A single sample company's payroll triplet (bank confirmation + payroll register
// + payslips) plus one deliberate cross-session CONTRADICTION, so an empty
// pgvector never looks broken: one click seeds a realistic memory the agent can
// recall AND self-audit. The documents' `content` is the JSON an extractor would
// return; POST /demo/seed runs them through the pipeline with the deterministic
// Fake extractor (free, no Qwen call, not rate-limited), so the demo is instant
// and repeatable on the live box regardless of whether a DashScope key is set.

import type { RawDocument } from "./pipeline/models.js";

export const DEMO_COMPANY = "Northwind Trading";
const PERIOD = "2026-05";

// Written LAST by /demo/seed after every independently idempotent component.
// Its presence is the only completion test: a payroll row alone may be the
// residue of a crashed/failed partial seed and must never make retries no-op.
// v4 also reconciles the two pre-currency demo sales rows that early public
// deployments wrote before invoice currency became mandatory. Keeping the
// version in the completion sentinel makes every existing v3 tenant run the
// one-time, idempotent cleanup on its next Run demo click.
export const DEMO_SEED_VERSION = "memoryagent-demo-v4";
export const DEMO_SEED_SENTINEL_SOURCE_REF = `demo-seed:${DEMO_SEED_VERSION}:complete`;
export const DEMO_EVENT_REF = "demo-payroll-v3";

// The numbers pass R1–R4: bank net == sum(payslip net) == 10,800;
// employer_cost / net = 14,600 / 10,800 = 1.352 ∈ [1.25, 1.45]; 3 == 3 payslips;
// payment date 2026-05-27 is within the period.
export const DEMO_DOCUMENTS: RawDocument[] = [
  {
    doc_id: "nw-register", filename: "payroll-register.pdf", source_kind: "text",
    company: DEMO_COMPANY, period: PERIOD, currency: "EUR", event_ref: DEMO_EVENT_REF,
    content: JSON.stringify({ doc_type: "payroll_register", gross_pay_total: 12000, employer_cost_total: 14600, employee_count: 3 }),
  },
  {
    doc_id: "nw-bank", filename: "bank-confirmation.pdf", source_kind: "text",
    company: DEMO_COMPANY, period: PERIOD, currency: "EUR", event_ref: DEMO_EVENT_REF,
    content: JSON.stringify({ doc_type: "bank_confirmation", net_pay_total: 10800, payment_date: "2026-05-27" }),
  },
  {
    doc_id: "nw-p1", filename: "payslip-cole.png", source_kind: "image",
    company: DEMO_COMPANY, period: PERIOD, currency: "EUR", event_ref: DEMO_EVENT_REF,
    content: JSON.stringify({ doc_type: "payslip", employee: { employee_id: "E-01", name: "Ana Cole", gross: 5000, employee_social_security: 150, tax: 350, net: 4500, employer_social_security: 900, employer_cost: 5900 } }),
  },
  {
    doc_id: "nw-p2", filename: "payslip-reed.png", source_kind: "image",
    company: DEMO_COMPANY, period: PERIOD, currency: "EUR", event_ref: DEMO_EVENT_REF,
    content: JSON.stringify({ doc_type: "payslip", employee: { employee_id: "E-02", name: "Tom Reed", gross: 4000, employee_social_security: 120, tax: 280, net: 3600, employer_social_security: 700, employer_cost: 4700 } }),
  },
  {
    doc_id: "nw-p3", filename: "payslip-novak.png", source_kind: "image",
    company: DEMO_COMPANY, period: PERIOD, currency: "EUR", event_ref: DEMO_EVENT_REF,
    content: JSON.stringify({ doc_type: "payslip", employee: { employee_id: "E-03", name: "Mia Novak", gross: 3000, employee_social_security: 100, tax: 200, net: 2700, employer_social_security: 1000, employer_cost: 4000 } }),
  },
];

// Two write events describing the SAME purchase invoice with DIFFERENT amounts —
// a cross-session contradiction the self-audit will flag (and recommend which to
// trust). `record` is the audit's subject key; `amount` is the disagreeing
// attribute. Written as `document` memories, so this does not affect the P&L view.
export const DEMO_CONTRADICTION: Array<{ content: string; amount: number }> = [
  { content: `Purchase invoice INV-5521 at ${DEMO_COMPANY} (2026-05): supplier order recorded at 8,400.`, amount: 8400 },
  { content: `Purchase invoice INV-5521 at ${DEMO_COMPANY} (2026-05): a later entry records the same invoice at 8,900.`, amount: 8900 },
];
export const DEMO_INVOICE_RECORD = "INV-5521";

// Two write events that OPPOSE each other in MEANING while sharing no comparable
// metadata field — the class of contradiction the rule-based audit is blind to.
// The rule-based /consistency groups by a record + attribute; these two carry no
// matching numeric attribute, only opposite prose ("on time" vs "chronically
// late"). The meaning-aware POST /consistency/semantic catches them: it embeds
// each memory, keeps the near-identical-subject pair by cosine, and asks the
// judge (configured Qwen model online, deterministic polarity heuristic offline) whether
// they contradict. Written as `insight` memories so the semantic beat can scope
// to kind="insight" for a fast, deterministic single finding on the live box.
export const DEMO_SEMANTIC: Array<{ content: string }> = [
  { content: `Vendor ${DEMO_COMPANY} always pays its supplier invoices on time.` },
  { content: `Vendor ${DEMO_COMPANY} is chronically late paying its supplier invoices.` },
];

export const DEMO_SALES: Array<{ content: string; metadata: Record<string, any> }> = [
  {
    content: "Sales invoice INV-SALES-101 issued to Chop Suey Chinese for EUR 28500.00 dated 2026-05-10.",
    metadata: {
      invoice_number: "INV-SALES-101",
      customer: "Chop Suey Chinese",
      total: 28500,
      currency: "EUR",
      invoice_date: "2026-05-10",
      type: "sales"
    }
  },
  {
    content: "Sales invoice INV-SALES-102 issued to Alfreds Futterkiste for EUR 14200.00 dated 2026-05-20.",
    metadata: {
      invoice_number: "INV-SALES-102",
      customer: "Alfreds Futterkiste",
      total: 14200,
      currency: "EUR",
      invoice_date: "2026-05-20",
      type: "sales"
    }
  }
];

// ── Template questions (the UI chips) ─────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the "try a question" chips the explorer renders and
// for the CI end-to-end test that proves each one is answerable. Every question
// here is provably grounded in the /demo/seed data above (the Northwind Trading
// payroll triplet + the INV-5521 contradiction), so a judge clicking any chip on
// a seeded box gets a grounded, cited answer — never the "no relevant memories"
// fallback. Universal financial terms only (positioning guard scans this file).
//
//   1. total employer cost      → the payroll-event summary memory (employer_cost_total)
//   2. cash off the bank line    → the off-bank workforce-cost insight memory
//   3. most expensive employee   → the per-employee payroll_event memories
//   4. conflicting invoice       → the two INV-5521 contradiction memories
//
// `q` is the question; `c` pre-fills the company filter so recall is scoped to
// the seeded company (the scope that guarantees a non-empty hit set).
export const DEMO_PRIMARY_RECALL_QUESTION =
  "Using only the retrieved memory, state the true employer cost for Northwind Trading in 2026-05 " +
  "and include citation marker [1] in the sentence.";

export const DEMO_TEMPLATES: Array<{ q: string; c: string }> = [
  { q: DEMO_PRIMARY_RECALL_QUESTION, c: DEMO_COMPANY },
  { q: "How much cash actually left the bank for salaries?", c: DEMO_COMPANY },
  { q: "Which employee costs the company the most?", c: DEMO_COMPANY },
  { q: "Is any invoice recorded with conflicting amounts?", c: DEMO_COMPANY },
];
