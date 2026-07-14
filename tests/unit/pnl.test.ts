// Unit tests for the P&L metric math (src/pipeline/pnl.ts) — pure, no DB, no key.
// Covers per-event P&L (pnlForEvent) and the stored-memory aggregation used by
// GET /pnl (aggregatePnl).

import { test } from "node:test";
import assert from "node:assert/strict";
import { pnlForEvent, aggregatePnl } from "../../src/pipeline/pnl.js";
import type { PnlSourceMemory } from "../../src/pipeline/pnl.js";
import type { PayrollEvent } from "../../src/types.js";

const EVENT: PayrollEvent = {
  event_id: "evt-bytecraft-2026-05",
  company: "ByteCraft",
  period: "2026-05",
  employee_count: 2,
  bank_net_total: 6500,
  gross_total: 7000,
  employer_social_security_total: 1600,
  employee_social_security_total: 180,
  tax_withheld_total: 320,
  employer_cost_total: 8600,
  cost_gap_amount: 1600,
  cost_gap_pct: 24.6,
  off_bank_cost: 2100,
  employees: [
    { employee_id: "E-01", name: "Ana Cole", gross: 4000, employee_social_security: 100, tax: 200, net: 3700, employer_social_security: 500, employer_cost: 4500 },
    { employee_id: "E-02", name: "Tom Reed", gross: 3000, employee_social_security: 80, tax: 120, net: 2800, employer_social_security: 1100, employer_cost: 4100 },
  ],
  linked_docs: ["d-reg", "d-bank", "d-p1", "d-p2"],
};

test("pnlForEvent: employer cost is the accurate expense, cash-out is the bank net", () => {
  const p = pnlForEvent(EVENT);
  assert.equal(p.events, 1);
  assert.equal(p.employer_cost_total, 8600);
  assert.equal(p.cash_out_total, 6500);
  // off-bank cost = employer_cost - cash_out
  assert.equal(p.off_bank_cost, 2100);
  assert.equal(p.employee_count, 2);
});

test("pnlForEvent: avg cost per employee = employer_cost_total / count", () => {
  const p = pnlForEvent(EVENT);
  assert.equal(p.avg_cost_per_employee, 4300);
});

test("pnlForEvent: cost_gap_pct = employer social security over net", () => {
  const p = pnlForEvent(EVENT);
  // 1600 / 6500 * 100 = 24.615… → 24.62
  assert.equal(p.cost_gap_pct, 24.62);
});

test("pnlForEvent: top_employees are sorted by employer_cost, capped at 5", () => {
  const p = pnlForEvent(EVENT);
  assert.equal(p.top_employees.length, 2);
  assert.equal(p.top_employees[0]!.employee_id, "E-01"); // 4500 > 4100
});

test("pnlForEvent: zero employees → no divide-by-zero", () => {
  const empty: PayrollEvent = { ...EVENT, employee_count: 0, bank_net_total: 0, employees: [] };
  const p = pnlForEvent(empty);
  assert.equal(p.avg_cost_per_employee, 0);
  assert.equal(p.cost_gap_pct, 0);
});

test("aggregatePnl: sums only event-summary memories (metadata has employer_cost_total)", () => {
  const memories: PnlSourceMemory[] = [
    // Two event summaries for two companies.
    { company: "ByteCraft", period: "2026-05", metadata: { employer_cost_total: 8600, gross_total: 7000, bank_net_total: 6500, employee_count: 2 } },
    { company: "Helios", period: "2026-05", metadata: { employer_cost_total: 4000, gross_total: 3200, bank_net_total: 3000, employee_count: 1 } },
    // A per-employee line (NO employer_cost_total) — must be ignored.
    { company: "ByteCraft", period: "2026-05", metadata: { employee_id: "E-01", net: 3700, gross: 4000 } },
    // An insight (no metadata employer cost) — ignored.
    { company: "ByteCraft", period: "2026-05", metadata: { off_bank_cost: 2100 } },
  ];
  const p = aggregatePnl(memories);
  assert.equal(p.events, 2);
  assert.equal(p.employer_cost_total, 12600);
  assert.equal(p.cash_out_total, 9500);
  assert.equal(p.off_bank_cost, 3100);
  assert.equal(p.employee_count, 3);
  assert.equal(p.by_company.length, 2);
});

test("aggregatePnl: derives employer social security when not carried (cost - gross)", () => {
  const memories: PnlSourceMemory[] = [
    { company: "ByteCraft", period: "2026-05", metadata: { employer_cost_total: 8600, gross_total: 7000, bank_net_total: 6500, employee_count: 2 } },
  ];
  const p = aggregatePnl(memories);
  assert.equal(p.employer_social_security_total, 1600);
  assert.equal(p.cost_gap_pct, 24.62, "aggregate uses the same employer-SS/net definition as per-event P&L");
});

test("aggregatePnl: carries employee contributions and tax when the summary stores them", () => {
  const p = aggregatePnl([
    {
      kind: "payroll_event", company: "ByteCraft", period: "2026-05",
      metadata: {
        employer_cost_total: 8600, gross_total: 7000, bank_net_total: 6500,
        employer_social_security_total: 1600, employee_social_security_total: 180,
        tax_withheld_total: 320, employee_count: 2,
      },
    },
  ]);
  assert.equal(p.employee_social_security_total, 180);
  assert.equal(p.tax_withheld_total, 320);
});

test("aggregatePnl: payable purchases are expenses but not cash without payment evidence", () => {
  const p = aggregatePnl([
    {
      kind: "invoice", company: "ByteCraft", period: "2026-05", sourceRef: "INV-1",
      metadata: { vendor: "PaperCo", vendor_ref: "INV-1", total: 1000, invoice_date: "2026-05-01" },
    },
    {
      kind: "invoice", company: "ByteCraft", period: "2026-05", sourceRef: "INV-2",
      metadata: { vendor: "PowerCo", vendor_ref: "INV-2", total: 500, invoice_date: "2026-05-02", payment_status: "paid" },
    },
  ]);
  assert.equal(p.purchases_total, 1500);
  assert.equal(p.purchase_cash_out_total, 500);
  assert.equal(p.purchase_cash_unknown_total, 0);
  assert.equal(p.net_cash_outflow, 500);
  assert.deepEqual(p.purchases.map((x) => x.paid), [false, true]);
  assert.deepEqual(p.by_company, [], "vendors are not fabricated as reporting companies");
});

test("aggregatePnl: partial payments, refunds and unknown evidence use honest cash amounts", () => {
  const p = aggregatePnl([
    {
      kind: "invoice", company: "A", period: "2026-01", sourceRef: "I-1",
      metadata: { vendor: "V", total: 1000, currency: "EUR", paid_amount: 400 },
    },
    {
      kind: "invoice", company: "A", period: "2026-01", sourceRef: "I-2",
      metadata: { vendor: "V", total: 500, currency: "EUR", payment_date: "2026-01-10" },
    },
    {
      kind: "invoice", company: "A", period: "2026-01", sourceRef: "I-3",
      metadata: { vendor: "V", total: 200, currency: "EUR", paid_amount: -50 },
    },
    {
      kind: "invoice", company: "A", period: "2026-01", sourceRef: "I-4",
      metadata: { vendor: "V", total: 250, currency: "EUR", payment_status: "unknown" },
    },
  ]);
  assert.equal(p.purchase_cash_out_total, 350, "400 partial outflow less a 50 refund");
  assert.equal(p.purchase_cash_unknown_total, 750, "unknown invoice face values are flagged, not counted as paid");
  assert.equal(p.purchase_cash_unknown_count, 2);
  assert.equal(p.net_cash_outflow, 350);
  assert.deepEqual(p.purchases.map((x) => x.cash_status), ["partial", "unknown", "refund", "unknown"]);
  assert.deepEqual(p.purchases.map((x) => x.paid_amount), [400, null, -50, null]);
});

test("aggregatePnl: same invoice reference from different vendors never deduplicates", () => {
  const p = aggregatePnl([
    {
      kind: "invoice", company: "A", period: "2026-01", sourceRef: "INV-001",
      metadata: { vendor: "Vendor One", vendor_ref: "INV-001", total: 100, currency: "EUR" },
    },
    {
      kind: "invoice", company: "A", period: "2026-01", sourceRef: "INV-001",
      metadata: { vendor: "Vendor Two", vendor_ref: "INV-001", total: 200, currency: "EUR" },
    },
  ]);
  assert.equal(p.events, 2);
  assert.equal(p.purchases_total, 300);
});

test("aggregatePnl: mixed currencies are separated and top-level money is never cross-summed", () => {
  const p = aggregatePnl([
    {
      kind: "payroll_event", company: "A", period: "2026-01", sourceRef: "E-1",
      metadata: { employer_cost_total: 1000, gross_total: 800, bank_net_total: 700, employee_count: 1, currency: "USD" },
    },
    {
      kind: "invoice", company: "A", period: "2026-01", sourceRef: "INV-1",
      metadata: { type: "sales", customer: "C", invoice_number: "INV-1", total: 500, currency: "EUR" },
    },
  ]);
  assert.equal(p.currency_status, "mixed");
  assert.equal(p.currency, null);
  assert.equal(p.employer_cost_total, null);
  assert.equal(p.revenue_total, null);
  assert.deepEqual(p.by_currency.map((x) => x.currency), ["EUR", "USD"]);
  assert.equal(p.by_currency.find((x) => x.currency === "EUR")!.revenue_total, 500);
  assert.equal(p.by_currency.find((x) => x.currency === "USD")!.employer_cost_total, 1000);
});

test("aggregatePnl: repeated memories for one business record do not double-count", () => {
  const metadata = { employer_cost_total: 1000, gross_total: 800, bank_net_total: 700, employee_count: 1 };
  const p = aggregatePnl([
    { kind: "payroll_event", company: "A", period: "2026-01", sourceRef: "evt-a-2026-01", createdAt: "2026-01-01T00:00:00Z", metadata },
    { kind: "payroll_event", company: "A", period: "2026-01", sourceRef: "evt-a-2026-01", createdAt: "2026-01-02T00:00:00Z", metadata },
  ]);
  assert.equal(p.events, 1);
  assert.equal(p.employer_cost_total, 1000);
});

test("aggregatePnl: empty memory set → all zeros, no NaN", () => {
  const p = aggregatePnl([]);
  assert.equal(p.events, 0);
  assert.equal(p.employer_cost_total, 0);
  assert.equal(p.cost_gap_pct, 0);
  assert.equal(p.avg_cost_per_employee, 0);
  assert.deepEqual(p.by_company, []);
  assert.equal(p.currency_status, "empty");
  assert.deepEqual(p.by_currency, []);
});
