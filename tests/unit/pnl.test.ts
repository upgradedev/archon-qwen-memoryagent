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
  hidden_total: 2100,
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
  // hidden cost = employer_cost - cash_out
  assert.equal(p.hidden_cost_total, 2100);
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
    { company: "ByteCraft", period: "2026-05", metadata: { hidden_total: 2100 } },
  ];
  const p = aggregatePnl(memories);
  assert.equal(p.events, 2);
  assert.equal(p.employer_cost_total, 12600);
  assert.equal(p.cash_out_total, 9500);
  assert.equal(p.hidden_cost_total, 3100);
  assert.equal(p.employee_count, 3);
  assert.equal(p.by_company.length, 2);
});

test("aggregatePnl: derives employer social security when not carried (cost - gross)", () => {
  const memories: PnlSourceMemory[] = [
    { company: "ByteCraft", period: "2026-05", metadata: { employer_cost_total: 8600, gross_total: 7000, bank_net_total: 6500, employee_count: 2 } },
  ];
  const p = aggregatePnl(memories);
  assert.equal(p.employer_social_security_total, 1600);
});

test("aggregatePnl: empty memory set → all zeros, no NaN", () => {
  const p = aggregatePnl([]);
  assert.equal(p.events, 0);
  assert.equal(p.employer_cost_total, 0);
  assert.equal(p.cost_gap_pct, 0);
  assert.equal(p.avg_cost_per_employee, 0);
  assert.deepEqual(p.by_company, []);
});
