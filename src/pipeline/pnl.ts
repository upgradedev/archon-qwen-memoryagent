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
  // P&L (PnLAgent): the accurate payroll expense.
  employer_cost_total: number;
  gross_total: number;
  employer_social_security_total: number;
  employee_social_security_total: number;
  tax_withheld_total: number;
  // Cash flow (CashFlowAgent): the real cash that left the account.
  cash_out_total: number; // == bank_net_total
  // The insight: how much the bank transfer UNDERSTATES the true cost.
  hidden_cost_total: number; // employer_cost_total - cash_out_total
  cost_gap_pct: number; // hidden employer-contribution wedge over net
  avg_cost_per_employee: number;
  by_company: CompanyPnl[];
  top_employees: EmployeePnl[];
}

export interface CompanyPnl {
  company: string;
  period: string | null;
  employer_cost_total: number;
  cash_out_total: number;
  hidden_cost_total: number;
  employee_count: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Per-event P&L view (EmployeeAgent + PnLAgent) directly from a fused event.
export function pnlForEvent(event: PayrollEvent): PnlReport {
  const cash_out_total = event.bank_net_total;
  const hidden_cost_total = event.employer_cost_total - cash_out_total;
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
    hidden_cost_total: round(hidden_cost_total),
    cost_gap_pct: round(cost_gap_pct),
    avg_cost_per_employee:
      event.employee_count > 0 ? round(event.employer_cost_total / event.employee_count) : 0,
    by_company: [
      {
        company: event.company,
        period: event.period,
        employer_cost_total: round(event.employer_cost_total),
        cash_out_total: round(cash_out_total),
        hidden_cost_total: round(hidden_cost_total),
        employee_count: event.employee_count,
      },
    ],
    top_employees,
  };
}

// A stored event-summary memory as seen by the audit read (store.listForAudit):
// the per-event summary carries employer_cost_total in its metadata; the
// per-employee lines do not (so they are naturally excluded from the P&L sum).
export interface PnlSourceMemory {
  company: string;
  period: string | null;
  metadata: Record<string, unknown> | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Aggregate a P&L across the agent's STORED memories — this is what GET /pnl
// serves: a P&L view computed over the pipeline-generated memories the agent
// holds. Only event-summary memories (metadata carries employer_cost_total) are
// summed; per-employee lines are ignored.
export function aggregatePnl(memories: PnlSourceMemory[]): PnlReport {
  const summaries = memories.filter((m) => m.metadata && m.metadata.employer_cost_total != null);

  const byKey = new Map<string, CompanyPnl>();
  let employer_cost_total = 0;
  let gross_total = 0;
  let cash_out_total = 0;
  let employer_ss_total = 0;
  let employee_count = 0;

  for (const m of summaries) {
    const meta = m.metadata!;
    const cost = num(meta.employer_cost_total);
    const gross = num(meta.gross_total);
    const cash = num(meta.bank_net_total);
    const emp = num(meta.employee_count);
    employer_cost_total += cost;
    gross_total += gross;
    cash_out_total += cash;
    employer_ss_total += num(meta.employer_social_security_total) || cost - gross;
    employee_count += emp;

    const key = `${m.company}::${m.period}`;
    const prev = byKey.get(key) ?? {
      company: m.company,
      period: m.period,
      employer_cost_total: 0,
      cash_out_total: 0,
      hidden_cost_total: 0,
      employee_count: 0,
    };
    prev.employer_cost_total += cost;
    prev.cash_out_total += cash;
    prev.hidden_cost_total += cost - cash;
    prev.employee_count += emp;
    byKey.set(key, prev);
  }

  const hidden_cost_total = employer_cost_total - cash_out_total;
  return {
    events: summaries.length,
    employee_count,
    employer_cost_total: round(employer_cost_total),
    gross_total: round(gross_total),
    employer_social_security_total: round(employer_ss_total),
    employee_social_security_total: 0, // not carried on the summary memory
    tax_withheld_total: 0, // not carried on the summary memory
    cash_out_total: round(cash_out_total),
    hidden_cost_total: round(hidden_cost_total),
    cost_gap_pct: cash_out_total > 0 ? round((hidden_cost_total / cash_out_total) * 100) : 0,
    avg_cost_per_employee: employee_count > 0 ? round(employer_cost_total / employee_count) : 0,
    by_company: [...byKey.values()].map((c) => ({
      ...c,
      employer_cost_total: round(c.employer_cost_total),
      cash_out_total: round(c.cash_out_total),
      hidden_cost_total: round(c.hidden_cost_total),
    })),
    top_employees: [],
  };
}
