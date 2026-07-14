// ValidatorAgent — ports the Archon `jobs/extraction/agents/validator.py`.
//
// Deterministic cross-document consistency checks over a fused PayrollEvent.
// One ValidationResult per rule per event, with explicit operational policies:
//   R1  bank net ≈ sum(payslip net)              within 2%
//   R2  configurable employer_cost/net anomaly band (demo default [1.25,1.45])
//   R3  configurable payment-date grace after period end (default 7 days)
//   R4  employee_count == number of payslips      (when both present)
// The findings are written to memory as `validation` memories, so the agent can
// later recall (and self-audit) the checks that were run.

import type { PayrollEvent } from "../types.js";

export type Severity = "info" | "warning" | "error";
export type ValidationStatus = "passed" | "failed" | "not_evaluated";

export interface ValidationResult {
  rule: string;
  status: ValidationStatus;
  // Kept for backwards-compatible clients. It is false when evidence is absent;
  // consumers must use status to distinguish failure from not_evaluated.
  passed: boolean;
  severity: Severity;
  message: string;
}

export interface ValidationEvidence {
  hasBankConfirmation: boolean;
  hasPayrollRegister: boolean;
  hasPayslips: boolean;
  hasDeclaredEmployeeCount: boolean;
}

export interface ValidationPolicy {
  employerCostNetRatioMin: number;
  employerCostNetRatioMax: number;
  paymentGraceDays: number;
}

export const DEFAULT_VALIDATION_POLICY: ValidationPolicy = normalizePolicy({
  employerCostNetRatioMin: envNumber("EMPLOYER_COST_NET_RATIO_MIN", 1.25),
  employerCostNetRatioMax: envNumber("EMPLOYER_COST_NET_RATIO_MAX", 1.45),
  paymentGraceDays: envNumber("PAYMENT_GRACE_DAYS", 7),
});

function result(
  rule: string,
  status: ValidationStatus,
  severity: Severity,
  message: string,
): ValidationResult {
  return { rule, status, passed: status === "passed", severity, message };
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
  if (month < 1 || month > 12) return null;
  // Day 0 of the next month == last day of this month.
  return new Date(Date.UTC(year, month, 0));
}

function r1(event: PayrollEvent, evidence: ValidationEvidence): ValidationResult {
  const rule = "R1: bank net ≈ sum(payslip net) ±2%";
  if (!evidence.hasBankConfirmation || !evidence.hasPayslips) {
    return result(rule, "not_evaluated", "info", "Not evaluated — bank confirmation or payslips absent.");
  }
  const slipsTotal = event.employees.reduce((s, e) => s + e.net, 0);
  if (slipsTotal === 0) {
    return result(rule, "failed", "warning", "Payslip net totals sum to zero.");
  }
  const ratio = Math.abs(event.bank_net_total - slipsTotal) / slipsTotal;
  const passed = ratio <= 0.02;
  return result(
    rule,
    passed ? "passed" : "failed",
    passed ? "info" : "error",
    `Bank ${money(event.bank_net_total)} vs payslips ${money(slipsTotal)} (${(ratio * 100).toFixed(1)}% deviation — threshold 2%)`,
  );
}

function r2(
  event: PayrollEvent,
  evidence: ValidationEvidence,
  policy: ValidationPolicy,
): ValidationResult {
  const rule =
    `R2: anomaly heuristic employer_cost / net in ` +
    `[${policy.employerCostNetRatioMin.toFixed(2)}, ${policy.employerCostNetRatioMax.toFixed(2)}]`;
  if (!evidence.hasPayrollRegister || !evidence.hasBankConfirmation) {
    return result(rule, "not_evaluated", "info", "Not evaluated — payroll register or bank confirmation absent.");
  }
  if (event.employer_cost_total <= 0 || event.bank_net_total <= 0) {
    return result(rule, "failed", "warning", "Cost and net must both be positive.");
  }
  const ratio = event.employer_cost_total / event.bank_net_total;
  const passed = ratio >= policy.employerCostNetRatioMin && ratio <= policy.employerCostNetRatioMax;
  return result(
    rule,
    passed ? "passed" : "failed",
    passed ? "info" : "warning",
    `employer_cost ${money(event.employer_cost_total)} / net ${money(event.bank_net_total)} = ${ratio.toFixed(3)} ` +
      `(configured anomaly band; not legal or accounting truth)`,
  );
}

function r3(
  event: PayrollEvent,
  paymentDate: string | null | undefined,
  evidence: ValidationEvidence,
  policy: ValidationPolicy,
): ValidationResult {
  const rule = `R3: payment date <= period end + ${policy.paymentGraceDays} grace days`;
  const lastDay = lastDayOfPeriod(event.period);
  if (!lastDay) {
    return result(rule, "failed", "warning", `Invalid payroll period: ${event.period}`);
  }
  if (!evidence.hasBankConfirmation || !paymentDate) {
    return result(rule, "not_evaluated", "info", "Not evaluated — bank payment date absent.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    return result(rule, "failed", "warning", `Date parse error: ${paymentDate}`);
  }
  const paid = new Date(`${paymentDate}T00:00:00Z`);
  if (Number.isNaN(paid.getTime()) || paid.toISOString().slice(0, 10) !== paymentDate) {
    return result(rule, "failed", "warning", `Date parse error: ${paymentDate}`);
  }
  const allowedThrough = new Date(lastDay.getTime() + policy.paymentGraceDays * 86_400_000);
  const passed = paid.getTime() <= allowedThrough.getTime();
  return result(
    rule,
    passed ? "passed" : "failed",
    passed ? "info" : "warning",
    `Payment date ${paymentDate} vs configured allowed-through date ` +
      `${allowedThrough.toISOString().slice(0, 10)} (operational anomaly policy, not a legal deadline)`,
  );
}

function r4(event: PayrollEvent, evidence: ValidationEvidence): ValidationResult {
  const rule = "R4: employee_count == number of payslips";
  if (!evidence.hasDeclaredEmployeeCount || !evidence.hasPayslips) {
    return result(rule, "not_evaluated", "info", "Not evaluated — declared count or payslips absent.");
  }
  const passed = event.employee_count === event.employees.length;
  return result(
    rule,
    passed ? "passed" : "failed",
    passed ? "info" : "warning",
    `Declared ${event.employee_count} employees vs ${event.employees.length} payslips`,
  );
}

// Validate one fused event. `paymentDate` (bank confirmation value date) is
// carried separately because the fused PayrollEvent shape does not store it.
export function validateEvent(
  event: PayrollEvent,
  paymentDate?: string | null,
  evidence: ValidationEvidence = {
    hasBankConfirmation: event.bank_net_total > 0,
    hasPayrollRegister: event.employer_cost_total > 0,
    hasPayslips: event.employees.length > 0,
    hasDeclaredEmployeeCount: event.employee_count > 0,
  },
  policy: Partial<ValidationPolicy> = {},
): ValidationResult[] {
  const normalized = normalizePolicy({ ...DEFAULT_VALIDATION_POLICY, ...policy });
  return [
    r1(event, evidence),
    r2(event, evidence, normalized),
    r3(event, paymentDate, evidence, normalized),
    r4(event, evidence),
  ];
}

export class ValidatorAgent {
  constructor(private policy: Partial<ValidationPolicy> = {}) {}

  validate(
    event: PayrollEvent,
    paymentDate?: string | null,
    evidence?: ValidationEvidence,
  ): ValidationResult[] {
    return validateEvent(event, paymentDate, evidence, this.policy);
  }
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePolicy(policy: ValidationPolicy): ValidationPolicy {
  const min = bounded(policy.employerCostNetRatioMin, 0.01, 100, 1.25);
  const max = bounded(policy.employerCostNetRatioMax, min, 100, Math.max(min, 1.45));
  const grace = Math.trunc(bounded(policy.paymentGraceDays, 0, 90, 7));
  return { employerCostNetRatioMin: min, employerCostNetRatioMax: max, paymentGraceDays: grace };
}

function bounded(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
