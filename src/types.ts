// Domain types for the Archon finance-close pipeline (the memory's subject
// matter). The typed PayrollEvent is the evidence-backed control finding:
//   - bank_confirmation : the net salary cash that left the company account
//   - payroll_register  : the full employer payroll cost (gross + employer social-security)
//   - payslip           : the per-employee payroll breakdown
//
// The bank confirmation alone *understates* the true employer payroll cost,
// because it never sees employer social-security contributions. Archon
// fuses the three into one accurate PayrollEvent and remembers the gap.

export interface EmployeePayslip {
  employee_id: string;
  name: string;
  gross: number;
  employee_social_security: number; // employee social-security contribution
  tax: number; // income tax withheld
  net: number; // what lands in the employee's bank account
  employer_social_security: number; // employer-side social-security contribution
  employer_cost: number; // gross + employer_social_security (true cost to the company)
}

export interface PayrollEvent {
  event_id: string;
  company: string;
  period: string; // YYYY-MM
  currency?: string; // ISO 4217 when evidence states it; absent means unknown
  event_ref?: string; // payroll run/batch identity within the period
  employee_count: number;
  bank_net_total: number; // from bank_confirmation
  gross_total: number; // from payroll_register
  employer_social_security_total: number;
  employee_social_security_total: number;
  tax_withheld_total: number;
  employer_cost_total: number; // THE accurate number (gross + employer social-security)
  // Two different, explicitly named comparisons. They must never be presented as
  // the same ratio: the contribution wedge is only one part of the full difference
  // between employer cost and the net salary transfer.
  cost_gap_amount: number; // employer_social_security_total
  cost_gap_pct: number; // employer_social_security_total / bank_net_total * 100
  off_bank_cost: number; // employer_cost_total - bank_net_total
  off_bank_cost_pct?: number; // off_bank_cost / bank_net_total * 100; populated by trusted ingestion
  employees: EmployeePayslip[];
  linked_docs: string[]; // doc_ids fused into this event
}

export type NormalizedPayrollEvent = PayrollEvent & { off_bank_cost_pct: number };
