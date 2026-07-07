// ClassifierAgent — ports the Archon `jobs/extraction/agents/classifier.py`.
//
// Rule-based, NO LLM. Refines / repairs each ExtractedDocument's doc_type from
// the SHAPE of the fields the extractor read, so a mislabeled or "unknown" scan
// still lands in the right payroll subtype:
//   payslip           — carries a single-employee payslip line
//   bank_confirmation — has a net cash transfer but no gross/employer cost
//   payroll_register  — has gross pay / employer cost totals
// Deterministic and free — the classification is evidence, not a model call.

import type { ExtractedDocument, PipelineDocType } from "./models.js";

export function classifyDocType(doc: ExtractedDocument): PipelineDocType {
  // A payslip is the only subtype that carries a per-employee line.
  if (doc.payslip) return "payslip";

  const hasGross = doc.gross_pay_total != null || doc.employer_cost_total != null;
  const hasNet = doc.net_pay_total != null;

  // Register: the document that states the full employer payroll cost.
  if (hasGross) return "payroll_register";
  // Bank confirmation: net cash out, no gross/employer figures.
  if (hasNet) return "bank_confirmation";

  // Nothing decisive — keep whatever the extractor believed (may be "unknown").
  return doc.doc_type;
}

export class ClassifierAgent {
  // Return a new document with a refined doc_type (never mutates the input).
  classify(doc: ExtractedDocument): ExtractedDocument {
    return { ...doc, doc_type: classifyDocType(doc) };
  }

  classifyAll(docs: ExtractedDocument[]): ExtractedDocument[] {
    return docs.map((d) => this.classify(d));
  }
}
