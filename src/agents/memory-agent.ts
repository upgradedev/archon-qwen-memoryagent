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

import { createHash } from "node:crypto";
import type { Embedder } from "../memory/embeddings.js";
import { remember, rememberMany, recall } from "../memory/memory.js";
import {
  DEFAULT_TENANT_ID,
  type FeedbackOutcome,
  type FeedbackResult,
  type MemoryInput,
  type MemoryKind,
  type MemoryStore,
  type RecallHit,
} from "../memory/store.js";
import { applyRerank, defaultReranker, type Reranker } from "../memory/rerank.js";
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
import {
  detectSemanticContradictions,
  defaultSemanticJudge,
  type SemanticJudge,
  type SemanticAuditOptions,
  type SemanticConsistencyReport,
} from "../memory/semantic-consistency.js";
import type { PayrollEvent } from "../types.js";

export class MemoryAgent {
  private narrator: Narrator;
  private judge: SemanticJudge;
  constructor(
    private embedder: Embedder,
    private store: MemoryStore,
    narrator: Narrator = defaultNarrator(),
    judge: SemanticJudge = defaultSemanticJudge(),
    private reranker: Reranker = defaultReranker(),
    private readonly defaultTenantId: string = DEFAULT_TENANT_ID,
  ) {
    this.narrator = narrator;
    this.judge = judge;
  }

  // ── WRITE ────────────────────────────────────────────────────────────────
  // Commit a fused PayrollEvent to memory as several recallable facts. Returns
  // the ids of the memories written.
  async ingestEvent(event: PayrollEvent, opts: { tenantId?: string } = {}): Promise<string[]> {
    return this.ingestPipelineBatch(event, [], opts);
  }

  // Atomically commit one fused event together with every derived pipeline fact
  // (for example validation findings). All content is embedded before the store
  // transaction opens; then PgVectorStore commits every row or none. The tenant
  // is imposed by the agent and cannot be overridden by an additional fact.
  async ingestPipelineBatch(
    event: PayrollEvent,
    additionalMemories: ReadonlyArray<Omit<MemoryInput, "tenantId">>,
    opts: { tenantId?: string } = {},
  ): Promise<string[]> {
    const base = { tenantId: opts.tenantId ?? this.defaultTenantId, company: event.company, period: event.period } as const;
    const memories: MemoryInput[] = [];

    // 1. The event summary.
    memories.push(
      {
        ...base,
        kind: "payroll_event",
        sourceRef: event.event_id,
        idempotencyKey: `event:${event.event_id}:summary`,
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
          employer_social_security_total: event.employer_social_security_total,
          employee_social_security_total: event.employee_social_security_total,
          tax_withheld_total: event.tax_withheld_total,
        },
      } as const,
    );

    // 2. An insight — the off-bank workforce-cost gap (one of several the agents remember).
    memories.push(
      {
        ...base,
        kind: "insight",
        sourceRef: event.event_id,
        idempotencyKey: `event:${event.event_id}:insight`,
        content:
          `Off-bank workforce cost at ${event.company} for ${event.period}: the bank ` +
          `salary transfer of ${money(event.bank_net_total)} understates the true ` +
          `cost of employing the team by ${money(event.off_bank_cost)} ` +
          `(${event.cost_gap_pct.toFixed(1)}%), mostly employer social-security ` +
          `contributions of ${money(event.employer_social_security_total)}.`,
        // The off-bank-cost insight is the highest-salience memory the agent keeps,
        // so it survives forgetting and wins consolidation ties.
        importance: 0.9,
        metadata: {
          off_bank_cost: event.off_bank_cost,
          cost_gap_pct: event.cost_gap_pct,
          employer_social_security_total: event.employer_social_security_total,
        },
      } as const,
    );

    // 3. Per-employee lines (memory of who was paid what).
    for (const emp of event.employees) {
      memories.push(
        {
          ...base,
          kind: "payroll_event",
          sourceRef: `${event.event_id}:${emp.employee_id}`,
          idempotencyKey: `event:${event.event_id}:employee:${emp.employee_id}`,
          content:
            `${emp.name} (id ${emp.employee_id}) at ${event.company} in ` +
            `${event.period}: gross ${money(emp.gross)}, net ${money(emp.net)}, ` +
            `employer cost ${money(emp.employer_cost)}.`,
          metadata: { employee_id: emp.employee_id, net: emp.net, gross: emp.gross },
        } as const,
      );
    }
    for (const memory of additionalMemories) {
      memories.push({ ...memory, tenantId: base.tenantId });
    }
    return rememberMany(this.embedder, this.store, memories);
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
      tenantId?: string;
      importance?: number;
      idempotencyKey?: string;
    } = {}
  ): Promise<string> {
    return remember(this.embedder, this.store, {
      kind,
      content,
      tenantId: opts.tenantId ?? this.defaultTenantId,
      ...opts,
    });
  }

  // ── READ (RAG over agent memory) ───────────────────────────────────────────
  // Recall the memories most relevant to a question via the vector store, then
  // have the narrator write a grounded, CITING answer from them. With a real
  // DashScope key this calls a Qwen chat model (real RAG); offline it uses the
  // deterministic FakeNarrator — same recall path either way.
  async recallAnswer(
    question: string,
    opts: {
      tenantId?: string;
      company?: string;
      kind?: MemoryKind;
      limit?: number;
      hybrid?: boolean;
      rerank?: boolean;
      rerankTimeoutMs?: number;
    } = {}
  ): Promise<{
    answer: string;
    hits: RecallHit[];
    citations: Citation[];
    modelId: string;
    consistency: ConsistencyReport;
    retrieval: {
      strategy: "dense" | "hybrid";
      candidateCount: number;
      returnedCount: number;
      reranker: { status: "applied" | "fallback" | "disabled"; modelId: string; durationMs: number };
    };
    degraded?: string;
  }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
    const useReranker = opts.rerank ?? true;
    const candidateLimit = useReranker ? Math.min(20, Math.max(limit, limit * 4)) : limit;
    const candidates = await recall(this.embedder, this.store, question, {
      tenantId: opts.tenantId ?? this.defaultTenantId,
      company: opts.company,
      kind: opts.kind,
      limit: candidateLimit,
      // Hybrid (dense + lexical RRF) is the default retrieval path — it beats
      // naive vector recall on the benchmark (see bench/ + BENCHMARK.md). Pass
      // hybrid:false to force pure vector recall.
      hybrid: opts.hybrid ?? true,
    });
    let hits = candidates.slice(0, limit);
    const rerankStarted = Date.now();
    let rerankStatus: "applied" | "fallback" | "disabled" = useReranker ? "fallback" : "disabled";
    if (useReranker && candidates.length > 1) {
      try {
        const timeoutMs = Math.max(100, Math.min(opts.rerankTimeoutMs ?? Number(process.env.RERANK_TIMEOUT_MS ?? 3_000), 15_000));
        const scores = await withTimeout(
          this.reranker.rerank(
            question,
            candidates.map((h) => ({ id: h.id, content: h.content })),
          ),
          timeoutMs,
          "reranker timeout",
        );
        const scoreMap = new Map(scores.map((s) => [s.id, s.score]));
        const rankedIds = applyRerank(candidates.map((h) => h.id), scoreMap, limit);
        const byId = new Map(candidates.map((h) => [h.id, h]));
        hits = rankedIds.map((id) => byId.get(id)).filter((h): h is RecallHit => Boolean(h));
        rerankStatus = "applied";
      } catch {
        // Retrieval already succeeded. A slow/unavailable re-ranker must degrade
        // to the incoming hybrid order, never turn useful recall into a 5xx.
        hits = candidates.slice(0, limit);
        rerankStatus = "fallback";
      }
    } else if (useReranker) {
      rerankStatus = "applied";
    }
    // Graceful degradation: the memories are ALREADY retrieved by this point, so a
    // narrator (qwen-plus) outage must not cost the user the recall. If narration
    // fails, still return the retrieved memories as citations plus a plain
    // fallback answer composed from them, flagged `degraded` — a soft, useful
    // result instead of a hard 500. The self-audit below is unaffected. (Recall
    // itself needs the query embedding, so an embedder outage throws upstream of
    // here and correctly surfaces as an error, not a degraded answer.)
    let answer: string;
    let citations: Citation[];
    let modelId: string;
    let degraded: string | undefined;
    try {
      ({ answer, citations, modelId } = await this.narrator.narrate(question, hits));
    } catch (err) {
      citations = hits.map(hitToCitation);
      answer = fallbackAnswer(citations);
      modelId = "degraded";
      degraded = "narrator unavailable — returning raw recalled memories";
    }
    // Best-effort self-audit over the memories JUST recalled — no extra DB round
    // trip, so the live /recall hot path is unchanged. It surfaces a conflict when
    // both sides happen to be in the top-k. The exhaustive, guaranteed audit is
    // `auditConsistency()` (the /consistency route), which scans the full scope.
    const consistency = auditConsistency(hits.map(hitToAuditMemory));
    return {
      answer,
      hits,
      citations,
      modelId,
      consistency,
      retrieval: {
        strategy: opts.hybrid ?? true ? "hybrid" : "dense",
        candidateCount: candidates.length,
        returnedCount: hits.length,
        reranker: {
          status: rerankStatus,
          modelId: this.reranker.modelId,
          durationMs: Date.now() - rerankStarted,
        },
      },
      ...(degraded ? { degraded } : {}),
    };
  }

  // ── SELF-AUDIT (memory-consistency) ────────────────────────────────────────
  // Exhaustively audit the agent's own memory for cross-session contradictions
  // (two write events store different values for one record) and dangling
  // references (a memory points at a record the agent never stored). Read-only:
  // scans ACTIVE memories in scope via the store's audit read (no schema change).
  async auditConsistency(
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind } = {}
  ): Promise<ConsistencyReport> {
    const memories = await this.store.listForAudit({ ...scope, tenantId: scope.tenantId ?? this.defaultTenantId });
    return auditConsistency(memories);
  }

  // ── SEMANTIC SELF-AUDIT ────────────────────────────────────────────────────
  // The meaning-aware companion to auditConsistency: catches memories that
  // OPPOSE each other in meaning while sharing no comparable metadata key (e.g.
  // "vendor always pays on time" vs "vendor is chronically late") — the class of
  // contradiction the rule-based audit is blind to. Reuses each memory's persisted
  // recall embedding, keeps same-subject pairs by cosine, and asks the judge (qwen-plus
  // online, a deterministic polarity heuristic offline) whether they contradict.
  // Read-only; each finding carries the SAME resolution recommendation shape.
  async auditSemanticConsistency(
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind } = {},
    opts: SemanticAuditOptions = {}
  ): Promise<SemanticConsistencyReport> {
    const memories = await this.store.listForSemanticAudit({
      ...scope,
      tenantId: scope.tenantId ?? this.defaultTenantId,
    });
    return detectSemanticContradictions(memories, this.judge, opts);
  }

  // ── MEMORY LIFECYCLE ───────────────────────────────────────────────────────
  // Consolidate near-duplicate memories: cluster active memories by embedding
  // similarity (same kind, cosine >= threshold), keep the most-important/newest
  // in each cluster, and supersede the rest so recall stops returning duplicates.
  async consolidate(
    opts: { tenantId?: string; company?: string; threshold?: number; dryRun?: boolean } = {}
  ): Promise<{ clusters: number; planned: number; superseded: number; dryRun: boolean }> {
    const tenantId = opts.tenantId ?? this.defaultTenantId;
    const memories = await this.store.listForConsolidation(opts.company, tenantId);
    const plan = planConsolidation(memories, opts.threshold ?? 0.95);
    const planned = plan.groups.reduce((n, g) => n + g.losers.length, 0);
    if (opts.dryRun) return { clusters: plan.groups.length, planned, superseded: 0, dryRun: true };
    let superseded = 0;
    for (const g of plan.groups) {
      superseded += await this.store.supersede(g.losers, g.winner, tenantId);
    }
    return { clusters: plan.groups.length, planned, superseded, dryRun: false };
  }

  // Forget memories under a retention policy: by default drop rows already
  // superseded by consolidation; optionally also forget stale, low-importance
  // active memories (olderThanDays + maxImportance).
  async forget(
    policy: ForgetPolicy = {},
    company?: string,
    tenantId?: string,
    dryRun: boolean = false,
  ): Promise<{ candidates: number; forgotten: number; dryRun: boolean }> {
    const resolvedTenantId = tenantId ?? this.defaultTenantId;
    const candidates = await this.store.listForForget(company, resolvedTenantId);
    const ids = planForget(candidates, policy);
    if (dryRun) return { candidates: ids.length, forgotten: 0, dryRun: true };
    const forgotten = await this.store.deleteMemories(ids, resolvedTenantId);
    return { candidates: ids.length, forgotten, dryRun: false };
  }

  // Human feedback closes the learning loop across sessions. Correct memories
  // are protected from retention by raising importance; incorrect memories are
  // atomically superseded by an embedded, high-importance corrected fact.
  async applyFeedback(
    memoryId: string,
    outcome: FeedbackOutcome,
    correctedFact?: string,
    opts: { tenantId?: string; feedbackId?: string } = {},
  ): Promise<FeedbackResult> {
    const tenantId = opts.tenantId ?? this.defaultTenantId;
    if (outcome === "incorrect" && !correctedFact?.trim()) {
      throw Object.assign(new Error("incorrect feedback requires correctedFact"), { statusCode: 400 });
    }
    // A corrected fact is meaningful only for an incorrect outcome. Ignoring it
    // for "correct" prevents an unnecessary model call and misleading retry id.
    const normalizedCorrection = outcome === "incorrect" ? correctedFact?.trim() : undefined;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ tenantId, memoryId, outcome, correction: normalizedCorrection ?? null }))
      .digest("hex");
    const feedbackId = opts.feedbackId ?? requestHash.slice(0, 32);
    // Sequential retries return durable provenance before re-embedding the same
    // correction. The transactional write below still resolves concurrent races.
    const existing = await this.store.getFeedback(feedbackId, tenantId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Object.assign(new Error("feedback id was already used for a different request"), { statusCode: 409 });
      }
      if (existing.result) return existing.result;
    }
    const target = await this.store.getMemoryForFeedback(memoryId, tenantId);
    if (!target) throw Object.assign(new Error("memory not found in this tenant"), { statusCode: 404 });
    const correction = normalizedCorrection
      ? {
          tenantId,
          kind: target.kind,
          company: target.company,
          period: target.period,
          sourceRef: `feedback:${memoryId}`,
          content: normalizedCorrection,
          metadata: {
            correctedFrom: memoryId,
            feedbackId,
          },
          importance: 0.95,
          idempotencyKey: `feedback:${feedbackId}:correction`,
          embedding: await this.embedder.embed(normalizedCorrection),
          embedModel: this.embedder.modelId,
        }
      : undefined;
    return this.store.applyFeedback({ tenantId, feedbackId, requestHash, memoryId, outcome, correction });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function money(n: number | null | undefined): string {
  if (n == null) return "n/a";
  // PayrollEvent currently carries no currency field. Preserve the amount
  // without inventing EUR (or any other jurisdiction-specific unit).
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} currency units`;
}

// Degradation fallback: project the recalled hits into the same Citation shape
// the narrators emit (marker + content), so a degraded answer stays grounded and
// cited even with the model down. Mirrors the narrator's numbering ([1], [2], …).
function hitToCitation(h: RecallHit, i: number): Citation {
  return {
    marker: `[${i + 1}]`,
    kind: h.kind,
    score: h.score,
    sourceRef: h.sourceRef,
    content: h.content,
  };
}

// A plain, non-model answer composed directly from the recalled memories — used
// only when the narrator is unavailable. No prose synthesis, just the grounded
// evidence, so the caller still gets a useful, cited result.
function fallbackAnswer(citations: Citation[]): string {
  if (citations.length === 0) {
    return "No relevant memories found in the agent's persistent memory.";
  }
  const grounded = citations.map((c) => `${c.marker} ${c.content}`).join(" ");
  return (
    `The answer narrator is temporarily unavailable, so here are the ` +
    `${citations.length} most relevant memory item(s) recalled for this question: ${grounded}`
  );
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
