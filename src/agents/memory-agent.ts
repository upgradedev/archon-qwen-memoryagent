// MemoryAgent — the minimal agentic loop over persistent memory.
//
// This is the read/write-memory path the rest of the Archon pipeline plugs into:
//
//   ingestEvent()   WRITE  — an agent has fused a financial event; it commits the
//                            salient facts to memory (event, per-employee lines,
//                            key insights) so FUTURE SESSIONS can recall them.
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
import {
  planConsolidation,
  planForget,
  type ForgetPolicy,
} from "../memory/consolidation.js";
import {
  auditConsistency,
  type AuditMemory,
  type ConsistencyReport,
} from "../memory/consistency.js";
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
          `Workforce cost for ${event.company} in ${event.period}: ` +
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

    // 2. An insight — the hidden workforce-cost gap (one of several the agents remember).
    ids.push(
      await remember(this.embedder, this.store, {
        ...base,
        kind: "insight",
        sourceRef: event.event_id,
        content:
          `Hidden workforce cost at ${event.company} for ${event.period}: the bank ` +
          `salary transfer of ${money(event.bank_net_total)} understates the true ` +
          `cost of employing the team by ${money(event.hidden_total)} ` +
          `(${event.cost_gap_pct.toFixed(1)}%), mostly employer social-security ` +
          `contributions of ${money(event.employer_social_security_total)}.`,
        // The hidden-cost insight is the highest-salience memory the agent keeps,
        // so it survives forgetting and wins consolidation ties.
        importance: 0.9,
        metadata: {
          hidden_total: event.hidden_total,
          cost_gap_pct: event.cost_gap_pct,
          employer_social_security_total: event.employer_social_security_total,
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
    opts: { company?: string; kind?: MemoryKind; limit?: number; hybrid?: boolean } = {}
  ): Promise<{
    answer: string;
    hits: RecallHit[];
    citations: Citation[];
    modelId: string;
    consistency: ConsistencyReport;
  }> {
    const hits = await recall(this.embedder, this.store, question, {
      company: opts.company,
      kind: opts.kind,
      limit: opts.limit ?? 5,
      // Hybrid (dense + lexical RRF) is the default retrieval path — it beats
      // naive vector recall on the benchmark (see bench/ + BENCHMARK.md). Pass
      // hybrid:false to force pure vector recall.
      hybrid: opts.hybrid ?? true,
    });
    const { answer, citations, modelId } = await this.narrator.narrate(question, hits);
    // Best-effort self-audit over the memories JUST recalled — no extra DB round
    // trip, so the live /recall hot path is unchanged. It surfaces a conflict when
    // both sides happen to be in the top-k. The exhaustive, guaranteed audit is
    // `auditConsistency()` (the /consistency route), which scans the full scope.
    const consistency = auditConsistency(hits.map(hitToAuditMemory));
    return { answer, hits, citations, modelId, consistency };
  }

  // ── SELF-AUDIT (memory-consistency) ────────────────────────────────────────
  // Exhaustively audit the agent's own memory for cross-session contradictions
  // (two write events store different values for one record) and dangling
  // references (a memory points at a record the agent never stored). Read-only:
  // scans ACTIVE memories in scope via the store's audit read (no schema change).
  async auditConsistency(
    scope: { company?: string; period?: string; kind?: MemoryKind } = {}
  ): Promise<ConsistencyReport> {
    const memories = await this.store.listForAudit(scope);
    return auditConsistency(memories);
  }

  // ── MEMORY LIFECYCLE ───────────────────────────────────────────────────────
  // Consolidate near-duplicate memories: cluster active memories by embedding
  // similarity (same kind, cosine >= threshold), keep the most-important/newest
  // in each cluster, and supersede the rest so recall stops returning duplicates.
  async consolidate(
    opts: { company?: string; threshold?: number } = {}
  ): Promise<{ clusters: number; superseded: number }> {
    const memories = await this.store.listForConsolidation(opts.company);
    const plan = planConsolidation(memories, opts.threshold ?? 0.95);
    let superseded = 0;
    for (const g of plan.groups) superseded += await this.store.supersede(g.losers, g.winner);
    return { clusters: plan.groups.length, superseded };
  }

  // Forget memories under a retention policy: by default drop rows already
  // superseded by consolidation; optionally also forget stale, low-importance
  // active memories (olderThanDays + maxImportance).
  async forget(policy: ForgetPolicy = {}, company?: string): Promise<{ forgotten: number }> {
    const candidates = await this.store.listForForget(company);
    const ids = planForget(candidates, policy);
    const forgotten = await this.store.deleteMemories(ids);
    return { forgotten };
  }
}

function money(n: number | null | undefined): string {
  if (n == null) return "n/a";
  return `€${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// A RecallHit already carries every field the audit needs (it is a MemoryRecord
// plus scores), so the audit view is just a projection — no extra read.
function hitToAuditMemory(h: RecallHit): AuditMemory {
  return {
    id: h.id,
    kind: h.kind,
    company: h.company,
    period: h.period,
    sourceRef: h.sourceRef,
    content: h.content,
    metadata: h.metadata,
    createdAt: h.createdAt,
  };
}
