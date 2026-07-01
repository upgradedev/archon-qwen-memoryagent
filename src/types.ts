// Domain types for the Archon finance-close pipeline (the memory's subject
// matter). The typed PayrollEvent is the evidence-backed control finding:
//   - bank_confirmation : the net salary cash that left the company account
//   - payroll_register  : the full employer payroll cost (gross + employer IKA)
//   - payslip           : the per-employee payroll breakdown
//
// The bank confirmation alone *understates* the true employer payroll cost,
// because it never sees employer social-security (IKA) contributions. Archon
// fuses the three into one accurate PayrollEvent and remembers the gap.

export interface EmployeePayslip {
  employee_id: string;
  name: string;
  gross: number;
  employee_ika: number; // employee social-security contribution
  tax: number; // income tax withheld
  net: number; // what lands in the employee's bank account
  employer_ika: number; // employer-side social-security contribution
  employer_cost: number; // gross + employer_ika (true cost to the company)
}

export interface PayrollEvent {
  event_id: string;
  company: string;
  period: string; // YYYY-MM
  employee_count: number;
  bank_net_total: number; // from bank_confirmation
  gross_total: number; // from payroll_register
  employer_ika_total: number;
  employee_ika_total: number;
  tax_withheld_total: number;
  employer_cost_total: number; // THE accurate number (gross + employer IKA)
  // The headline insight: employer social-security contributions are invisible
  // on the bank salary-transfer confirmation, yet are ~28% of the net figure.
  cost_gap_amount: number; // the hidden employer-contribution wedge
  cost_gap_pct: number; // cost_gap_amount / bank_net_total * 100  (~28%)
  hidden_total: number; // employer_cost_total - bank_net_total
  employees: EmployeePayslip[];
  linked_docs: string[]; // doc_ids fused into this event
}
