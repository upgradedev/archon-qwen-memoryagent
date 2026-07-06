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
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : def;
}

function safeStr(v: unknown, def = ""): string {
  return typeof v === "string" && v.length > 0 ? v : def;
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
  const gross = safeFloat(e.gross);
  const employer_ss = safeFloat(e.employer_social_security);
  return {
    employee_id: safeStr(e.employee_id ?? e.employee_code, "unknown"),
    name: safeStr(e.name, "unknown"),
    gross,
    employee_social_security: safeFloat(e.employee_social_security),
    tax: safeFloat(e.tax),
    net: safeFloat(e.net),
    employer_social_security: employer_ss,
    // Derive employer_cost when the document omits it (gross + employer SS).
    employer_cost: e.employer_cost != null ? safeFloat(e.employer_cost) : gross + employer_ss,
  };
}

// Tolerant JSON extraction: models sometimes wrap JSON in prose or ```json fences.
function parseJsonLoose(text: string): Record<string, unknown> {
  const trimmed = (text ?? "").trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

export class Extractor {
  constructor(private client: ExtractionClient = defaultExtractionClient()) {}

  get modelId(): string {
    return `${this.client.visionModel}|${this.client.textModel}`;
  }

  async extract(doc: RawDocument): Promise<ExtractedDocument> {
    const raw = await this.client.extract(doc);
    const data = parseJsonLoose(raw);

    // doc-level company/period: the caller's declaration wins, else the model's.
    const company = safeStr(doc.company) || safeStr(data.company, "unknown");
    const period = safeStr(doc.period) || safeStr(data.period, "unknown");
    const doc_type = doc.declared_type ?? parseDocType(data.doc_type);

    const gross_pay_total = optNum(data.gross_pay_total);
    let employer_cost_total = optNum(data.employer_cost_total);
    const employer_ss_total = optNum(data.employer_social_security_total);
    // Derive true employer cost when only gross + employer SS are present.
    if (employer_cost_total == null && gross_pay_total != null && employer_ss_total != null) {
      employer_cost_total = gross_pay_total + employer_ss_total;
    }

    return {
      doc_id: doc.doc_id,
      doc_type,
      company,
      period,
      gross_pay_total,
      employer_cost_total,
      employer_social_security_total: employer_ss_total,
      net_pay_total: optNum(data.net_pay_total),
      employee_count: optNum(data.employee_count),
      payment_date: data.payment_date != null ? safeStr(data.payment_date) || null : null,
      payslip: parsePayslip(data.employee ?? data.payslip),
      model_id: doc.source_kind === "image" ? this.client.visionModel : this.client.textModel,
    };
  }

  async extractAll(docs: RawDocument[]): Promise<ExtractedDocument[]> {
    return Promise.all(docs.map((d) => this.extract(d)));
  }
}
