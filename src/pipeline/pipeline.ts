// Ingestion pipeline orchestrator — the SUPPORTING CAST that produces the
// memories the MemoryAgent (the headline) recalls and self-audits.
//
// End to end, ported straight from the Archon 4-agent extraction sequence plus
// the analysis P&L math:
//
//   raw docs ──▶ Extractor (qwen-vl-max / qwen-plus)   normalize each document
//            ──▶ ClassifierAgent   rule-based doc_type refinement (no LLM)
//            ──▶ EventLinkerAgent   fuse the payroll triplet → PayrollEvent
//            ──▶ ValidatorAgent     R1–R4 cross-document consistency
//            ──▶ PnL math           employer cost / cash-out / per-employee
//            ──▶ MemoryAgent.ingestEvent()   WRITE the fused event to pgvector
//
// `runPipeline` is pure (no DB, no key) so the whole flow is unit-testable with
// the Fake extractor. `ingestPipeline` adds the single side effect: it writes
// the fused events + validation findings into the EXISTING memory via the
// unchanged `MemoryAgent` — the agent core is not modified, only fed.

import type { MemoryAgent } from "../agents/memory-agent.js";
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
    // The bank confirmation's value date (R3) is not stored on the fused event —
    // recover it from the linked extracted documents.
    const paymentDate =
      extracted.find(
        (d) => event.linked_docs.includes(d.doc_id) && d.doc_type === "bank_confirmation",
      )?.payment_date ?? null;
    return {
      event,
      pnl: pnlForEvent(event),
      validation: validator.validate(event, paymentDate),
    };
  });

  return { documents: extracted, events: results };
}

export interface IngestResult extends PipelineResult {
  memoryIds: string[];
}

// The one side effect: run the pipeline, then WRITE the fused events + their
// validation findings into memory through the unchanged MemoryAgent. Returns the
// ids of every memory written, so the caller can prove the memory was fed.
export async function ingestPipeline(
  agent: MemoryAgent,
  docs: RawDocument[],
  deps: PipelineDeps = {},
): Promise<IngestResult> {
  const result = await runPipeline(docs, deps);
  const memoryIds: string[] = [];

  for (const { event, validation } of result.events) {
    // 1. The fused event → event summary + insight + per-employee lines.
    memoryIds.push(...(await agent.ingestEvent(event)));

    // 2. The validation findings → recallable `validation` memories, so the
    //    agent can later recall / self-audit which cross-document checks ran.
    for (const v of validation) {
      const id = await agent.remember(
        "validation",
        `Validation ${v.passed ? "PASSED" : "FAILED"} for ${event.company} ${event.period} — ${v.rule}: ${v.message}`,
        {
          company: event.company,
          period: event.period,
          sourceRef: `${event.event_id}:${v.rule.split(":")[0]}`,
          metadata: { rule: v.rule, passed: v.passed, severity: v.severity },
        },
      );
      memoryIds.push(id);
    }
  }

  return { ...result, memoryIds };
}
