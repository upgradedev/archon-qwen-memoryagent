const shortText = { type: "string", minLength: 1, maxLength: 256 } as const;
const money = { type: "number", minimum: 0, maximum: 1_000_000_000_000 } as const;
const period = { type: "string", pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$" } as const;
const kind = {
  type: "string",
  enum: ["document", "payroll_event", "validation", "insight", "invoice", "action"],
} as const;

const employee = {
  type: "object",
  additionalProperties: false,
  required: [
    "employee_id", "name", "gross", "employee_social_security", "tax", "net",
    "employer_social_security", "employer_cost",
  ],
  properties: {
    employee_id: shortText,
    name: shortText,
    gross: money,
    employee_social_security: money,
    tax: money,
    net: money,
    employer_social_security: money,
    employer_cost: money,
  },
} as const;

export const payrollEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "event_id", "company", "period", "employee_count", "bank_net_total", "gross_total",
    "employer_social_security_total", "employee_social_security_total", "tax_withheld_total",
    "employer_cost_total", "cost_gap_amount", "cost_gap_pct", "off_bank_cost", "employees", "linked_docs",
  ],
  properties: {
    event_id: shortText,
    event_ref: shortText,
    company: shortText,
    period,
    employee_count: { type: "integer", minimum: 0, maximum: 100_000 },
    bank_net_total: money,
    gross_total: money,
    employer_social_security_total: money,
    employee_social_security_total: money,
    tax_withheld_total: money,
    employer_cost_total: money,
    cost_gap_amount: money,
    cost_gap_pct: { type: "number", minimum: 0, maximum: 10_000 },
    off_bank_cost: money,
    employees: { type: "array", maxItems: 2_000, items: employee },
    linked_docs: { type: "array", maxItems: 2_000, items: shortText },
  },
} as const;

export const rawDocumentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["doc_id", "filename", "source_kind", "content"],
  properties: {
    doc_id: shortText,
    event_ref: shortText,
    filename: { type: "string", maxLength: 512 },
    source_kind: { type: "string", enum: ["image", "pdf", "text"] },
    content: { type: "string", minLength: 1, maxLength: 8_000_000 },
    company: shortText,
    period,
    declared_type: {
      type: "string",
      enum: ["payroll_register", "bank_confirmation", "payslip", "unknown"],
    },
  },
} as const;

const isoDate = {
  type: "string",
  pattern: "^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$",
} as const;

export const invoiceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "company", "period", "date", "currency", "total", "invoice_ref"],
  properties: {
    type: { type: "string", enum: ["purchase", "sales"] },
    company: shortText,
    period,
    date: isoDate,
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    total: money,
    invoice_ref: shortText,
    vendor: shortText,
    customer: shortText,
    paid_amount: money,
    status: { type: "string", enum: ["paid", "partial", "unpaid", "unknown"] },
    payment_date: isoDate,
  },
} as const;

export const companySchema = { type: "string", minLength: 1, maxLength: 256 } as const;
export const periodSchema = period;
export const kindSchema = kind;
export const questionSchema = { type: "string", minLength: 1, maxLength: 4_000 } as const;
