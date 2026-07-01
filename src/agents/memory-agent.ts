// MemoryAgent — the minimal agentic loop over persistent memory.
//
// This is the read/write-memory path the rest of the Archon pipeline plugs into:
//
//   ingestEvent()   WRITE  — an agent has fused a financial event; it commits the
//                            salient facts to memory (event, per-employee lines,
//                            the headline insight) so FUTURE SESSIONS can recall them.
//   recallAnswer()  READ   — a user (or another agent) asks a question; the agent
//                            recalls the most relevant memories by meaning and
//                            grounds its answer in them (RAG over agent memory).
//
// It is deliberately thin and injectable — Embedder, MemoryStore, and Narrator
// are all passed in — so it runs offline with FakeEmbedder + InMemoryStore +
// FakeNarrator in unit tests, and against real Qwen + a pgvector database
// (local, CI, or Alibaba Cloud) in production, unchanged.

import type { Embedder } from "../memory/embeddings.js";
import { remember, recall } from "../memory/memory.js";
import type { MemoryKind, MemoryStore, RecallHit } from "../memory/store.js";
import { defaultNarrator, type Narrator, type Citation } from "./narrator.js";
import type { PayrollEvent } from "../types.js";

export class MemoryAgent {
  private narrator: Narrator;
  constructor(
    private embedder: Embedder,
    private store: MemoryStore,
    narrator: Narrator = defaultNarrator()
  ) {
    this.narrator = narrator;
  }

  // ── WRITE ────────────────────────────────────────────────────────────────
  // Commit a fused PayrollEvent to memory as several recallable facts. Returns
  // the ids of the memories written.
  async ingestEvent(event: PayrollEvent): Promise<string[]> {
    const ids: string[] = [];
    const base = { company: event.company, period: event.period } as const;

    // 1. The event summary.
    ids.push(
      await remember(this.embedder, this.store, {
        ...base,
        kind: "payroll_event",
        sourceRef: event.event_id,
        content:
          `Payroll for ${event.company} in ${event.period}: ` +
          `${event.employee_count} employees, gross ${money(event.gross_total)}, ` +
          `true employer cost ${money(event.employer_cost_total)}, ` +
          `net paid from bank ${money(event.bank_net_total)}.`,
        metadata: {
          employee_count: event.employee_count,
          gross_total: event.gross_total,
          employer_cost_total: event.employer_cost_total,
          bank_net_total: event.bank_net_total,
        },
      })
    );

    // 2. The headline insight — the hidden employer-cost gap.
    ids.push(
      await remember(this.embedder, this.store, {
        ...base,
        kind: "insight",
        sourceRef: event.event_id,
        content:
          `Hidden payroll cost at ${event.company} for ${event.period}: the bank ` +
          `salary transfer of ${money(event.bank_net_total)} understates the true ` +
          `employer cost by ${money(event.hidden_total)} ` +
          `(${event.cost_gap_pct.toFixed(1)}%), mostly employer social-security ` +
          `(IKA) of ${money(event.employer_ika_total)}.`,
        metadata: {
          hidden_total: event.hidden_total,
          cost_gap_pct: event.cost_gap_pct,
          employer_ika_total: event.employer_ika_total,
        },
      })
    );

    // 3. Per-employee lines (memory of who was paid what).
    for (const emp of event.employees) {
      ids.push(
        await remember(this.embedder, this.store, {
          ...base,
          kind: "payroll_event",
          sourceRef: `${event.event_id}:${emp.employee_id}`,
          content:
            `${emp.name} (id ${emp.employee_id}) at ${event.company} in ` +
            `${event.period}: gross ${money(emp.gross)}, net ${money(emp.net)}, ` +
            `employer cost ${money(emp.employer_cost)}.`,
          metadata: { employee_id: emp.employee_id, net: emp.net, gross: emp.gross },
        })
      );
    }
    return ids;
  }

  // Commit an arbitrary fact (used by the extractor / validator agents).
  async remember(
    kind: MemoryKind,
    content: string,
    opts: {
      company?: string;
      period?: string;
      sourceRef?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<string> {
    return remember(this.embedder, this.store, { kind, content, ...opts });
  }

  // ── READ (RAG over agent memory) ───────────────────────────────────────────
  // Recall the memories most relevant to a question via the vector store, then
  // have the narrator write a grounded, CITING answer from them. With a real
  // DashScope key this calls a Qwen chat model (real RAG); offline it uses the
  // deterministic FakeNarrator — same recall path either way.
  async recallAnswer(
    question: string,
    opts: { company?: string; kind?: MemoryKind; limit?: number } = {}
  ): Promise<{ answer: string; hits: RecallHit[]; citations: Citation[]; modelId: string }> {
    const hits = await recall(this.embedder, this.store, question, {
      company: opts.company,
      kind: opts.kind,
      limit: opts.limit ?? 5,
    });
    const { answer, citations, modelId } = await this.narrator.narrate(question, hits);
    return { answer, hits, citations, modelId };
  }
}

function money(n: number | null | undefined): string {
  if (n == null) return "n/a";
  return `€${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
