// Ingestion pipeline orchestrator — the SUPPORTING CAST that produces the
// memories the MemoryAgent (the headline) recalls and self-audits.
//
// End to end, ported straight from the Archon 4-agent extraction sequence plus
// the analysis P&L math:
//
//   raw docs ──▶ Extractor (qwen-vl-max / qwen-plus)   normalize each document
//            ──▶ ClassifierAgent   rule-based doc_type refinement (no LLM)
//            ──▶ EventLinkerAgent   fuse the payroll triplet → PayrollEvent
//            ──▶ ValidatorAgent     R1–R6 cross-document consistency
//            ──▶ PnL math           employer cost / cash-out / per-employee
//            ──▶ MemoryAgent.ingestPipelineBatch()   atomically WRITE event + findings
//
// `runPipeline` is pure (no DB, no key) so the whole flow is unit-testable with
// the Fake extractor. `ingestPipeline` adds the single side effect: it writes
// the fused events + validation findings into the EXISTING memory via the
// `MemoryAgent` through its transactional batch-ingestion seam.

import type { MemoryAgent } from "../agents/memory-agent.js";
import type { MemoryInput } from "../memory/store.js";
import type { PayrollEvent } from "../types.js";
import type { ExtractedDocument, RawDocument } from "./models.js";
import { Extractor } from "./extractor.js";
import { ClassifierAgent } from "./classifier.js";
import { EventLinkerAgent } from "./event-linker.js";
import { ValidatorAgent, type ValidationResult } from "./validator.js";
import { pnlForEvent } from "./pnl.js";
import type { PnlReport } from "./pnl.js";

export interface EventResult {
  event: PayrollEvent;
  pnl: PnlReport;
  validation: ValidationResult[];
}

export interface PipelineResult {
  documents: ExtractedDocument[];
  events: EventResult[];
}

export interface PipelineDeps {
  extractor?: Extractor;
}

// Pure: raw documents → extracted → classified → fused events → validated + P&L.
// No DB, no key. The Fake extractor makes this fully offline in CI.
export async function runPipeline(
  docs: RawDocument[],
  deps: PipelineDeps = {},
): Promise<PipelineResult> {
  const extractor = deps.extractor ?? new Extractor();
  const classifier = new ClassifierAgent();
  const linker = new EventLinkerAgent();
  const validator = new ValidatorAgent();

  const extracted = classifier.classifyAll(await extractor.extractAll(docs));
  const events = linker.link(extracted);

  const results: EventResult[] = events.map((event) => {
    const linked = extracted.filter((d) => event.linked_docs.includes(d.doc_id));
    // The bank confirmation's value date (R3) is not stored on the fused event —
    // recover it from the linked extracted documents.
    const paymentDate =
      linked.find((d) => d.doc_type === "bank_confirmation")?.payment_date ?? null;
    const hasDeclaredEmployeeCount = linked.some(
      (d) =>
        (d.doc_type === "payroll_register" || d.doc_type === "bank_confirmation") &&
        d.employee_count != null,
    );
    const hasPayslips = linked.some((d) => d.doc_type === "payslip" && d.payslip != null);
    const evidence = {
      hasBankConfirmation: linked.some((d) => d.doc_type === "bank_confirmation"),
      hasPayrollRegister: linked.some((d) => d.doc_type === "payroll_register"),
      hasPayslips,
      hasDeclaredEmployeeCount,
      hasCompletePayslips:
        hasPayslips && hasDeclaredEmployeeCount && event.employee_count === event.employees.length,
    };
    return {
      event,
      pnl: pnlForEvent(event),
      validation: validator.validate(event, paymentDate, evidence),
    };
  });

  return { documents: extracted, events: results };
}

export interface IngestResult extends PipelineResult {
  memoryIds: string[];
}

// The one side effect: run the pipeline, then atomically WRITE each fused event
// together with every derived validation finding. Embedding or persistence
// failure leaves that event entirely uncommitted; stable idempotency keys make a
// retry safe instead of duplicating either event facts or validation facts.
export async function ingestPipeline(
  agent: MemoryAgent,
  docs: RawDocument[],
  deps: PipelineDeps = {},
): Promise<IngestResult> {
  const result = await runPipeline(docs, deps);
  const memoryIds: string[] = [];

  for (const { event, validation } of result.events) {
    const validationMemories: Array<Omit<MemoryInput, "tenantId">> = validation.map((v) => {
      const ruleCode = v.rule.split(":", 1)[0]!.trim();
      return {
        kind: "validation",
        company: event.company,
        period: event.period,
        sourceRef: `${event.event_id}:${ruleCode}`,
        idempotencyKey: `event:${event.event_id}:validation:${ruleCode}`,
        content:
          `Validation ${v.status.toUpperCase()} for ${event.company} ${event.period} — ` +
          `${v.rule}: ${v.message}`,
        metadata: {
          rule: v.rule,
          status: v.status,
          passed: v.passed,
          severity: v.severity,
        },
      };
    });
    memoryIds.push(...(await agent.ingestPipelineBatch(event, validationMemories)));
  }

  return { ...result, memoryIds };
}
