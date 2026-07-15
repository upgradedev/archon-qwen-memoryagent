import type { NormalizedPayrollEvent, PayrollEvent } from "../types.js";
import { normalizeIso4217Currency } from "./currency.js";

const MONEY_TOLERANCE = 0.01;

export class PayrollIntegrityError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "PayrollIntegrityError";
  }
}

/**
 * Validate the independently supplied payroll totals and derive every dependent
 * amount/ratio in one trusted place. Caller-provided derived values are ignored,
 * preventing stale percentages or arithmetic drift from entering memory.
 */
export function normalizePayrollEvent(
  event: PayrollEvent,
  options: { requireCompleteEmployees?: boolean } = {},
): NormalizedPayrollEvent {
  for (const field of [
    "bank_net_total",
    "gross_total",
    "employer_social_security_total",
    "employee_social_security_total",
    "tax_withheld_total",
    "employer_cost_total",
  ] as const) {
    requireNonNegativeFinite(event[field], field);
  }
  if (!Number.isInteger(event.employee_count) || event.employee_count < 0) {
    throw new PayrollIntegrityError("employee_count must be a non-negative integer");
  }
  if (!Array.isArray(event.employees)) {
    throw new PayrollIntegrityError("employees must be an array");
  }
  for (const employee of event.employees) {
    for (const field of [
      "gross",
      "employee_social_security",
      "tax",
      "net",
      "employer_social_security",
      "employer_cost",
    ] as const) {
      requireNonNegativeFinite(employee[field], `employee.${field}`);
    }
    if (!approximatelyEqual(employee.employer_cost, employee.gross + employee.employer_social_security)) {
      throw new PayrollIntegrityError(
        `employee ${employee.employee_id || "(unknown)"} employer_cost must equal gross + employer_social_security`,
      );
    }
    if (!approximatelyEqual(
      employee.gross,
      employee.net + employee.employee_social_security + employee.tax,
    )) {
      throw new PayrollIntegrityError(
        `employee ${employee.employee_id || "(unknown)"} gross must equal net + employee_social_security + tax`,
      );
    }
  }
  if (options.requireCompleteEmployees) {
    if (event.employees.length !== event.employee_count) {
      throw new PayrollIntegrityError(
        "employees must contain exactly employee_count rows for a fused direct event",
      );
    }
    requireAggregateMatch(event, "gross_total", sum(event.employees.map((employee) => employee.gross)));
    requireAggregateMatch(
      event,
      "employer_social_security_total",
      sum(event.employees.map((employee) => employee.employer_social_security)),
    );
    requireAggregateMatch(
      event,
      "employee_social_security_total",
      sum(event.employees.map((employee) => employee.employee_social_security)),
    );
    requireAggregateMatch(event, "tax_withheld_total", sum(event.employees.map((employee) => employee.tax)));
    requireAggregateMatch(event, "employer_cost_total", sum(event.employees.map((employee) => employee.employer_cost)));
    requireAggregateMatch(event, "bank_net_total", sum(event.employees.map((employee) => employee.net)));
  }
  if (!approximatelyEqual(
    event.employer_cost_total,
    event.gross_total + event.employer_social_security_total,
  )) {
    throw new PayrollIntegrityError(
      "employer_cost_total must equal gross_total + employer_social_security_total",
    );
  }
  if (options.requireCompleteEmployees && !approximatelyEqual(
    event.gross_total,
    event.bank_net_total + event.employee_social_security_total + event.tax_withheld_total,
  )) {
    throw new PayrollIntegrityError(
      "gross_total must equal bank_net_total + employee_social_security_total + tax_withheld_total",
    );
  }

  const currency = normalizePayrollCurrency(event.currency);
  const costGapAmount = event.employer_social_security_total;
  const offBankCost = event.employer_cost_total - event.bank_net_total;
  const costGapPct = event.bank_net_total > 0
    ? (costGapAmount / event.bank_net_total) * 100
    : 0;
  const offBankCostPct = event.bank_net_total > 0
    ? (offBankCost / event.bank_net_total) * 100
    : 0;

  return {
    ...event,
    ...(currency ? { currency } : { currency: undefined }),
    cost_gap_amount: round1(costGapAmount),
    cost_gap_pct: round1(costGapPct),
    off_bank_cost: round2(offBankCost),
    off_bank_cost_pct: round1(offBankCostPct),
  };
}

export function normalizePayrollCurrency(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const currency = normalizeIso4217Currency(value);
  if (!currency) throw new PayrollIntegrityError("currency must be a supported ISO 4217 code");
  return currency;
}

function requireAggregateMatch(
  event: PayrollEvent,
  field: keyof Pick<
    PayrollEvent,
    | "gross_total"
    | "employer_social_security_total"
    | "employee_social_security_total"
    | "tax_withheld_total"
    | "employer_cost_total"
    | "bank_net_total"
  >,
  employeeSum: number,
): void {
  if (!approximatelyEqual(event[field], employeeSum)) {
    throw new PayrollIntegrityError(`${field} must equal the sum of employee rows`);
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function requireNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new PayrollIntegrityError(`${field} must be a finite non-negative number`);
  }
}

function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= MONEY_TOLERANCE;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
