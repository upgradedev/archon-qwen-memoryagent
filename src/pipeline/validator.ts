// ValidatorAgent — ports the Archon `jobs/extraction/agents/validator.py`.
//
// Deterministic cross-document consistency checks over a fused PayrollEvent.
// One ValidationResult per rule per event, with the SAME thresholds as Archon:
//   R1  bank net ≈ sum(payslip net)              within 2%
//   R2  employer_cost_total / bank_net_total     in [1.25, 1.45]
//   R3  bank payment_date <= last day of period
//   R4  employee_count == number of payslips      (when both present)
// The findings are written to memory as `validation` memories, so the agent can
// later recall (and self-audit) the checks that were run.

import type { PayrollEvent } from "../types.js";

export type Severity = "info" | "warning" | "error";

export interface ValidationResult {
  rule: string;
  passed: boolean;
  severity: Severity;
  message: string;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Last calendar day of a YYYY-MM period (UTC-safe).
function lastDayOfPeriod(period: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  // Day 0 of the next month == last day of this month.
  return new Date(Date.UTC(year, month, 0));
}

function r1(event: PayrollEvent): ValidationResult {
  const rule = "R1: bank net ≈ sum(payslip net) ±2%";
  if (event.employees.length === 0) {
    return { rule, passed: true, severity: "info", message: "Skipped — no payslips." };
  }
  const slipsTotal = event.employees.reduce((s, e) => s + e.net, 0);
  if (slipsTotal === 0) {
    return { rule, passed: false, severity: "warning", message: "Payslip net totals sum to zero." };
  }
  const ratio = Math.abs(event.bank_net_total - slipsTotal) / slipsTotal;
  const passed = ratio <= 0.02;
  return {
    rule,
    passed,
    severity: passed ? "info" : "error",
    message: `Bank ${money(event.bank_net_total)} vs payslips ${money(slipsTotal)} (${(ratio * 100).toFixed(1)}% deviation — threshold 2%)`,
  };
}

function r2(event: PayrollEvent): ValidationResult {
  const rule = "R2: employer_cost / net in [1.25, 1.45]";
  if (!event.employer_cost_total || !event.bank_net_total) {
    return { rule, passed: true, severity: "info", message: "Skipped — cost or net absent." };
  }
  const ratio = event.employer_cost_total / event.bank_net_total;
  const passed = ratio >= 1.25 && ratio <= 1.45;
  return {
    rule,
    passed,
    severity: passed ? "info" : "warning",
    message: `employer_cost ${money(event.employer_cost_total)} / net ${money(event.bank_net_total)} = ${ratio.toFixed(3)} (expected 1.25–1.45)`,
  };
}

function r3(event: PayrollEvent, paymentDate?: string | null): ValidationResult {
  const rule = "R3: payment date <= last day of period";
  const lastDay = lastDayOfPeriod(event.period);
  if (!paymentDate || !lastDay) {
    return { rule, passed: true, severity: "info", message: "Skipped — payment date or period absent." };
  }
  const paid = new Date(`${paymentDate}T00:00:00Z`);
  if (Number.isNaN(paid.getTime())) {
    return { rule, passed: false, severity: "warning", message: `Date parse error: ${paymentDate}` };
  }
  const passed = paid.getTime() <= lastDay.getTime();
  return {
    rule,
    passed,
    severity: passed ? "info" : "warning",
    message: `Payment date ${paymentDate} vs period end ${lastDay.toISOString().slice(0, 10)}`,
  };
}

function r4(event: PayrollEvent): ValidationResult {
  const rule = "R4: employee_count == number of payslips";
  if (!event.employee_count || event.employees.length === 0) {
    return { rule, passed: true, severity: "info", message: "Skipped — count or payslips absent." };
  }
  const passed = event.employee_count === event.employees.length;
  return {
    rule,
    passed,
    severity: passed ? "info" : "warning",
    message: `Declared ${event.employee_count} employees vs ${event.employees.length} payslips`,
  };
}

// Validate one fused event. `paymentDate` (bank confirmation value date) is
// carried separately because the fused PayrollEvent shape does not store it.
export function validateEvent(event: PayrollEvent, paymentDate?: string | null): ValidationResult[] {
  return [r1(event), r2(event), r3(event, paymentDate), r4(event)];
}

export class ValidatorAgent {
  validate(event: PayrollEvent, paymentDate?: string | null): ValidationResult[] {
    return validateEvent(event, paymentDate);
  }
}
