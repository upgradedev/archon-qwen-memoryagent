// Extractor agent — ports the Archon `jobs/extraction/extractors/*` step.
//
// Auto-detects the source kind (image → vision, text/pdf → text), calls the
// extraction client, and null-safe-parses the model's JSON into a normalized
// `ExtractedDocument`. Null-safety follows Archon ADR-003: never `Number(x)` a
// raw field — a model returning `"field": null` must not crash the pipeline;
// `safeFloat` maps null/absent/NaN to a default.

import type { ExtractionClient } from "./vision.js";
import { defaultExtractionClient } from "./vision.js";
import type {
  ExtractedDocument,
  PayslipLine,
  PipelineDocType,
  RawDocument,
} from "./models.js";

// ADR-003 null-safe numeric coercion. `dict.get(k, default)` / `x ?? default`
// only helps when the key is ABSENT; a present `null` (or a non-numeric string)
// still has to be caught, which is exactly what this does.
export function safeFloat(v: unknown, def = 0): number {
  if (v == null) return def;
  const n = typeof v === "number" ? v : parseLocalizedNumber(String(v));
  return Number.isFinite(n) ? n : def;
}

function safeStr(v: unknown, def = ""): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : def;
}

function optNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = safeFloat(v, NaN);
  return Number.isFinite(n) ? n : null;
}

const DOC_TYPES: PipelineDocType[] = [
  "payroll_register",
  "bank_confirmation",
  "payslip",
];

function parseDocType(v: unknown): PipelineDocType {
  const s = safeStr(v).toLowerCase().replace(/\s+/g, "_");
  return (DOC_TYPES as string[]).includes(s) ? (s as PipelineDocType) : "unknown";
}

// Parse one employee payslip line null-safely.
function parsePayslip(raw: unknown): PayslipLine | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const employeeId = requiredStr(e.employee_id ?? e.employee_code, "employee.employee_id");
  const name = safeStr(e.name, employeeId);
  const gross = requiredNonNegative(e.gross, "employee.gross");
  const net = requiredNonNegative(e.net, "employee.net");
  let employerSs = optNonNegative(
    e.employer_social_security,
    "employee.employer_social_security",
  );
  let employerCost = optNonNegative(e.employer_cost, "employee.employer_cost");
  if (employerSs == null && employerCost == null) {
    throw new ExtractionOutputError(
      "employee requires employer_social_security or employer_cost",
    );
  }
  if (employerSs == null) employerSs = employerCost! - gross;
  if (employerCost == null) employerCost = gross + employerSs;
  if (employerSs < 0 || Math.abs(employerCost - (gross + employerSs)) > 0.01) {
    throw new ExtractionOutputError(
      "employee employer_cost must equal gross + employer_social_security",
    );
  }
  return {
    employee_id: employeeId,
    name,
    gross,
    employee_social_security: optionalNonNegativeZero(
      e.employee_social_security,
      "employee.employee_social_security",
    ),
    tax: optionalNonNegativeZero(e.tax, "employee.tax"),
    net,
    employer_social_security: employerSs,
    employer_cost: employerCost,
  };
}

export class ExtractionOutputError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "ExtractionOutputError";
  }
}

// Strict JSON object extraction. A whole markdown JSON fence is tolerated, but
// prose, multiple objects and unknown fields are rejected rather than silently
// becoming an empty financial record.
export function parseExtractionJson(text: string): Record<string, unknown> {
  const raw = (text ?? "").trim();
  if (raw.length === 0 || raw.length > 64_000) {
    throw new ExtractionOutputError("extractor output is empty or too large");
  }
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  const trimmed = (fence ? fence[1]! : raw).trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ExtractionOutputError("extractor output must be one JSON object");
    }
    const data = parsed as Record<string, unknown>;
    validateKeys(data, ROOT_FIELDS, "document");
    if (data.employee != null && data.payslip != null) {
      throw new ExtractionOutputError("document cannot contain both employee and payslip");
    }
    const employee = data.employee ?? data.payslip;
    if (employee != null) {
      if (typeof employee !== "object" || Array.isArray(employee)) {
        throw new ExtractionOutputError("employee must be an object or null");
      }
      validateKeys(employee as Record<string, unknown>, EMPLOYEE_FIELDS, "employee");
    }
    return data;
  } catch (error) {
    if (error instanceof ExtractionOutputError) throw error;
    throw new ExtractionOutputError("extractor output is not valid strict JSON");
  }
}

export class Extractor {
  constructor(private client: ExtractionClient = defaultExtractionClient()) {}

  get modelId(): string {
    return `${this.client.visionModel}|${this.client.textModel}`;
  }

  async extract(doc: RawDocument): Promise<ExtractedDocument> {
    const raw = await this.client.extract(doc);
    const data = parseExtractionJson(raw);

    // doc-level company/period: the caller's declaration wins, else the model's.
    const company = validatedCompany(safeStr(doc.company) || safeStr(data.company));
    const period = validatedPeriod(safeStr(doc.period) || safeStr(data.period));
    const event_ref = validatedEventRef(
      safeStr(doc.event_ref) ||
      safeStr(data.event_ref) ||
      safeStr(data.payroll_run_id) ||
      "monthly-consolidated",
    );
    const doc_type = doc.declared_type ?? parseDocType(data.doc_type);
    const payslip = parsePayslip(data.employee ?? data.payslip);
    if (doc_type === "payslip" && !payslip) {
      throw new ExtractionOutputError("payslip document requires an employee object");
    }

    const gross_pay_total = optNonNegative(data.gross_pay_total, "gross_pay_total");
    let employer_cost_total = optNonNegative(data.employer_cost_total, "employer_cost_total");
    const employer_ss_total = optNonNegative(
      data.employer_social_security_total,
      "employer_social_security_total",
    );
    // Derive true employer cost when only gross + employer SS are present.
    if (employer_cost_total == null && gross_pay_total != null && employer_ss_total != null) {
      employer_cost_total = gross_pay_total + employer_ss_total;
    }
    const netPayTotal = optNonNegative(data.net_pay_total, "net_pay_total");
    if (doc_type === "payroll_register" && gross_pay_total == null && employer_cost_total == null) {
      throw new ExtractionOutputError(
        "payroll_register requires gross_pay_total or employer_cost_total",
      );
    }
    if (doc_type === "bank_confirmation" && netPayTotal == null) {
      throw new ExtractionOutputError("bank_confirmation requires net_pay_total");
    }

    return {
      doc_id: doc.doc_id,
      doc_type,
      company,
      period,
      event_ref,
      gross_pay_total,
      employer_cost_total,
      employer_social_security_total: employer_ss_total,
      net_pay_total: netPayTotal,
      employee_count: optInteger(data.employee_count, "employee_count"),
      payment_date: validatedDate(data.payment_date),
      payslip,
      model_id: doc.source_kind === "image" ? this.client.visionModel : this.client.textModel,
    };
  }

  async extractAll(docs: RawDocument[]): Promise<ExtractedDocument[]> {
    return Promise.all(docs.map((d) => this.extract(d)));
  }
}

const ROOT_FIELDS = new Set([
  "doc_type",
  "company",
  "period",
  "event_ref",
  "payroll_run_id",
  "gross_pay_total",
  "employer_cost_total",
  "employer_social_security_total",
  "net_pay_total",
  "employee_count",
  "payment_date",
  "employee",
  "payslip",
]);
const EMPLOYEE_FIELDS = new Set([
  "employee_id",
  "employee_code",
  "name",
  "gross",
  "employee_social_security",
  "tax",
  "net",
  "employer_social_security",
  "employer_cost",
]);

function validateKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new ExtractionOutputError(`${label} contains unknown field '${unknown}'`);
}

function parseLocalizedNumber(value: string): number {
  let s = value.trim().replace(/\u2212/g, "-");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s
    .replace(/^[A-Z]{3}\s*/i, "")
    .replace(/\s*[A-Z]{3}$/i, "")
    .replace(/[€$£¥]/g, "")
    .replace(/[\s'’]/g, "");
  if (!/^[+-]?(?:\d+(?:[.,]\d+)*|[.,]\d+)$/.test(s)) return NaN;
  const sign = s.startsWith("-") ? -1 : 1;
  s = s.replace(/^[+-]/, "");
  const dot = s.lastIndexOf(".");
  const comma = s.lastIndexOf(",");
  const lastSeparator = Math.max(dot, comma);
  if (lastSeparator >= 0) {
    const separator = s[lastSeparator]!;
    const decimals = s.length - lastSeparator - 1;
    const occurrences = s.split(separator).length - 1;
    const otherSeparator = separator === "." ? "," : ".";
    const hasOther = s.includes(otherSeparator);
    const integerDigits = s.slice(0, lastSeparator).replace(/[.,]/g, "");
    const treatAsDecimal =
      hasOther ||
      decimals !== 3 ||
      (occurrences > 1 && decimals <= 2) ||
      integerDigits === "" ||
      integerDigits === "0";
    if (treatAsDecimal) {
      const integerPart = s.slice(0, lastSeparator).replace(/[.,]/g, "") || "0";
      const fraction = s.slice(lastSeparator + 1);
      s = `${integerPart}.${fraction}`;
    } else {
      s = s.replace(/[.,]/g, "");
    }
  }
  const parsed = Number(s);
  return (negative ? -1 : 1) * sign * parsed;
}

function optNonNegative(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  const parsed = optNum(value);
  if (parsed == null) throw new ExtractionOutputError(`${field} must be numeric`);
  if (parsed < 0) throw new ExtractionOutputError(`${field} must be non-negative`);
  return parsed;
}

function requiredNonNegative(value: unknown, field: string): number {
  const parsed = optNonNegative(value, field);
  if (parsed == null) throw new ExtractionOutputError(`${field} is required`);
  return parsed;
}

function optionalNonNegativeZero(value: unknown, field: string): number {
  return optNonNegative(value, field) ?? 0;
}

function optInteger(value: unknown, field: string): number | null {
  const parsed = optNonNegative(value, field);
  if (parsed == null) return null;
  if (!Number.isInteger(parsed)) throw new ExtractionOutputError(`${field} must be an integer`);
  return parsed;
}

function validatedPeriod(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) {
    throw new ExtractionOutputError("period must be YYYY-MM with month 01..12");
  }
  return value;
}

function validatedCompany(value: string): string {
  const company = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!company || /^(?:unknown|n\/?a|null)$/i.test(company)) {
    throw new ExtractionOutputError("company is required");
  }
  return company;
}

function validatedEventRef(value: string): string {
  const ref = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!ref || ref.length > 128 || /[\u0000-\u001f\u007f]/.test(ref)) {
    throw new ExtractionOutputError("event_ref must be 1-128 printable characters");
  }
  return ref;
}

function requiredStr(value: unknown, field: string): string {
  const text = safeStr(value);
  if (!text || /^(?:unknown|n\/?a|null)$/i.test(text)) {
    throw new ExtractionOutputError(`${field} is required`);
  }
  return text;
}

function validatedDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const text = safeStr(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new ExtractionOutputError("payment_date must be YYYY-MM-DD");
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new ExtractionOutputError("payment_date is not a real calendar date");
  }
  return text;
}
