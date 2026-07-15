// Extractor agent — ports the Archon `jobs/extraction/extractors/*` step.
//
// Routes the declared source kind (image → vision, text/PDF-extracted text → text), calls the
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
import { normalizeIso4217Currency } from "./currency.js";
import { canonicalBusinessLabel, canonicalIdentifier } from "./identity.js";

export const DEFAULT_EXTRACTION_CONCURRENCY = 3;
export const MAX_EXTRACTION_CONCURRENCY = 4;

export function configuredExtractionConcurrency(
  raw: string | number | undefined = process.env.EXTRACTION_CONCURRENCY,
): number {
  const value = Number(raw ?? DEFAULT_EXTRACTION_CONCURRENCY);
  if (!Number.isFinite(value)) return DEFAULT_EXTRACTION_CONCURRENCY;
  return Math.max(1, Math.min(Math.trunc(value), MAX_EXTRACTION_CONCURRENCY));
}

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
  const employeeId = reconcileRequiredAlias(
    e.employee_id,
    e.employee_code,
    "employee.employee_id",
    canonicalIdentifier,
  );
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
  constructor(
    private client: ExtractionClient = defaultExtractionClient(),
    private readonly concurrency = configuredExtractionConcurrency(),
  ) {}

  get modelId(): string {
    return `${this.client.visionModel}|${this.client.textModel}`;
  }

  async extract(doc: RawDocument): Promise<ExtractedDocument> {
    const raw = await this.client.extract(doc);
    const data = parseExtractionJson(raw);

    // Caller declarations constrain model output; they never silently override
    // contradictory extracted identities that could fuse the wrong payroll run.
    const company = reconcileRequired(
      optionalValidated(doc.company, validatedCompany),
      optionalValidated(data.company, (value) => validatedCompany(String(value))),
      "company",
      canonicalBusinessLabel,
    );
    const period = reconcileRequired(
      optionalValidated(doc.period, validatedPeriod),
      optionalValidated(data.period, (value) => validatedPeriod(String(value))),
      "period",
      (value) => value,
    );
    const declaredCurrency = validatedCurrency(doc.currency);
    const extractedCurrency = validatedCurrency(data.currency);
    if (declaredCurrency && extractedCurrency && declaredCurrency !== extractedCurrency) {
      throw new ExtractionOutputError(
        `document currency conflicts with extracted currency (${declaredCurrency} vs ${extractedCurrency})`,
      );
    }
    const currency = declaredCurrency ?? extractedCurrency;
    const extractedEventRef = reconcileOptional(
      optionalValidated(data.event_ref, (value) => validatedEventRef(String(value))),
      optionalValidated(data.payroll_run_id, (value) => validatedEventRef(String(value))),
      "event_ref and payroll_run_id",
      canonicalIdentifier,
    );
    const event_ref = reconcileOptional(
      optionalValidated(doc.event_ref, validatedEventRef),
      extractedEventRef,
      "declared and extracted event_ref",
      canonicalIdentifier,
    ) ?? "monthly-consolidated";
    const extractedDocType = parseDocType(data.doc_type);
    const declaredDocType = doc.declared_type;
    if (
      declaredDocType && declaredDocType !== "unknown" &&
      extractedDocType !== "unknown" && declaredDocType !== extractedDocType
    ) {
      throw new ExtractionOutputError(
        `declared document type conflicts with extracted document type (${declaredDocType} vs ${extractedDocType})`,
      );
    }
    const doc_type = declaredDocType && declaredDocType !== "unknown"
      ? declaredDocType
      : extractedDocType;
    const payslip = parsePayslip(data.employee ?? data.payslip);
    if (doc_type === "payslip" && !payslip) {
      throw new ExtractionOutputError("payslip document requires an employee object");
    }

    let gross_pay_total = optNonNegative(data.gross_pay_total, "gross_pay_total");
    let employer_cost_total = optNonNegative(data.employer_cost_total, "employer_cost_total");
    let employer_ss_total = optNonNegative(
      data.employer_social_security_total,
      "employer_social_security_total",
    );
    const netPayTotal = optNonNegative(data.net_pay_total, "net_pay_total");
    if (doc_type === "payroll_register") {
      const supplied = [gross_pay_total, employer_cost_total, employer_ss_total]
        .filter((value) => value != null).length;
      if (supplied < 2) {
        throw new ExtractionOutputError(
          "payroll_register requires any two of gross_pay_total, employer_cost_total, and employer_social_security_total",
        );
      }
      if (
        gross_pay_total != null && employer_cost_total != null && employer_ss_total != null &&
        Math.abs(employer_cost_total - (gross_pay_total + employer_ss_total)) > 0.01
      ) {
        throw new ExtractionOutputError(
          "payroll_register employer_cost_total must equal gross_pay_total + employer_social_security_total",
        );
      }
      if (gross_pay_total == null) gross_pay_total = employer_cost_total! - employer_ss_total!;
      if (employer_ss_total == null) employer_ss_total = employer_cost_total! - gross_pay_total;
      if (employer_cost_total == null) employer_cost_total = gross_pay_total + employer_ss_total;
      if (gross_pay_total < 0 || employer_ss_total < 0) {
        throw new ExtractionOutputError("payroll_register derived totals must be non-negative");
      }
    }
    if (doc_type === "bank_confirmation" && netPayTotal == null) {
      throw new ExtractionOutputError("bank_confirmation requires net_pay_total");
    }

    return {
      doc_id: doc.doc_id,
      doc_type,
      company,
      period,
      currency,
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
    const output = new Array<ExtractedDocument>(docs.length);
    const workerCount = Math.min(this.concurrency, docs.length);
    let next = 0;
    let firstError: unknown;
    const workers = Array.from({ length: workerCount }, async () => {
      while (firstError === undefined) {
        const index = next++;
        if (index >= docs.length) return;
        try {
          output[index] = await this.extract(docs[index]!);
        } catch (error) {
          firstError = error;
        }
      }
    });
    // Let every already-started request settle before returning. No new work is
    // dequeued after a failure, so slots and provider work cannot leak beyond a
    // rejected batch.
    await Promise.all(workers);
    if (firstError !== undefined) throw firstError;
    return output;
  }
}

const ROOT_FIELDS = new Set([
  "doc_type",
  "company",
  "period",
  "currency",
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
    .trim()
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/’/g, "'");
  if (!/^[+-]?[\d., '\t]+$/.test(s)) return NaN;
  const sign = s.startsWith("-") ? -1 : 1;
  s = s.replace(/^[+-]/, "");
  s = normalizeGroupedSpaces(s);
  if (!s) return NaN;
  const parsed = parseDotCommaNumber(s);
  return (negative ? -1 : 1) * sign * parsed;
}

function normalizeGroupedSpaces(value: string): string {
  if (!/[ '\t]/.test(value)) return value;
  const normalized = value.replace(/\t/g, " ");
  const usesSpace = normalized.includes(" ");
  const usesApostrophe = normalized.includes("'");
  if (usesSpace && usesApostrophe) return "";
  const separator = usesSpace ? " " : "'";
  const escaped = separator === " " ? " " : "'";
  const match = new RegExp(`^(\\d{1,3}(?:${escaped}\\d{3})+)([.,]\\d+)?$`).exec(normalized);
  if (!match) return "";
  return match[1]!.split(separator).join("") + (match[2] ?? "");
}

function parseDotCommaNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const dotCount = (value.match(/\./g) ?? []).length;
  const commaCount = (value.match(/,/g) ?? []).length;
  if (dotCount > 0 && commaCount > 0) {
    const decimal = value.lastIndexOf(".") > value.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    const split = value.split(decimal);
    if (split.length !== 2 || !/^\d{1,6}$/.test(split[1]!)) return NaN;
    const escaped = grouping === "." ? "\\." : ",";
    if (!new RegExp(`^\\d{1,3}(?:${escaped}\\d{3})+$`).test(split[0]!)) return NaN;
    return Number(`${split[0]!.split(grouping).join("")}.${split[1]}`);
  }
  const separator = dotCount > 0 ? "." : commaCount > 0 ? "," : "";
  if (!separator) return NaN;
  const parts = value.split(separator);
  if (parts.length > 2) {
    if (!/^\d{1,3}$/.test(parts[0]!) || parts.slice(1).some((part) => !/^\d{3}$/.test(part))) {
      return NaN;
    }
    return Number(parts.join(""));
  }
  const [integer, fraction] = parts;
  if (!/^\d*$/.test(integer!) || !/^\d{1,6}$/.test(fraction!)) return NaN;
  // A lone 1,234 / 1.234 is locale-ambiguous. Only a leading zero (or no
  // integer digits) makes three fractional digits unambiguously decimal.
  if (fraction!.length === 3 && integer !== "0" && integer !== "") return NaN;
  return Number(`${integer || "0"}.${fraction}`);
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

function validatedCurrency(value: unknown): string | null {
  if (value == null || value === "") return null;
  const currency = normalizeIso4217Currency(value);
  if (!currency) throw new ExtractionOutputError("currency must be a supported ISO 4217 code");
  return currency;
}

function optionalValidated<T>(
  value: unknown,
  validate: (value: never) => T,
): T | null {
  if (value == null || value === "") return null;
  return validate(value as never);
}

function reconcileRequired(
  declared: string | null,
  extracted: string | null,
  label: string,
  canonicalize: (value: string) => string,
): string {
  const value = reconcileOptional(declared, extracted, label, canonicalize);
  if (value == null) throw new ExtractionOutputError(`${label} is required`);
  return value;
}

function reconcileOptional(
  first: string | null,
  second: string | null,
  label: string,
  canonicalize: (value: string) => string,
): string | null {
  if (first && second && canonicalize(first) !== canonicalize(second)) {
    throw new ExtractionOutputError(`${label} conflict (${first} vs ${second})`);
  }
  return first ?? second;
}

function reconcileRequiredAlias(
  first: unknown,
  second: unknown,
  label: string,
  canonicalize: (value: string) => string,
): string {
  const firstValue = first == null || first === "" ? null : requiredStr(first, label);
  const secondValue = second == null || second === "" ? null : requiredStr(second, label);
  const value = reconcileOptional(firstValue, secondValue, `${label} aliases`, canonicalize);
  if (!value) throw new ExtractionOutputError(`${label} is required`);
  return value;
}
