// EventLinkerAgent — ports the Archon `jobs/extraction/agents/event_linker.py`.
//
// Groups extracted documents by (company, period, event reference) and FUSES the payroll triplet —
// the bank confirmation (net cash out), the payroll register (full employer cost),
// and the per-employee payslips — into ONE accurate `PayrollEvent`. This is the
// key insight the platform is built on: the bank confirmation alone understates
// the true employer payroll cost, because it never sees employer social-security
// contributions. The fused event carries the accurate number AND the off-bank gap.
//
// The output is THIS repo's existing `PayrollEvent` (src/types.ts) — the exact
// shape `MemoryAgent.ingestEvent()` already writes to memory. The pipeline PRODUCES
// the memories; the agent core is untouched.

import type { ExtractedDocument } from "./models.js";
import type { EmployeePayslip, PayrollEvent } from "../types.js";
import { normalizePayrollEvent } from "./payroll-integrity.js";
import { normalizeIso4217Currency } from "./currency.js";
import { canonicalIdentifier } from "./identity.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function slug(s: string): string {
  return s
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "") || "company";
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export class EventLinkError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "EventLinkError";
  }
}

// One fused event per (company, period, event reference) group.
export function linkEvents(docs: ExtractedDocument[]): PayrollEvent[] {
  const groups = new Map<string, ExtractedDocument[]>();
  for (const d of dedupeDocumentIds(docs)) {
    const key = JSON.stringify([canonicalCompany(d.company), d.period, canonicalEventRef(d.event_ref)]);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(d);
  }

  const events: PayrollEvent[] = [];
  for (const [, group] of groups) {
    const company = group
      .map((doc) => displayCompany(doc.company))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]!;
    const period = group[0]!.period;
    const eventRef = group
      .map((doc) => displayEventRef(doc.event_ref))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]!;
    const mergedRegister = mergeConsistentDocuments(
      group.filter((d) => d.doc_type === "payroll_register"),
      ["gross_pay_total", "employer_cost_total", "employer_social_security_total", "employee_count"],
    );
    const bank = mergeConsistentDocuments(
      group.filter((d) => d.doc_type === "bank_confirmation"),
      ["net_pay_total", "employee_count", "payment_date"],
    );
    const payslips = group.filter((d) => d.doc_type === "payslip" && d.payslip);
    if (!mergedRegister && !bank && payslips.length === 0) {
      throw new EventLinkError(`No recognized financial evidence for ${company} ${period}.`);
    }
    if (!mergedRegister || !bank) {
      throw new EventLinkError(
        `A complete payroll event for ${company} ${period} requires both a payroll register and bank confirmation.`,
      );
    }
    const register = completeRegisterTotals(mergedRegister, company, period);
    if (bank.net_pay_total == null) {
      throw new EventLinkError(
        `Bank confirmation for ${company} ${period} requires net_pay_total.`,
      );
    }

    const knownCurrencies = [...new Set(group
      .map((doc) => normalizedCurrency(doc.currency))
      .filter((value): value is string => value != null))];
    if (knownCurrencies.length > 1) {
      throw new EventLinkError(
        `Conflicting payroll currencies for ${company} ${period}: ${knownCurrencies.sort().join(", ")}.`,
      );
    }
    const currency = knownCurrencies[0];

    const employees = uniquePayslips(payslips);

    // gross: register total, else sum of payslip gross.
    const gross_total = register.gross_pay_total!;
    // employer social security: register field, else register(cost-gross), else payslip sum.
    const employer_social_security_total =
      register.employer_social_security_total!;
    if (employer_social_security_total < 0) {
      throw new EventLinkError(
        `Employer cost is below gross pay for ${company} ${period}; refusing a negative contribution total.`,
      );
    }
    // true employer cost: register total, else gross + employer SS.
    const employer_cost_total =
      register.employer_cost_total!;
    // net cash that actually left the bank: bank confirmation, else payslip net sum.
    const bank_net_total = bank.net_pay_total;

    const employee_social_security_total = sum(employees.map((e) => e.employee_social_security));
    const tax_withheld_total = sum(employees.map((e) => e.tax));
    if (
      register.employee_count != null &&
      bank.employee_count != null &&
      register.employee_count !== bank.employee_count
    ) {
      throw new EventLinkError(
        `Conflicting employee counts for ${company} ${period}: register ${register.employee_count}, bank ${bank.employee_count}.`,
      );
    }
    const employee_count = register.employee_count ?? bank.employee_count ?? employees.length;

    // Derived display fields (per the PayrollEvent field docs in src/types.ts).
    events.push(normalizePayrollEvent({
      event_id: stableEventId(company, period, eventRef),
      company,
      period,
      currency,
      event_ref: eventRef,
      employee_count,
      bank_net_total,
      gross_total,
      employer_social_security_total,
      employee_social_security_total,
      tax_withheld_total,
      employer_cost_total,
      cost_gap_amount: 0,
      cost_gap_pct: 0,
      off_bank_cost: 0,
      employees,
      linked_docs: [...new Set(group.map((d) => d.doc_id))].sort(),
    }));
  }
  return events;
}

function completeRegisterTotals(
  register: ExtractedDocument,
  company: string,
  period: string,
): ExtractedDocument {
  let gross = register.gross_pay_total;
  let cost = register.employer_cost_total;
  let employerSs = register.employer_social_security_total;
  const supplied = [gross, cost, employerSs].filter((value) => value != null).length;
  if (supplied < 2) {
    throw new EventLinkError(
      `Payroll register for ${company} ${period} requires any two of gross, employer cost, and employer social-security totals.`,
    );
  }
  if (gross != null && cost != null && employerSs != null && Math.abs(cost - (gross + employerSs)) > 0.01) {
    throw new EventLinkError(
      `Payroll register totals are inconsistent for ${company} ${period}: employer cost must equal gross + employer social security.`,
    );
  }
  if (gross == null) gross = cost! - employerSs!;
  if (employerSs == null) employerSs = cost! - gross;
  if (cost == null) cost = gross + employerSs;
  if (gross < 0 || employerSs < 0) {
    throw new EventLinkError(`Payroll register derived totals are negative for ${company} ${period}.`);
  }
  return {
    ...register,
    gross_pay_total: gross,
    employer_cost_total: cost,
    employer_social_security_total: employerSs,
  };
}

function normalizedCurrency(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const currency = normalizeIso4217Currency(value);
  if (!currency) throw new EventLinkError("Payroll currency must be a supported ISO 4217 code.");
  return currency;
}

type MergeField =
  | "gross_pay_total"
  | "employer_cost_total"
  | "employer_social_security_total"
  | "net_pay_total"
  | "employee_count"
  | "payment_date";

function mergeConsistentDocuments(
  docs: ExtractedDocument[],
  fields: MergeField[],
): ExtractedDocument | undefined {
  if (docs.length === 0) return undefined;
  const sorted = [...docs].sort((a, b) => (a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0));
  const merged: ExtractedDocument = { ...sorted[0]! };
  for (const doc of sorted.slice(1)) {
    for (const field of fields) {
      const current = merged[field];
      const candidate = doc[field];
      if (candidate == null) continue;
      if (current == null) {
        Object.assign(merged, { [field]: candidate });
      } else if (!sameMergeValue(field, current, candidate)) {
        throw new EventLinkError(
          `Conflicting ${field} values in ${sorted.map((d) => d.doc_id).join(", ")}.`,
        );
      }
    }
  }
  return merged;
}

function uniquePayslips(docs: ExtractedDocument[]): EmployeePayslip[] {
  const byEmployee = new Map<string, EmployeePayslip>();
  for (const doc of [...docs].sort((a, b) => (a.doc_id < b.doc_id ? -1 : 1))) {
    const employee = doc.payslip!;
    const employeeKey = canonicalIdentifier(employee.employee_id);
    const previous = byEmployee.get(employeeKey);
    if (previous && !samePayslip(previous, employee)) {
      throw new EventLinkError(
        `Conflicting payslips for employee ${employee.employee_id} (${doc.company} ${doc.period}).`,
      );
    }
    if (!previous) byEmployee.set(employeeKey, employee);
  }
  return [...byEmployee.values()];
}

function displayCompany(company: string): string {
  return company.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function canonicalCompany(company: string): string {
  return displayCompany(company).toLocaleLowerCase("en-US");
}

function stableEventId(company: string, period: string, eventRef: string): string {
  const canonical = canonicalCompany(company);
  const canonicalRef = canonicalEventRef(eventRef);
  const digest = createHash("sha256")
    .update(`${canonical}\0${canonicalRef}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `evt-${slug(canonical)}-${slug(canonicalRef)}-${digest}-${period}`;
}

function displayEventRef(eventRef: string | undefined): string {
  return (eventRef || "monthly-consolidated").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function canonicalEventRef(eventRef: string | undefined): string {
  return displayEventRef(eventRef).toLocaleLowerCase("en-US");
}

function sameMergeValue(field: MergeField, a: unknown, b: unknown): boolean {
  if (field === "payment_date" || field === "employee_count") return a === b;
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 0.01;
}

function samePayslip(a: EmployeePayslip, b: EmployeePayslip): boolean {
  return (
    canonicalIdentifier(a.employee_id) === canonicalIdentifier(b.employee_id) &&
    a.name === b.name &&
    Math.abs(a.gross - b.gross) <= 0.01 &&
    Math.abs(a.employee_social_security - b.employee_social_security) <= 0.01 &&
    Math.abs(a.tax - b.tax) <= 0.01 &&
    Math.abs(a.net - b.net) <= 0.01 &&
    Math.abs(a.employer_social_security - b.employer_social_security) <= 0.01 &&
    Math.abs(a.employer_cost - b.employer_cost) <= 0.01
  );
}

function dedupeDocumentIds(docs: ExtractedDocument[]): ExtractedDocument[] {
  const byId = new Map<string, ExtractedDocument>();
  for (const doc of docs) {
    const previous = byId.get(doc.doc_id);
    if (previous && !isDeepStrictEqual(previous, doc)) {
      throw new EventLinkError(`Conflicting extracted documents reuse doc_id ${doc.doc_id}.`);
    }
    if (!previous) byId.set(doc.doc_id, doc);
  }
  return [...byId.values()];
}

export class EventLinkerAgent {
  link(docs: ExtractedDocument[]): PayrollEvent[] {
    return linkEvents(docs);
  }
}
