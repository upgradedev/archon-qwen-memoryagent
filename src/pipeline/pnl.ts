// P&L metric math — ports the Archon analysis agents (PnLAgent / CashFlowAgent /
// EmployeeAgent) for the payroll document set. Pure functions, no I/O, no key —
// every branch is unit-testable.
//
// These payroll documents describe workforce COST (the employer's payroll
// expense and the cash that left the bank), so this is a payroll-cost P&L —
// exactly what the Nebius PnLAgent/CashFlowAgent compute from these doc types:
//   PnLAgent      → employer_cost_total is the accurate payroll EXPENSE
//                   (not the bank net, which omits employer social security).
//   CashFlowAgent → bank_net_total is the real CASH movement out of the account.
//   EmployeeAgent → per-employee cost analytics.

import type { PayrollEvent } from "../types.js";

export interface EmployeePnl {
  employee_id: string;
  name: string;
  gross: number;
  net: number;
  employer_cost: number;
}

export interface PnlReport {
  events: number;
  employee_count: number;
  // Payroll expenses
  employer_cost_total: number;
  gross_total: number;
  employer_social_security_total: number;
  employee_social_security_total: number;
  tax_withheld_total: number;
  cash_out_total: number; // net salaries paid
  off_bank_cost: number;  // employer taxes/ss
  cost_gap_pct: number;
  avg_cost_per_employee: number;
  
  // Vendor purchases & expenses
  purchases_total: number;
  purchases: Array<{ vendor: string; invoice_number: string; amount: number; date: string }>;
  
  // Combined P&L totals
  total_expenses: number; // employer_cost_total + purchases_total
  net_cash_outflow: number; // cash_out_total + purchases_total
  
  by_company: CompanyPnl[];
  top_employees: EmployeePnl[];
}

export interface CompanyPnl {
  company: string;
  period: string | null;
  employer_cost_total: number;
  cash_out_total: number;
  off_bank_cost: number;
  employee_count: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Per-event P&L view (EmployeeAgent + PnLAgent) directly from a fused event.
export function pnlForEvent(event: PayrollEvent): PnlReport {
  const cash_out_total = event.bank_net_total;
  const off_bank_cost = event.employer_cost_total - cash_out_total;
  const cost_gap_pct =
    cash_out_total > 0 ? (event.employer_social_security_total / cash_out_total) * 100 : 0;
  const top_employees: EmployeePnl[] = [...event.employees]
    .sort((a, b) => b.employer_cost - a.employer_cost)
    .slice(0, 5)
    .map((e) => ({
      employee_id: e.employee_id,
      name: e.name,
      gross: e.gross,
      net: e.net,
      employer_cost: e.employer_cost,
    }));
  return {
    events: 1,
    employee_count: event.employee_count,
    employer_cost_total: round(event.employer_cost_total),
    gross_total: round(event.gross_total),
    employer_social_security_total: round(event.employer_social_security_total),
    employee_social_security_total: round(event.employee_social_security_total),
    tax_withheld_total: round(event.tax_withheld_total),
    cash_out_total: round(cash_out_total),
    off_bank_cost: round(off_bank_cost),
    cost_gap_pct: round(cost_gap_pct),
    avg_cost_per_employee:
      event.employee_count > 0 ? round(event.employer_cost_total / event.employee_count) : 0,
    purchases_total: 0,
    purchases: [],
    total_expenses: round(event.employer_cost_total),
    net_cash_outflow: round(cash_out_total),
    by_company: [
      {
        company: event.company,
        period: event.period,
        employer_cost_total: round(event.employer_cost_total),
        cash_out_total: round(cash_out_total),
        off_bank_cost: round(off_bank_cost),
        employee_count: event.employee_count,
      },
    ],
    top_employees,
  };
}

// A stored event-summary memory as seen by the audit read (store.listForAudit)
export interface PnlSourceMemory {
  kind?: string;
  company: string;
  period: string | null;
  metadata: Record<string, unknown> | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Aggregate a P&L across the agent's STORED memories
export function aggregatePnl(memories: PnlSourceMemory[]): PnlReport {
  const summaries = memories.filter((m) => (m.kind === "payroll_event" || !m.kind) && m.metadata && m.metadata.employer_cost_total != null);
  const invoices = memories.filter((m) => m.kind === "invoice" && m.metadata && m.metadata.vendor !== "__smoke__");

  let employer_cost_total = 0;
  let gross_total = 0;
  let cash_out_total = 0;
  let employer_ss_total = 0;
  let employee_count = 0;

  for (const m of summaries) {
    const meta = m.metadata!;
    employer_cost_total += num(meta.employer_cost_total);
    gross_total += num(meta.gross_total);
    cash_out_total += num(meta.bank_net_total);
    employee_count += num(meta.employee_count);
    employer_ss_total += num(meta.employer_social_security_total) || num(meta.employer_cost_total) - num(meta.gross_total);
  }

  let purchases_total = 0;
  const purchasesList: Array<{ vendor: string; invoice_number: string; amount: number; date: string }> = [];
  const byKey = new Map<string, CompanyPnl>();

  // Process payroll events for byCompany
  for (const m of summaries) {
    const meta = m.metadata!;
    const cost = num(meta.employer_cost_total);
    const cash = num(meta.bank_net_total);
    const key = `${m.company}::${m.period || ''}`;
    const prev = byKey.get(key) ?? {
      company: m.company,
      period: m.period,
      employer_cost_total: 0,
      cash_out_total: 0,
      off_bank_cost: 0,
      employee_count: 0,
    };
    prev.employer_cost_total += cost;
    prev.cash_out_total += cash;
    prev.off_bank_cost += cost - cash;
    prev.employee_count += num(meta.employee_count);
    byKey.set(key, prev);
  }

  // Process invoices
  for (const m of invoices) {
    const meta = m.metadata!;
    const amt = num(meta.total);
    purchases_total += amt;
    
    const vendorName = String(meta.vendor || m.company || "Unknown");
    const invNumber = String(meta.vendor_ref || "None");
    const invDate = String(meta.invoice_date || "");

    purchasesList.push({
      vendor: vendorName,
      invoice_number: invNumber,
      amount: amt,
      date: invDate
    });

    // Also count vendor invoices as expenses for the company
    const key = `${vendorName}::Vendor`;
    const prev = byKey.get(key) ?? {
      company: vendorName,
      period: "Invoices",
      employer_cost_total: 0,
      cash_out_total: 0,
      off_bank_cost: 0,
      employee_count: 0,
    };
    prev.employer_cost_total += amt; // Add to total expenses
    prev.cash_out_total += amt; // Assume paid or payable
    byKey.set(key, prev);
  }

  const off_bank_cost = employer_cost_total - cash_out_total;

  return {
    events: summaries.length + invoices.length,
    employee_count,
    employer_cost_total: round(employer_cost_total),
    gross_total: round(gross_total),
    employer_social_security_total: round(employer_ss_total),
    employee_social_security_total: 0,
    tax_withheld_total: 0,
    cash_out_total: round(cash_out_total),
    off_bank_cost: round(off_bank_cost),
    cost_gap_pct: cash_out_total > 0 ? round((off_bank_cost / cash_out_total) * 100) : 0,
    avg_cost_per_employee: employee_count > 0 ? round(employer_cost_total / employee_count) : 0,
    
    purchases_total: round(purchases_total),
    purchases: purchasesList,
    total_expenses: round(employer_cost_total + purchases_total),
    net_cash_outflow: round(cash_out_total + purchases_total),
    
    by_company: [...byKey.values()].map((c) => ({
      ...c,
      employer_cost_total: round(c.employer_cost_total),
      cash_out_total: round(c.cash_out_total),
      off_bank_cost: round(c.off_bank_cost),
    })),
    top_employees: [],
  };
}
