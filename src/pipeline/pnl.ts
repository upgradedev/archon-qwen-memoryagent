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
  currency: string | null;
  currency_status: "empty" | "single" | "mixed";
  // Complete, independently summed views. Top-level monetary totals are null
  // when more than one currency is present; callers must use this breakdown.
  by_currency: CurrencyPnl[];
  events: number;
  employee_count: number;
  // Payroll expenses
  employer_cost_total: number | null;
  gross_total: number | null;
  employer_social_security_total: number | null;
  employee_social_security_total: number | null;
  tax_withheld_total: number | null;
  cash_out_total: number | null; // net salaries paid
  off_bank_cost: number | null;  // employer taxes/ss
  cost_gap_pct: number | null;
  avg_cost_per_employee: number | null;
  
  // Vendor purchases & expenses
  purchases_total: number | null;
  purchase_cash_out_total: number | null;
  purchase_cash_unknown_total: number | null;
  purchase_cash_unknown_count: number;
  purchases: Array<{
    vendor: string;
    invoice_number: string;
    amount: number;
    date: string;
    paid: boolean;
    currency: string;
    cash_status: "unpaid" | "partial" | "paid" | "refund" | "unknown";
    paid_amount: number | null;
  }>;
  
  // Sales & Revenue
  revenue_total: number | null;
  sales: Array<{ customer: string; invoice_number: string; amount: number; date: string; currency: string }>;
  
  // Combined P&L totals
  total_expenses: number | null; // employer_cost_total + purchases_total
  net_cash_outflow: number | null; // payroll cash + purchase invoices with known paid amount
  
  // Profitability
  net_profit: number | null; // revenue_total - total_expenses
  net_profit_margin_pct: number | null; // (net_profit / revenue_total) * 100

  by_company: CompanyPnl[];
  top_employees: EmployeePnl[];
}

export interface CurrencyPnl {
  currency: string;
  events: number;
  employee_count: number;
  employer_cost_total: number;
  gross_total: number;
  employer_social_security_total: number;
  employee_social_security_total: number;
  tax_withheld_total: number;
  cash_out_total: number;
  off_bank_cost: number;
  cost_gap_pct: number;
  avg_cost_per_employee: number;
  purchases_total: number;
  purchase_cash_out_total: number;
  purchase_cash_unknown_total: number;
  purchase_cash_unknown_count: number;
  revenue_total: number;
  total_expenses: number;
  net_cash_outflow: number;
  net_profit: number;
  net_profit_margin_pct: number;
}

export interface CompanyPnl {
  company: string;
  period: string | null;
  currency: string;
  employer_cost_total: number;
  cash_out_total: number;
  off_bank_cost: number;
  employee_count: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const DEFAULT_CURRENCY = "UNSPECIFIED";

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
    currency: DEFAULT_CURRENCY,
    currency_status: "single",
    by_currency: [{
      currency: DEFAULT_CURRENCY,
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
      avg_cost_per_employee: event.employee_count > 0 ? round(event.employer_cost_total / event.employee_count) : 0,
      purchases_total: 0,
      purchase_cash_out_total: 0,
      purchase_cash_unknown_total: 0,
      purchase_cash_unknown_count: 0,
      revenue_total: 0,
      total_expenses: round(event.employer_cost_total),
      net_cash_outflow: round(cash_out_total),
      net_profit: -round(event.employer_cost_total),
      net_profit_margin_pct: 0,
    }],
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
    purchase_cash_out_total: 0,
    purchase_cash_unknown_total: 0,
    purchase_cash_unknown_count: 0,
    purchases: [],
    revenue_total: 0,
    sales: [],
    total_expenses: round(event.employer_cost_total),
    net_cash_outflow: round(cash_out_total),
    net_profit: -round(event.employer_cost_total),
    net_profit_margin_pct: 0,
    by_company: [
      {
        company: event.company,
        period: event.period,
        employer_cost_total: round(event.employer_cost_total),
        cash_out_total: round(cash_out_total),
        off_bank_cost: round(off_bank_cost),
        employee_count: event.employee_count,
        currency: DEFAULT_CURRENCY,
      },
    ],
    top_employees,
  };
}

// A stored event-summary memory as seen by the audit read (store.listForAudit)
export interface PnlSourceMemory {
  kind?: string;
  sourceRef?: string | null;
  createdAt?: string;
  company: string;
  period: string | null;
  metadata: Record<string, unknown> | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Aggregate a P&L across the agent's STORED memories
export function aggregatePnl(memories: PnlSourceMemory[]): PnlReport {
  const relevant = memories.filter((memory) =>
    Boolean(
      memory.metadata &&
      (((memory.kind === "payroll_event" || !memory.kind) &&
        memory.metadata.employer_cost_total != null) ||
        (memory.kind === "invoice" && memory.metadata.vendor !== "__smoke__")),
    ),
  );
  if (relevant.length === 0) return emptyPnlReport();

  const byCurrency = new Map<string, PnlSourceMemory[]>();
  for (const memory of relevant) {
    const currency = currencyOf(memory);
    (byCurrency.get(currency) ?? byCurrency.set(currency, []).get(currency)!).push(memory);
  }
  const details = [...byCurrency]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, scoped]) => aggregateCurrency(scoped, currency));
  const breakdowns = details.map(({ purchases: _p, sales: _s, by_company: _b, ...totals }) => totals);

  if (details.length === 1) {
    const detail = details[0]!;
    return {
      ...detail,
      currency_status: "single",
      by_currency: breakdowns,
      top_employees: [],
    };
  }

  // Counts and row lists can be combined; monetary values cannot. Null makes it
  // impossible for a client to accidentally present USD+EUR as one total.
  return {
    currency: null,
    currency_status: "mixed",
    by_currency: breakdowns,
    events: details.reduce((sum, item) => sum + item.events, 0),
    employee_count: details.reduce((sum, item) => sum + item.employee_count, 0),
    employer_cost_total: null,
    gross_total: null,
    employer_social_security_total: null,
    employee_social_security_total: null,
    tax_withheld_total: null,
    cash_out_total: null,
    off_bank_cost: null,
    cost_gap_pct: null,
    avg_cost_per_employee: null,
    purchases_total: null,
    purchase_cash_out_total: null,
    purchase_cash_unknown_total: null,
    purchase_cash_unknown_count: details.reduce(
      (sum, item) => sum + item.purchase_cash_unknown_count,
      0,
    ),
    purchases: details.flatMap((item) => item.purchases),
    revenue_total: null,
    sales: details.flatMap((item) => item.sales),
    total_expenses: null,
    net_cash_outflow: null,
    net_profit: null,
    net_profit_margin_pct: null,
    by_company: details.flatMap((item) => item.by_company),
    top_employees: [],
  };
}

interface CurrencyDetail extends CurrencyPnl {
  purchases: PnlReport["purchases"];
  sales: PnlReport["sales"];
  by_company: CompanyPnl[];
}

function aggregateCurrency(memories: PnlSourceMemory[], currency: string): CurrencyDetail {
  const summaries = dedupeLatest(
    memories.filter((m) =>
      (m.kind === "payroll_event" || !m.kind) &&
      m.metadata?.employer_cost_total != null
    ),
    payrollBusinessKey,
  );
  const invoices = dedupeLatest(
    memories.filter((m) => m.kind === "invoice" && m.metadata),
    invoiceBusinessKey,
  );
  const purchases = invoices.filter((m) => m.metadata?.type !== "sales");
  const sales = invoices.filter((m) => m.metadata?.type === "sales");

  let employerCost = 0;
  let gross = 0;
  let payrollCash = 0;
  let employerSs = 0;
  let employeeSs = 0;
  let tax = 0;
  let employeeCount = 0;
  const companyRows = new Map<string, CompanyPnl>();
  for (const memory of summaries) {
    const meta = memory.metadata!;
    const cost = num(meta.employer_cost_total);
    const cash = num(meta.bank_net_total);
    employerCost += cost;
    gross += num(meta.gross_total);
    payrollCash += cash;
    employeeCount += num(meta.employee_count);
    employerSs += meta.employer_social_security_total != null
      ? num(meta.employer_social_security_total)
      : cost - num(meta.gross_total);
    employeeSs += num(meta.employee_social_security_total);
    tax += num(meta.tax_withheld_total);

    const key = JSON.stringify([canonical(memory.company), memory.period, currency]);
    const row = companyRows.get(key) ?? {
      company: memory.company,
      period: memory.period,
      currency,
      employer_cost_total: 0,
      cash_out_total: 0,
      off_bank_cost: 0,
      employee_count: 0,
    };
    row.employer_cost_total += cost;
    row.cash_out_total += cash;
    row.off_bank_cost += cost - cash;
    row.employee_count += num(meta.employee_count);
    companyRows.set(key, row);
  }

  let purchaseAccrual = 0;
  let purchaseCash = 0;
  let unknownCashFace = 0;
  let unknownCashCount = 0;
  const purchaseRows: PnlReport["purchases"] = [];
  for (const memory of purchases) {
    const meta = memory.metadata!;
    const total = num(meta.total);
    const cash = purchaseCashEvidence(meta, total);
    purchaseAccrual += total;
    if (cash.amount != null) purchaseCash += cash.amount;
    if (cash.status === "unknown") {
      unknownCashCount++;
      unknownCashFace += total;
    }
    purchaseRows.push({
      vendor: String(meta.vendor || memory.company || "Unknown"),
      invoice_number: String(meta.vendor_ref || meta.invoice_number || "None"),
      amount: total,
      date: String(meta.invoice_date || ""),
      paid: cash.status === "paid",
      currency,
      cash_status: cash.status,
      paid_amount: cash.amount,
    });
  }

  let revenue = 0;
  const salesRows: PnlReport["sales"] = [];
  for (const memory of sales) {
    const meta = memory.metadata!;
    const amount = num(meta.total);
    revenue += amount;
    salesRows.push({
      customer: String(meta.customer || memory.company || "Customer"),
      invoice_number: String(meta.invoice_number || meta.vendor_ref || "None"),
      amount,
      date: String(meta.invoice_date || ""),
      currency,
    });
  }

  const offBank = employerCost - payrollCash;
  const expenses = employerCost + purchaseAccrual;
  const profit = revenue - expenses;
  return {
    currency,
    events: summaries.length + invoices.length,
    employee_count: employeeCount,
    employer_cost_total: round(employerCost),
    gross_total: round(gross),
    employer_social_security_total: round(employerSs),
    employee_social_security_total: round(employeeSs),
    tax_withheld_total: round(tax),
    cash_out_total: round(payrollCash),
    off_bank_cost: round(offBank),
    cost_gap_pct: payrollCash > 0 ? round((employerSs / payrollCash) * 100) : 0,
    avg_cost_per_employee: employeeCount > 0 ? round(employerCost / employeeCount) : 0,
    purchases_total: round(purchaseAccrual),
    purchase_cash_out_total: round(purchaseCash),
    purchase_cash_unknown_total: round(unknownCashFace),
    purchase_cash_unknown_count: unknownCashCount,
    purchases: purchaseRows,
    revenue_total: round(revenue),
    sales: salesRows,
    total_expenses: round(expenses),
    net_cash_outflow: round(payrollCash + purchaseCash),
    net_profit: round(profit),
    net_profit_margin_pct: revenue > 0 ? round((profit / revenue) * 100) : 0,
    by_company: [...companyRows.values()].map((row) => ({
      ...row,
      employer_cost_total: round(row.employer_cost_total),
      cash_out_total: round(row.cash_out_total),
      off_bank_cost: round(row.off_bank_cost),
    })),
  };
}

function emptyPnlReport(): PnlReport {
  return {
    currency: null,
    currency_status: "empty",
    by_currency: [],
    events: 0,
    employee_count: 0,
    employer_cost_total: 0,
    gross_total: 0,
    employer_social_security_total: 0,
    employee_social_security_total: 0,
    tax_withheld_total: 0,
    cash_out_total: 0,
    off_bank_cost: 0,
    cost_gap_pct: 0,
    avg_cost_per_employee: 0,
    purchases_total: 0,
    purchase_cash_out_total: 0,
    purchase_cash_unknown_total: 0,
    purchase_cash_unknown_count: 0,
    purchases: [],
    revenue_total: 0,
    sales: [],
    total_expenses: 0,
    net_cash_outflow: 0,
    net_profit: 0,
    net_profit_margin_pct: 0,
    by_company: [],
    top_employees: [],
  };
}

function purchaseCashEvidence(
  meta: Record<string, unknown>,
  invoiceTotal: number,
): { status: PnlReport["purchases"][number]["cash_status"]; amount: number | null } {
  if (typeof meta.paid_amount === "number" && Number.isFinite(meta.paid_amount)) {
    const amount = meta.paid_amount;
    if (amount < 0) return { status: "refund", amount };
    if (amount === 0) return { status: "unpaid", amount: 0 };
    if (amount + 0.01 < invoiceTotal) return { status: "partial", amount };
    return { status: "paid", amount };
  }
  if (meta.paid === false) return { status: "unpaid", amount: 0 };
  const status = typeof meta.payment_status === "string"
    ? meta.payment_status.trim().toLocaleLowerCase("en-US")
    : "";
  if (meta.paid === true || ["paid", "settled", "cleared"].includes(status)) {
    return { status: "paid", amount: invoiceTotal };
  }
  if (["unknown", "partial"].includes(status)) {
    return { status: "unknown", amount: null };
  }
  if (typeof meta.payment_date === "string" && meta.payment_date.trim().length > 0) {
    return { status: "unknown", amount: null };
  }
  return { status: "unpaid", amount: 0 };
}

function payrollBusinessKey(memory: PnlSourceMemory): string {
  const metadata = memory.metadata ?? {};
  const identity = memory.sourceRef ?? metadata.record ?? `${memory.company}:${memory.period ?? ""}`;
  return JSON.stringify([
    canonical(memory.company),
    memory.period,
    currencyOf(memory),
    identity,
  ]);
}

function invoiceBusinessKey(memory: PnlSourceMemory): string {
  const metadata = memory.metadata ?? {};
  const type = metadata.type === "sales" ? "sales" : "purchase";
  const party = canonical(String(
    type === "sales" ? metadata.customer ?? "" : metadata.vendor ?? "",
  ));
  const identity =
    memory.sourceRef ??
    metadata.record ??
    metadata.vendor_ref ??
    metadata.invoice_number ??
    JSON.stringify([metadata.invoice_date, metadata.total]);
  return JSON.stringify([
    canonical(memory.company),
    memory.period,
    type,
    currencyOf(memory),
    party,
    identity,
  ]);
}

function currencyOf(memory: PnlSourceMemory): string {
  return normalizeCurrency(memory.metadata?.currency) ?? "UNSPECIFIED";
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const currency = value.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function canonical(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function dedupeLatest<T extends PnlSourceMemory>(
  memories: T[],
  keyOf: (memory: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const memory of memories) {
    const key = keyOf(memory);
    const previous = byKey.get(key);
    if (!previous || (memory.createdAt ?? "") > (previous.createdAt ?? "")) byKey.set(key, memory);
  }
  return [...byKey.values()];
}
