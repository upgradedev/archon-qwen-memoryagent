// Document-ingestion pipeline models — the UPSTREAM that feeds the MemoryAgent.
//
// The MemoryAgent (the headline) recalls and self-audits over memories. Those
// memories have to come from somewhere real: this pipeline ingests a period's
// raw financial documents, extracts them with Qwen (vision or text), fuses them
// into one accurate financial event, computes the P&L, and writes the result
// through the SAME `agent.ingestEvent()` path the memory core already exposes.
//
// The design is ported from the Archon extraction + analysis pipelines
// (Extractor → Classifier → EventLinker → Validator, then PnL / CashFlow /
// Employee agents). Here it is a lean, offline-testable TypeScript port whose
// only job is to PRODUCE the memories — the agent stays the star.
//
// Universal financial terms only. "Social security" == employer/employee
// statutory payroll contributions, jurisdiction-agnostic.

// A document type the pipeline recognizes. The three payroll subtypes each tell
// a different part of the truth about one payroll event:
//   payroll_register  — the full employer payroll cost (gross + employer social security)
//   bank_confirmation — the net salary cash that actually left the bank account
//   payslip           — the per-employee payroll breakdown
export type PipelineDocType =
  | "payroll_register"
  | "bank_confirmation"
  | "payslip"
  | "unknown";

// How the raw bytes reach the extractor. `image` → the vision model (qwen-vl-max);
// `pdf` / `text` → the text model (qwen-plus). Mirrors the Archon extractor's
// auto-detect-then-route step.
export type SourceKind = "image" | "pdf" | "text";

// One raw document handed to the pipeline. For a real vision extraction, `content`
// is a data-URL / base64 image; for text/pdf it is the extracted text. Offline
// (Fake extractor), `content` is the JSON the model WOULD have returned — the same
// convention the FakeNarrator/FakeEmbedder use to run the whole path without a key.
export interface RawDocument {
  doc_id: string;
  filename: string;
  source_kind: SourceKind;
  content: string;
  company?: string;
  period?: string; // YYYY-MM
  // A caller may pre-declare the type; otherwise the ClassifierAgent infers it.
  declared_type?: PipelineDocType;
}

// A single employee's payroll line, extracted from a payslip.
export interface PayslipLine {
  employee_id: string;
  name: string;
  gross: number;
  employee_social_security: number;
  tax: number;
  net: number;
  employer_social_security: number;
  employer_cost: number; // gross + employer_social_security
}

// The normalized financial record the Extractor produces per document. Optional
// fields follow the null-safe pattern: every numeric field defaults through a
// `safeFloat`, so a model returning `"field": null` never crashes the pipeline.
export interface ExtractedDocument {
  doc_id: string;
  doc_type: PipelineDocType;
  company: string;
  period: string; // YYYY-MM
  // payroll_register / bank_confirmation totals
  gross_pay_total?: number | null; // register
  employer_cost_total?: number | null; // register (true cost)
  employer_social_security_total?: number | null; // register (may be derived)
  net_pay_total?: number | null; // bank_confirmation (net cash transferred)
  employee_count?: number | null;
  payment_date?: string | null; // bank_confirmation value date (YYYY-MM-DD)
  // payslip (one employee per payslip document)
  payslip?: PayslipLine | null;
  model_id: string; // which extractor produced this ("qwen-vl-max" / fake tag)
}
