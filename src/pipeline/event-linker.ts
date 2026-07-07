// EventLinkerAgent — ports the Archon `jobs/extraction/agents/event_linker.py`.
//
// Groups extracted documents by (company, period) and FUSES the payroll triplet —
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

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "unknown";
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// One fused event per (company, period) group.
export function linkEvents(docs: ExtractedDocument[]): PayrollEvent[] {
  const groups = new Map<string, ExtractedDocument[]>();
  for (const d of docs) {
    const key = `${d.company}::${d.period}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(d);
  }

  const events: PayrollEvent[] = [];
  for (const [, group] of groups) {
    const company = group[0]!.company;
    const period = group[0]!.period;
    const register = group.find((d) => d.doc_type === "payroll_register");
    const bank = group.find((d) => d.doc_type === "bank_confirmation");
    const payslips = group.filter((d) => d.doc_type === "payslip" && d.payslip);

    const employees: EmployeePayslip[] = payslips.map((d) => d.payslip!);

    // gross: register total, else sum of payslip gross.
    const gross_total = register?.gross_pay_total ?? sum(employees.map((e) => e.gross));
    // employer social security: register field, else register(cost-gross), else payslip sum.
    const employer_social_security_total =
      register?.employer_social_security_total ??
      (register?.employer_cost_total != null
        ? register.employer_cost_total - gross_total
        : sum(employees.map((e) => e.employer_social_security)));
    // true employer cost: register total, else gross + employer SS.
    const employer_cost_total =
      register?.employer_cost_total ?? gross_total + employer_social_security_total;
    // net cash that actually left the bank: bank confirmation, else payslip net sum.
    const bank_net_total = bank?.net_pay_total ?? sum(employees.map((e) => e.net));

    const employee_social_security_total = sum(employees.map((e) => e.employee_social_security));
    const tax_withheld_total = sum(employees.map((e) => e.tax));
    const employee_count = register?.employee_count ?? bank?.employee_count ?? employees.length;

    // Derived display fields (per the PayrollEvent field docs in src/types.ts).
    const cost_gap_amount = employer_social_security_total; // the off-bank employer wedge
    const cost_gap_pct = bank_net_total > 0 ? (cost_gap_amount / bank_net_total) * 100 : 0;
    const off_bank_cost = employer_cost_total - bank_net_total;

    events.push({
      event_id: `evt-${slug(company)}-${period}`,
      company,
      period,
      employee_count,
      bank_net_total,
      gross_total,
      employer_social_security_total,
      employee_social_security_total,
      tax_withheld_total,
      employer_cost_total,
      cost_gap_amount,
      cost_gap_pct: Number(cost_gap_pct.toFixed(1)),
      off_bank_cost,
      employees,
      linked_docs: group.map((d) => d.doc_id),
    });
  }
  return events;
}

export class EventLinkerAgent {
  link(docs: ExtractedDocument[]): PayrollEvent[] {
    return linkEvents(docs);
  }
}
