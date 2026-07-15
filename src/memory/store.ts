// Memory store — the persistence seam of the agent's memory.
//
// A `MemoryStore` durably holds embedded memories and answers approximate-
// nearest-neighbour recall over them. Two implementations behind one interface:
//
//   PgVectorStore  — production/CI. pgvector on a PostgreSQL-wire database.
//                    Local + CI: a stock pgvector/pgvector docker image.
//                    Production: Alibaba Cloud AnalyticDB for PostgreSQL or
//                    ApsaraDB RDS for PostgreSQL (pgvector) — same pg-wire, same
//                    SQL, so the store code is identical across all three.
//   InMemoryStore  — dependency-free unit-test double. Same cosine ranking, no
//                    infra, so the memory logic is verifiable with zero creds.
//
// This is the abstraction that makes the agent's memory PERSISTENT and CROSS-
// SESSION: a memory written by one process/session is recalled by a later,
// completely separate one, because both point PgVectorStore at the same database.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { query, toVectorLiteral, withClient } from "../db/client.js";
import { rrfFuse, topK, BM25, cosineSimilarity } from "./retrieval.js";
import {
  planConsolidation,
  planForget,
  type ConsolidatableMemory,
  type ForgetCandidate,
  type ForgetPolicy,
} from "./consolidation.js";
import { auditConsistency, subjectKey, type AuditMemory } from "./consistency.js";
import { canonicalBusinessLabel } from "../pipeline/identity.js";

export type MemoryKind = "document" | "payroll_event" | "validation" | "insight" | "invoice" | "action";
export const DEFAULT_TENANT_ID = "_public";
export const DEFAULT_LIFECYCLE_CANDIDATE_CAP = 5_000;
export const MAX_LIFECYCLE_CANDIDATE_CAP = 20_000;

export function configuredLifecycleCandidateCap(
  raw: string | number | undefined = process.env.LIFECYCLE_CANDIDATE_CAP,
): number {
  const value = Number(raw ?? DEFAULT_LIFECYCLE_CANDIDATE_CAP);
  if (!Number.isFinite(value)) return DEFAULT_LIFECYCLE_CANDIDATE_CAP;
  return Math.max(1, Math.min(Math.trunc(value), MAX_LIFECYCLE_CANDIDATE_CAP));
}

type ConsolidationAtomicResult = {
  clusters: number; planned: number; superseded: number; dryRun: boolean;
  scanned: number; candidateCap: number; truncated: false;
  audit: LifecycleAuditProvenance;
};
type ForgetAtomicResult = {
  candidates: number; forgotten: number; dryRun: boolean;
  scanned: number; candidateCap: number; truncated: false;
  audit: LifecycleAuditProvenance;
};
export type LifecycleAuditProvenance = {
  operationId: string;
  actor: string;
  reason: string;
  persisted: boolean;
  completedAt: string | null;
};
type LifecycleAtomicOptions = {
  company?: string;
  tenantId: string;
  dryRun: boolean;
  candidateCap?: number;
  /** Never compare vectors produced by different embedding models. */
  embedModel?: string;
  operationId: string;
  actor: string;
  reason: string;
  requestHash: string;
};

export interface MemoryInput {
  kind: MemoryKind;
  tenantId?: string; // server-derived isolation boundary; defaults to public demo tenant
  company?: string; // defaults to '_global'
  period?: string | null;
  sourceRef?: string | null; // originating row id
  content: string; // the recallable natural-language fact
  metadata?: Record<string, unknown> | null;
  importance?: number; // 0..1 salience, defaults to 0.5
  idempotencyKey?: string | null; // retry-safe producer key, unique inside a tenant
}

// A memory ready to persist: the input plus its embedding + which model produced it.
export interface StoredMemory extends MemoryInput {
  embedding: number[];
  embedModel: string;
}

export interface MemoryRecord {
  id: string;
  tenantId?: string; // present on production/store results; optional for legacy fixtures
  kind: MemoryKind;
  company: string;
  period: string | null;
  sourceRef: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecallHit extends MemoryRecord {
  distance: number; // cosine distance (0 = identical direction, 2 = opposite)
  score: number; // cosine SIMILARITY (1 - distance) — the real semantic closeness
  // On HYBRID recalls, ORDERING is driven by Reciprocal Rank Fusion, not cosine.
  // `score`/`distance` above still report the hit's REAL cosine (so a curl of the
  // default /recall shows sane 0.3–0.7 similarities, not the tiny RRF fusion score
  // that used to leak into `score`). The RRF value that actually decided the order
  // is surfaced here, separately, for transparency. Absent on pure-dense recalls.
  rrfScore?: number;
}

export interface RecallOptions {
  tenantId?: string;
  kind?: MemoryKind; // pre-filter
  company?: string; // pre-filter
  limit?: number; // top-k, default 5
  // Hybrid retrieval: when `hybrid` is set, the store fuses dense (vector) recall
  // with lexical (full-text) recall via Reciprocal Rank Fusion. Requires
  // `queryText` (the raw question) for the lexical half.
  hybrid?: boolean;
  queryText?: string;
  /** Internal compatibility boundary, supplied by memory.recall(). */
  embedModel?: string;
  includeSuperseded?: boolean; // default false — consolidated-away memories are hidden
}

export type FeedbackOutcome = "correct" | "incorrect";
export interface FeedbackTarget extends MemoryRecord {
  importance: number;
  supersededAt: string | null;
}
export interface FeedbackResult {
  feedbackId: string;
  memoryId: string;
  outcome: FeedbackOutcome;
  correctedMemoryId: string | null;
  before: { importance: number; supersededAt: string | null };
  after: { importance: number; supersededAt: string | null; supersededBy: string | null };
}
export interface FeedbackWrite {
  tenantId: string;
  feedbackId: string;
  requestHash: string;
  memoryId: string;
  outcome: FeedbackOutcome;
  correction?: StoredMemory;
}
export interface FeedbackLookup {
  requestHash: string | null;
  result: FeedbackResult | null;
}

export interface ConflictResolutionWrite {
  tenantId: string;
  decisionId: string;
  requestHash: string;
  subject: string;
  attribute: string;
  selectedMemoryId: string;
  targetMemoryIds: string[];
  /** Server-derived authenticated principal, never accepted from the HTTP body. */
  actor: string;
  reason: string;
}

export interface ConflictResolutionResult {
  decisionId: string;
  subject: string;
  attribute: string;
  selectedMemoryId: string;
  supersededMemoryIds: string[];
  actor: string;
  reason: string;
  before: { activeCarriers: number; selectedImportance: number };
  after: { activeCarriers: 1; selectedImportance: number };
  resolvedAt: string;
}
export interface SemanticAuditMemory extends AuditMemory {
  embedding: number[];
}

export interface MemoryStore {
  remember(m: StoredMemory): Promise<string>;
  /** Atomic for PgVectorStore; idempotency keys return the original row ids. */
  rememberMany(memories: StoredMemory[]): Promise<string[]>;
  recall(queryVec: number[], opts?: RecallOptions): Promise<RecallHit[]>;
  count(company?: string, tenantId?: string): Promise<number>;
  ready(): Promise<void>;
  getMemoryForFeedback(memoryId: string, tenantId?: string): Promise<FeedbackTarget | null>;
  getFeedback(feedbackId: string, tenantId?: string): Promise<FeedbackLookup | null>;
  applyFeedback(input: FeedbackWrite): Promise<FeedbackResult>;
  /** Atomic, idempotent selection of one existing carrier for a field conflict. */
  resolveConflict(input: ConflictResolutionWrite): Promise<ConflictResolutionResult>;
  clear(): Promise<void>;
  // ── memory lifecycle (consolidation / forgetting) ──
  listForConsolidation(company?: string, tenantId?: string): Promise<ConsolidatableMemory[]>;
  supersede(loserIds: string[], winnerId: string, tenantId?: string): Promise<number>;
  consolidateAtomic(opts: LifecycleAtomicOptions & { threshold: number }): Promise<ConsolidationAtomicResult>;
  listForForget(company?: string, tenantId?: string): Promise<ForgetCandidate[]>;
  deleteMemories(ids: string[], tenantId?: string): Promise<number>;
  forgetAtomic(opts: LifecycleAtomicOptions & { policy: ForgetPolicy; now?: Date }): Promise<ForgetAtomicResult>;
  // ── self-auditing (consistency) ──
  // Read-only: return ACTIVE memories in scope for a consistency audit. Selects
  // only columns that already exist (no schema change — the live table is safe).
  listForAudit(scope?: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind; limit?: number }): Promise<AuditMemory[]>;
  /** Active, tenant-scoped audit rows with their already-persisted embeddings. */
  listForSemanticAudit(scope?: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind; limit?: number; embedModel?: string }): Promise<SemanticAuditMemory[]>;
}

const POOL_K = 20; // depth of each ranked list fed into hybrid fusion
/**
 * Selective HNSW filters can otherwise return fewer than k rows because the
 * filter is applied after the approximate index scan. Small/medium scopes use
 * an exact scan; larger scopes use pgvector 0.8+ iterative scanning.
 */
export const EXACT_FILTERED_RECALL_MAX_ROWS = 20_000;
const HNSW_EF_SEARCH = 100;
const HNSW_MAX_SCAN_TUPLES = 100_000;

// ── pgvector-backed store (production + CI + Alibaba Cloud) ────────────────────
export class PgVectorStore implements MemoryStore {
  async remember(m: StoredMemory): Promise<string> {
    return (await this.rememberMany([m]))[0]!;
  }

  async rememberMany(memories: StoredMemory[]): Promise<string[]> {
    if (memories.length === 0) return [];
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const ids: string[] = [];
        for (const m of memories) {
          const rows = await client.query<{ id: string }>(
            `INSERT INTO agent_memory
               (tenant_id, kind, company, company_key, period, source_ref, content, metadata,
                embedding, embed_model, importance, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, $12)
             ON CONFLICT (tenant_id, idempotency_key)
               WHERE idempotency_key IS NOT NULL
             DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
               WHERE agent_memory.kind = EXCLUDED.kind
                 AND agent_memory.company_key = EXCLUDED.company_key
                 AND agent_memory.period IS NOT DISTINCT FROM EXCLUDED.period
                 AND agent_memory.source_ref IS NOT DISTINCT FROM EXCLUDED.source_ref
                 AND agent_memory.content = EXCLUDED.content
                 AND agent_memory.metadata IS NOT DISTINCT FROM EXCLUDED.metadata
                 AND agent_memory.importance = EXCLUDED.importance
             RETURNING id`,
            [
              m.tenantId ?? DEFAULT_TENANT_ID,
              m.kind,
              m.company ?? "_global",
              companyKey(m.company),
              m.period ?? null,
              m.sourceRef ?? null,
              m.content,
              m.metadata ? JSON.stringify(m.metadata) : null,
              toVectorLiteral(m.embedding),
              m.embedModel,
              clampImportance(m.importance),
              m.idempotencyKey ?? null,
            ],
          );
          const row = rows.rows[0];
          if (!row) throw Object.assign(new Error("idempotency key was already used for a different logical memory"), { statusCode: 409 });
          ids.push(row.id);
        }
        await client.query("COMMIT");
        return ids;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });
  }

  private scopeSql(opts: RecallOptions, params: unknown[]): string {
    params.push(opts.tenantId ?? DEFAULT_TENANT_ID);
    const filters: string[] = [`tenant_id = $${params.length}`];
    if (!opts.includeSuperseded) filters.push(`superseded_at IS NULL`);
    if (opts.kind) {
      params.push(opts.kind);
      filters.push(`kind = $${params.length}`);
    }
    if (opts.company) {
      params.push(companyKey(opts.company));
      filters.push(`company_key = $${params.length}`);
    }
    if (opts.embedModel) {
      params.push(opts.embedModel);
      filters.push(`embed_model = $${params.length}`);
    }
    return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  }

  private async denseRows(queryVec: number[], opts: RecallOptions, limit: number): Promise<PgRow[]> {
    return withClient(async (client) => {
      await client.query("BEGIN TRANSACTION READ ONLY");
      try {
        const countParams: unknown[] = [];
        const countWhere = this.scopeSql(opts, countParams);
        const countResult = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM agent_memory ${countWhere}`,
          countParams,
        );
        const scopedRows = Number(countResult.rows[0]!.n);
        if (scopedRows <= EXACT_FILTERED_RECALL_MAX_ROWS) {
          // Force a sequential distance scan so post-index filters cannot
          // underfill or silently miss a better in-scope neighbour.
          await client.query("SET LOCAL enable_indexscan = off");
          await client.query("SET LOCAL enable_bitmapscan = off");
        } else {
          // pgvector 0.8+ keeps scanning the HNSW graph after filtered-out rows
          // instead of stopping after the first approximate candidate window.
          await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
          await client.query(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
          await client.query(`SET LOCAL hnsw.max_scan_tuples = ${HNSW_MAX_SCAN_TUPLES}`);
        }

        const params: unknown[] = [toVectorLiteral(queryVec)];
        const where = this.scopeSql(opts, params);
        params.push(limit);
        const rows = await client.query<PgRow>(
          `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata, created_at,
                  (embedding <=> $1::vector) AS distance
             FROM agent_memory
             ${where}
           ORDER BY embedding <=> $1::vector
           LIMIT $${params.length}`,
          params,
        );
        await client.query("COMMIT");
        return rows.rows;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    if (opts.hybrid && opts.queryText) return this.recallHybrid(queryVec, opts, limit);

    const rows = await this.denseRows(queryVec, opts, limit);
    return rows.map(rowToHitByDistance);
  }

  // Hybrid: pull a pool of dense candidates and a pool of lexical candidates,
  // fuse their RANKINGS with RRF (rank-based → no score normalization needed) to
  // decide ORDER, but report each hit's REAL cosine similarity in `score` (RRF is
  // exposed separately as `rrfScore`). This keeps the default /recall response
  // honest — cosines read like cosines (~0.3–0.7), not the tiny 1/(60+rank) RRF
  // value that used to leak into the field labelled as similarity.
  private async recallHybrid(
    queryVec: number[],
    opts: RecallOptions,
    limit: number
  ): Promise<RecallHit[]> {
    // Dense pool. pgvector's `<=>` is cosine DISTANCE, so 1 - distance = cosine sim.
    const poolLimit = Math.max(POOL_K, limit);
    const dense = await this.denseRows(queryVec, opts, poolLimit);
    // Lexical pool (full-text ts_rank over the same scope). Pull the embedding too,
    // so a lexical-ONLY hit (not in the dense pool) still gets a REAL cosine rather
    // than a fake distance=0.
    const lParams: unknown[] = [opts.queryText!];
    const lWhere = this.scopeSql(opts, lParams);
    const lAnd = lWhere ? `${lWhere} AND` : "WHERE";
    lParams.push(poolLimit);
    const lexical = await query<PgRow>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata, created_at,
              0 AS distance, embedding::text AS embedding
         FROM agent_memory
         ${lAnd} to_tsvector('simple', content) @@ plainto_tsquery('simple', $1)
       ORDER BY ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', $1)) DESC
       LIMIT $${lParams.length}`,
      lParams
    );

    // RRF decides ORDER; a separate map holds each hit's real cosine similarity.
    const fused = rrfFuse([dense.map((r) => r.id), lexical.map((r) => r.id)]);
    const rrfById = new Map(fused.map((f) => [f.id, f.score]));
    const cosineById = new Map<string, number>();
    for (const r of dense) cosineById.set(r.id, 1 - Number(r.distance));
    for (const r of lexical) {
      if (cosineById.has(r.id)) continue; // dense cosine is authoritative
      cosineById.set(r.id, r.embedding ? cosineSimilarity(queryVec, parseVector(r.embedding)) : 0);
    }

    const byId = new Map<string, PgRow>();
    for (const r of [...dense, ...lexical]) if (!byId.has(r.id)) byId.set(r.id, r);
    return topK(fused, limit).map((id) => {
      const r = byId.get(id)!;
      return rowToHitHybrid(r, cosineById.get(id) ?? 0, rrfById.get(id) ?? 0);
    });
  }

  async count(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<number> {
    const rows = company
      ? await query<{ n: string }>(
          `SELECT count(*) AS n FROM agent_memory WHERE tenant_id = $1 AND company_key = $2`,
          [tenantId, companyKey(company)]
        )
      : await query<{ n: string }>(`SELECT count(*) AS n FROM agent_memory WHERE tenant_id = $1`, [tenantId]);
    return Number(rows[0]!.n);
  }

  async ready(): Promise<void> {
    // Readiness is a post-migration contract, not merely a reachable socket.
    // LIMIT 0 verifies every column/type the live request paths depend on.
    await query(
      `SELECT tenant_id, company_key, importance, idempotency_key, embedding::text
         FROM agent_memory LIMIT 0`,
    );
    // Iterative HNSW scanning is a production correctness requirement for
    // selective filters. Failing readiness is safer than silently under-recall
    // on a pre-0.8 pgvector deployment.
    await query(`SELECT current_setting('hnsw.iterative_scan')`);
    await query(`SELECT request_hash, result FROM memory_feedback LIMIT 0`);
    await query(`SELECT request_hash, result FROM memory_conflict_resolution LIMIT 0`);
    await query(`SELECT request_hash, operation_type, actor, reason, parameters, result FROM memory_lifecycle_operation LIMIT 0`);
    await query(`SELECT quota_day, bucket, subject, count FROM api_daily_quota LIMIT 0`);
  }

  async getMemoryForFeedback(
    memoryId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<FeedbackTarget | null> {
    const rows = await query<PgRow & { superseded_at: string | Date | null }>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
              created_at, importance, superseded_at, 0 AS distance
         FROM agent_memory
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenantId, memoryId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...baseMemoryRecord(row),
      importance: Number(row.importance),
      supersededAt: toIsoOrNull(row.superseded_at),
    };
  }

  async getFeedback(
    feedbackId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<FeedbackLookup | null> {
    const rows = await query<{ request_hash: string | null; result: FeedbackResult | null }>(
      `SELECT request_hash, result FROM memory_feedback WHERE tenant_id = $1 AND feedback_id = $2`,
      [tenantId, feedbackId],
    );
    const row = rows[0];
    return row ? { requestHash: row.request_hash, result: row.result } : null;
  }

  async applyFeedback(input: FeedbackWrite): Promise<FeedbackResult> {
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const claimed = await client.query<{ feedback_id: string }>(
          `INSERT INTO memory_feedback (tenant_id, feedback_id, request_hash, memory_id, outcome)
           VALUES ($1, $2, $3, $4::uuid, $5)
           ON CONFLICT (tenant_id, feedback_id) DO NOTHING
           RETURNING feedback_id`,
          [input.tenantId, input.feedbackId, input.requestHash, input.memoryId, input.outcome],
        );
        if (claimed.rows.length === 0) {
          const existing = await client.query<{
            memory_id: string;
            outcome: FeedbackOutcome;
            request_hash: string | null;
            result: FeedbackResult | null;
          }>(
            `SELECT memory_id, outcome, request_hash, result
               FROM memory_feedback WHERE tenant_id = $1 AND feedback_id = $2`,
            [input.tenantId, input.feedbackId],
          );
          const prior = existing.rows[0];
          if (
            !prior ||
            prior.memory_id !== input.memoryId ||
            prior.outcome !== input.outcome ||
            prior.request_hash !== input.requestHash
          ) {
            throw Object.assign(new Error("feedback id was already used for a different request"), { statusCode: 409 });
          }
          const result = prior.result;
          if (!result) throw Object.assign(new Error("feedback operation is still pending"), { statusCode: 409 });
          await client.query("COMMIT");
          return result;
        }

        const selected = await client.query<{
          importance: number | string;
          superseded_at: string | Date | null;
        }>(
          `SELECT importance, superseded_at
             FROM agent_memory
            WHERE tenant_id = $1 AND id = $2::uuid
            FOR UPDATE`,
          [input.tenantId, input.memoryId],
        );
        const target = selected.rows[0];
        if (!target) throw Object.assign(new Error("memory not found in this tenant"), { statusCode: 404 });
        if (target.superseded_at) throw Object.assign(new Error("memory is already superseded"), { statusCode: 409 });
        const before = { importance: Number(target.importance), supersededAt: null };

        let correctedMemoryId: string | null = null;
        let after: FeedbackResult["after"];
        if (input.outcome === "correct") {
          const updated = await client.query<{ importance: number | string }>(
            `UPDATE agent_memory SET importance = GREATEST(importance, 0.95)
              WHERE tenant_id = $1 AND id = $2::uuid
              RETURNING importance`,
            [input.tenantId, input.memoryId],
          );
          after = { importance: Number(updated.rows[0]!.importance), supersededAt: null, supersededBy: null };
        } else {
          if (!input.correction) throw Object.assign(new Error("incorrect feedback requires a corrected fact"), { statusCode: 400 });
          const m = input.correction;
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO agent_memory
               (tenant_id, kind, company, company_key, period, source_ref, content, metadata,
                embedding, embed_model, importance, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, $12)
             ON CONFLICT (tenant_id, idempotency_key)
               WHERE idempotency_key IS NOT NULL
             DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
               WHERE agent_memory.kind = EXCLUDED.kind
                 AND agent_memory.company_key = EXCLUDED.company_key
                 AND agent_memory.period IS NOT DISTINCT FROM EXCLUDED.period
                 AND agent_memory.source_ref IS NOT DISTINCT FROM EXCLUDED.source_ref
                 AND agent_memory.content = EXCLUDED.content
                 AND agent_memory.metadata IS NOT DISTINCT FROM EXCLUDED.metadata
                 AND agent_memory.importance = EXCLUDED.importance
             RETURNING id`,
            [
              input.tenantId, m.kind, m.company ?? "_global", companyKey(m.company), m.period ?? null,
              m.sourceRef ?? null, m.content, m.metadata ? JSON.stringify(m.metadata) : null,
              toVectorLiteral(m.embedding), m.embedModel, 0.95, m.idempotencyKey,
            ],
          );
          const correctionRow = inserted.rows[0];
          if (!correctionRow) {
            throw Object.assign(new Error("correction idempotency key was used for a different logical memory"), { statusCode: 409 });
          }
          correctedMemoryId = correctionRow.id;
          const updated = await client.query<{ importance: number | string; superseded_at: string | Date }>(
            `UPDATE agent_memory
                SET superseded_at = now(), superseded_by = $3::uuid
              WHERE tenant_id = $1 AND id = $2::uuid
              RETURNING importance, superseded_at`,
            [input.tenantId, input.memoryId, correctedMemoryId],
          );
          after = {
            importance: Number(updated.rows[0]!.importance),
            supersededAt: toIsoOrNull(updated.rows[0]!.superseded_at),
            supersededBy: correctedMemoryId,
          };
        }

        const result: FeedbackResult = {
          feedbackId: input.feedbackId,
          memoryId: input.memoryId,
          outcome: input.outcome,
          correctedMemoryId,
          before,
          after,
        };
        await client.query(
          `UPDATE memory_feedback
              SET correction_id = $3::uuid, result = $4::jsonb, completed_at = now()
            WHERE tenant_id = $1 AND feedback_id = $2`,
          [input.tenantId, input.feedbackId, correctedMemoryId, JSON.stringify(result)],
        );
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });
  }

  async resolveConflict(input: ConflictResolutionWrite): Promise<ConflictResolutionResult> {
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const targets = [...new Set(input.targetMemoryIds)].sort();
        const claimed = await client.query<{ decision_id: string }>(
          `INSERT INTO memory_conflict_resolution
             (tenant_id, decision_id, request_hash, subject, attribute,
              selected_memory_id, target_memory_ids, actor, reason)
           VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::uuid[], $8, $9)
           ON CONFLICT (tenant_id, decision_id) DO NOTHING
           RETURNING decision_id`,
          [
            input.tenantId, input.decisionId, input.requestHash, input.subject, input.attribute,
            input.selectedMemoryId, targets, input.actor, input.reason,
          ],
        );
        if (claimed.rows.length === 0) {
          const existing = await client.query<{
            request_hash: string;
            subject: string;
            attribute: string;
            selected_memory_id: string;
            target_memory_ids: string[];
            actor: string | null;
            reason: string | null;
            result: ConflictResolutionResult | null;
          }>(
            `SELECT request_hash, subject, attribute, selected_memory_id, target_memory_ids, actor, reason, result
               FROM memory_conflict_resolution
              WHERE tenant_id = $1 AND decision_id = $2
              FOR UPDATE`,
            [input.tenantId, input.decisionId],
          );
          const prior = existing.rows[0];
          if (
            !prior || prior.request_hash !== input.requestHash || prior.subject !== input.subject ||
            prior.attribute !== input.attribute || prior.selected_memory_id !== input.selectedMemoryId ||
            !sameStringSet(prior.target_memory_ids, targets) || prior.actor !== input.actor || prior.reason !== input.reason
          ) {
            throw Object.assign(new Error("decision id was already used for a different request"), { statusCode: 409 });
          }
          if (!prior.result) throw Object.assign(new Error("conflict decision is still pending"), { statusCode: 409 });
          await client.query("COMMIT");
          return prior.result;
        }

        // Read the selected row only to establish its tenant-owned scope. The
        // subsequent scope query locks every active carrier in deterministic id
        // order, so competing decisions serialize without split-brain updates.
        const selectedRows = await client.query<PgRow & { importance: string | number; superseded_at: string | Date | null }>(
          `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
                  created_at, importance, superseded_at, 0 AS distance
             FROM agent_memory
            WHERE tenant_id = $1 AND id = $2::uuid`,
          [input.tenantId, input.selectedMemoryId],
        );
        const selectedScope = selectedRows.rows[0];
        if (!selectedScope) throw Object.assign(new Error("one or more conflict memories are unavailable in this tenant"), { statusCode: 404 });

        const locked = await client.query<PgRow & { importance: string | number; superseded_at: null }>(
          `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
                  created_at, importance, superseded_at, 0 AS distance
             FROM agent_memory
            WHERE tenant_id = $1
              AND company_key = $2
              AND period IS NOT DISTINCT FROM $3
              AND COALESCE(NULLIF(metadata->>'record', ''), source_ref) = $4
              AND superseded_at IS NULL
            ORDER BY id
            FOR UPDATE`,
          [input.tenantId, companyKey(selectedScope.company), selectedScope.period, input.subject],
        );
        const scoped: AuditMemory[] = locked.rows.map((row) => ({
          ...baseMemoryRecord(row),
          importance: Number(row.importance),
        }));
        const selected = scoped.find((row) => row.id === input.selectedMemoryId);
        if (!selected || subjectKey(selected) !== input.subject) {
          throw Object.assign(new Error("selected memory is stale or outside the declared conflict scope"), { statusCode: 409 });
        }
        const carriers = scoped.filter((row) => Object.prototype.hasOwnProperty.call(row.metadata ?? {}, input.attribute));
        if (!carriers.some((row) => row.id === input.selectedMemoryId)) {
          throw Object.assign(new Error("selected memory is outside the disputed scope or does not carry the disputed attribute"), { statusCode: 409 });
        }
        const expectedTargets = carriers.filter((row) => row.id !== input.selectedMemoryId).map((row) => row.id).sort();
        if (!sameStringSet(targets, expectedTargets)) {
          throw Object.assign(new Error("target set must contain every active non-selected conflict carrier"), { statusCode: 409 });
        }
        const finding = auditConsistency(carriers).contradictions.find(
          (candidate) => candidate.subject === input.subject && candidate.attribute === input.attribute,
        );
        if (!finding) throw Object.assign(new Error("declared active memories do not form this contradiction"), { statusCode: 409 });

        const protectedSelected = await client.query<{ importance: string | number }>(
          `UPDATE agent_memory
              SET importance = GREATEST(importance, 0.95)
            WHERE tenant_id = $1 AND id = $2::uuid AND superseded_at IS NULL
            RETURNING importance`,
          [input.tenantId, input.selectedMemoryId],
        );
        if (protectedSelected.rows.length !== 1) throw Object.assign(new Error("selected memory became stale"), { statusCode: 409 });
        const superseded = await client.query<{ id: string }>(
          `UPDATE agent_memory
              SET superseded_at = now(), superseded_by = $3::uuid
            WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND superseded_at IS NULL
            RETURNING id`,
          [input.tenantId, targets, input.selectedMemoryId],
        );
        const supersededIds = superseded.rows.map((row) => row.id).sort();
        if (!sameStringSet(supersededIds, targets)) throw Object.assign(new Error("conflict target became stale"), { statusCode: 409 });
        const result: ConflictResolutionResult = {
          decisionId: input.decisionId,
          subject: input.subject,
          attribute: input.attribute,
          selectedMemoryId: input.selectedMemoryId,
          supersededMemoryIds: supersededIds,
          actor: input.actor,
          reason: input.reason,
          before: { activeCarriers: carriers.length, selectedImportance: Number(selected.importance ?? 0.5) },
          after: { activeCarriers: 1, selectedImportance: Number(protectedSelected.rows[0]!.importance) },
          resolvedAt: new Date().toISOString(),
        };
        await client.query(
          `UPDATE memory_conflict_resolution
              SET result = $3::jsonb, completed_at = now()
            WHERE tenant_id = $1 AND decision_id = $2`,
          [input.tenantId, input.decisionId, JSON.stringify(result)],
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async clear(): Promise<void> {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`DELETE FROM memory_conflict_resolution`);
        await client.query(`DELETE FROM memory_feedback`);
        await client.query(`DELETE FROM memory_lifecycle_operation`);
        await client.query(`DELETE FROM agent_memory`);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });
  }

  async listForConsolidation(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ConsolidatableMemory[]> {
    const rows = company
      ? await query<{ id: string; kind: string; company: string; period: string | null; content: string; embedding: string; importance: string; created_at: string | Date }>(
          `SELECT id, kind, company, period, content, embedding::text AS embedding, importance, created_at
             FROM agent_memory WHERE tenant_id = $1 AND superseded_at IS NULL AND company_key = $2`,
          [tenantId, companyKey(company)]
        )
      : await query<{ id: string; kind: string; company: string; period: string | null; content: string; embedding: string; importance: string; created_at: string | Date }>(
          `SELECT id, kind, company, period, content, embedding::text AS embedding, importance, created_at
             FROM agent_memory WHERE tenant_id = $1 AND superseded_at IS NULL`,
          [tenantId]
        );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      company: r.company,
      period: r.period,
      content: r.content,
      embedding: parseVector(r.embedding),
      importance: Number(r.importance),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  async supersede(loserIds: string[], winnerId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<number> {
    if (loserIds.length === 0) return 0;
    const rows = await query<{ id: string }>(
      `UPDATE agent_memory
          SET superseded_at = now(), superseded_by = $1
        WHERE tenant_id = $3 AND id = ANY($2::uuid[]) AND superseded_at IS NULL
        RETURNING id`,
      [winnerId, loserIds, tenantId]
    );
    return rows.length;
  }

  private async claimLifecycle<T extends ConsolidationAtomicResult | ForgetAtomicResult>(
    client: PoolClient,
    opts: LifecycleAtomicOptions,
    operationType: "consolidate" | "forget",
    parameters: Record<string, unknown>,
  ): Promise<T | null> {
    const claimed = await client.query<{ operation_id: string }>(
      `INSERT INTO memory_lifecycle_operation
         (tenant_id, operation_id, request_hash, operation_type, actor, reason, parameters)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (tenant_id, operation_id) DO NOTHING
       RETURNING operation_id`,
      [
        opts.tenantId, opts.operationId, opts.requestHash, operationType,
        opts.actor, opts.reason, JSON.stringify(parameters),
      ],
    );
    if (claimed.rows.length === 1) return null;
    const existing = await client.query<{
      request_hash: string;
      operation_type: string;
      actor: string;
      reason: string;
      result: T | null;
    }>(
      `SELECT request_hash, operation_type, actor, reason, result
         FROM memory_lifecycle_operation
        WHERE tenant_id = $1 AND operation_id = $2
        FOR UPDATE`,
      [opts.tenantId, opts.operationId],
    );
    const prior = existing.rows[0];
    if (
      !prior || prior.request_hash !== opts.requestHash || prior.operation_type !== operationType ||
      prior.actor !== opts.actor || prior.reason !== opts.reason
    ) {
      throw Object.assign(new Error("lifecycle operation id was already used for a different request"), { statusCode: 409 });
    }
    if (!prior.result) throw Object.assign(new Error("lifecycle operation is still pending"), { statusCode: 409 });
    return prior.result;
  }

  private async completeLifecycle(
    client: PoolClient,
    opts: LifecycleAtomicOptions,
    result: ConsolidationAtomicResult | ForgetAtomicResult,
  ): Promise<void> {
    const updated = await client.query<{ operation_id: string }>(
      `UPDATE memory_lifecycle_operation
          SET result = $3::jsonb, completed_at = $4::timestamptz
        WHERE tenant_id = $1 AND operation_id = $2 AND result IS NULL
        RETURNING operation_id`,
      [opts.tenantId, opts.operationId, JSON.stringify(result), result.audit.completedAt],
    );
    if (updated.rows.length !== 1) throw new Error("lifecycle audit result could not be persisted");
  }

  async consolidateAtomic(opts: LifecycleAtomicOptions & { threshold: number }): Promise<ConsolidationAtomicResult> {
    const candidateCap = configuredLifecycleCandidateCap(opts.candidateCap);
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const parameters = {
          companyKey: opts.company ? companyKey(opts.company) : null,
          threshold: opts.threshold,
          candidateCap,
          embedModel: opts.embedModel ?? null,
        };
        if (!opts.dryRun) {
          const replay = await this.claimLifecycle<ConsolidationAtomicResult>(client, opts, "consolidate", parameters);
          if (replay) {
            await client.query("COMMIT");
            return replay;
          }
        }
        const params: unknown[] = [opts.tenantId];
        const companySql = opts.company ? (params.push(companyKey(opts.company)), ` AND company_key = $${params.length}`) : "";
        const modelSql = opts.embedModel ? (params.push(opts.embedModel), ` AND embed_model = $${params.length}`) : "";
        params.push(candidateCap + 1);
        const limitSql = `$${params.length}`;
        const locked = await client.query<{
          id: string; kind: string; company: string; period: string | null; content: string;
          embedding: string; importance: string | number; created_at: string | Date;
        }>(
          `SELECT id, kind, company, period, content, embedding::text AS embedding, importance, created_at
             FROM agent_memory
            WHERE tenant_id = $1 AND superseded_at IS NULL${companySql}${modelSql}
            ORDER BY id
            LIMIT ${limitSql}
            FOR UPDATE`,
          params,
        );
        if (locked.rows.length > candidateCap) throw lifecycleScopeTooLarge(candidateCap);
        const memories: ConsolidatableMemory[] = locked.rows.map((row) => ({
          id: row.id, kind: row.kind, company: row.company, period: row.period,
          content: row.content, embedding: parseVector(row.embedding), importance: Number(row.importance),
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        }));
        // Planning happens AFTER the locks. Feedback that committed first is
        // reflected in importance; feedback that starts later waits and then
        // observes a superseded target instead of racing this decision.
        const plan = planConsolidation(memories, opts.threshold);
        if (opts.dryRun) {
          const result: ConsolidationAtomicResult = {
            clusters: plan.groups.length, planned: plan.supersededCount, superseded: 0, dryRun: true,
            scanned: memories.length, candidateCap, truncated: false,
            audit: lifecycleAudit(opts, false),
          };
          await client.query("COMMIT");
          return result;
        }
        let superseded = 0;
        for (const group of plan.groups) {
          const changed = await client.query<{ id: string }>(
            `UPDATE agent_memory
                SET superseded_at = now(), superseded_by = $3::uuid
              WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND superseded_at IS NULL
              RETURNING id`,
            [opts.tenantId, group.losers, group.winner],
          );
          if (changed.rows.length !== group.losers.length) throw Object.assign(new Error("consolidation scope changed during transaction"), { statusCode: 409 });
          superseded += changed.rows.length;
        }
        const result: ConsolidationAtomicResult = {
          clusters: plan.groups.length, planned: plan.supersededCount, superseded, dryRun: false,
          scanned: memories.length, candidateCap, truncated: false,
          audit: lifecycleAudit(opts, true),
        };
        await this.completeLifecycle(client, opts, result);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async listForForget(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ForgetCandidate[]> {
    const rows = company
      ? await query<{ id: string; importance: string; created_at: string | Date; superseded_at: string | null }>(
          `SELECT id, importance, created_at, superseded_at FROM agent_memory WHERE tenant_id = $1 AND company_key = $2`,
          [tenantId, companyKey(company)]
        )
      : await query<{ id: string; importance: string; created_at: string | Date; superseded_at: string | null }>(
          `SELECT id, importance, created_at, superseded_at FROM agent_memory WHERE tenant_id = $1`,
          [tenantId]
        );
    return rows.map((r) => ({
      id: r.id,
      importance: Number(r.importance),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      supersededAt: r.superseded_at,
    }));
  }

  async deleteMemories(ids: string[], tenantId: string = DEFAULT_TENANT_ID): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await query<{ id: string }>(
      `DELETE FROM agent_memory WHERE tenant_id = $2 AND id = ANY($1::uuid[]) RETURNING id`,
      [ids, tenantId]
    );
    return rows.length;
  }

  async forgetAtomic(opts: LifecycleAtomicOptions & { policy: ForgetPolicy; now?: Date }): Promise<ForgetAtomicResult> {
    const candidateCap = configuredLifecycleCandidateCap(opts.candidateCap);
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const parameters = {
          companyKey: opts.company ? companyKey(opts.company) : null,
          policy: opts.policy,
          candidateCap,
        };
        if (!opts.dryRun) {
          const replay = await this.claimLifecycle<ForgetAtomicResult>(client, opts, "forget", parameters);
          if (replay) {
            await client.query("COMMIT");
            return replay;
          }
        }
        const params: unknown[] = [opts.tenantId];
        const companySql = opts.company ? (params.push(companyKey(opts.company)), ` AND company_key = $${params.length}`) : "";
        params.push(candidateCap + 1);
        const limitSql = `$${params.length}`;
        const locked = await client.query<{
          id: string; importance: string | number; created_at: string | Date; superseded_at: string | Date | null;
        }>(
          `SELECT id, importance, created_at, superseded_at
             FROM agent_memory
            WHERE tenant_id = $1${companySql}
            ORDER BY id
            LIMIT ${limitSql}
            FOR UPDATE`,
          params,
        );
        if (locked.rows.length > candidateCap) throw lifecycleScopeTooLarge(candidateCap);
        const candidates: ForgetCandidate[] = locked.rows.map((row) => ({
          id: row.id,
          importance: Number(row.importance),
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
          supersededAt: toIsoOrNull(row.superseded_at),
        }));
        const ids = planForget(candidates, opts.policy, opts.now);
        if (opts.dryRun) {
          const result: ForgetAtomicResult = {
            candidates: ids.length, forgotten: 0, dryRun: true,
            scanned: candidates.length, candidateCap, truncated: false,
            audit: lifecycleAudit(opts, false),
          };
          await client.query("COMMIT");
          return result;
        }
        const deleted = ids.length
          ? await client.query<{ id: string }>(
              `DELETE FROM agent_memory WHERE tenant_id = $1 AND id = ANY($2::uuid[]) RETURNING id`,
              [opts.tenantId, ids],
            )
          : { rows: [] as Array<{ id: string }> };
        if (deleted.rows.length !== ids.length) throw Object.assign(new Error("forget scope changed during transaction"), { statusCode: 409 });
        const result: ForgetAtomicResult = {
          candidates: ids.length, forgotten: deleted.rows.length, dryRun: false,
          scanned: candidates.length, candidateCap, truncated: false,
          audit: lifecycleAudit(opts, true),
        };
        await this.completeLifecycle(client, opts, result);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  // Read-only audit read. Only ACTIVE (non-superseded) rows, only existing
  // columns — safe against the live table (DEPLOY_STATE.md: a new column 500s).
  async listForAudit(
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind; limit?: number } = {}
  ): Promise<AuditMemory[]> {
    const params: unknown[] = [scope.tenantId ?? DEFAULT_TENANT_ID];
    const filters = ["tenant_id = $1", "superseded_at IS NULL"];
    if (scope.company) {
      params.push(companyKey(scope.company));
      filters.push(`company_key = $${params.length}`);
    }
    if (scope.period) {
      params.push(scope.period);
      filters.push(`period = $${params.length}`);
    }
    if (scope.kind) {
      params.push(scope.kind);
      filters.push(`kind = $${params.length}`);
    }
    const limit = scope.limit == null ? null : Math.max(1, Math.min(Math.trunc(scope.limit), 1_001));
    if (limit != null) params.push(limit);
    const rows = await query<PgRow>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata, created_at,
              importance, 0 AS distance
         FROM agent_memory
        WHERE ${filters.join(" AND ")}
        ${limit != null ? `ORDER BY created_at DESC, id LIMIT $${params.length}` : ""}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      company: r.company,
      period: r.period,
      sourceRef: r.source_ref,
      content: r.content,
      metadata: r.metadata,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      importance: r.importance == null ? null : Number(r.importance),
    }));
  }

  async listForSemanticAudit(
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind; limit?: number; embedModel?: string } = {},
  ): Promise<SemanticAuditMemory[]> {
    const params: unknown[] = [scope.tenantId ?? DEFAULT_TENANT_ID];
    const filters = ["tenant_id = $1", "superseded_at IS NULL"];
    if (scope.company) {
      params.push(companyKey(scope.company));
      filters.push(`company_key = $${params.length}`);
    }
    if (scope.period) {
      params.push(scope.period);
      filters.push(`period = $${params.length}`);
    }
    if (scope.kind) {
      params.push(scope.kind);
      filters.push(`kind = $${params.length}`);
    }
    if (scope.embedModel) {
      params.push(scope.embedModel);
      filters.push(`embed_model = $${params.length}`);
    }
    const limit = scope.limit == null ? null : Math.max(1, Math.min(Math.trunc(scope.limit), 501));
    if (limit != null) params.push(limit);
    const rows = await query<PgRow>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
              created_at, importance, embedding::text AS embedding, 0 AS distance
         FROM agent_memory
        WHERE ${filters.join(" AND ")}
        ${limit != null ? `ORDER BY created_at DESC, id LIMIT $${params.length}` : ""}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      company: r.company,
      period: r.period,
      sourceRef: r.source_ref,
      content: r.content,
      metadata: r.metadata,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      importance: r.importance == null ? null : Number(r.importance),
      embedding: parseVector(r.embedding!),
    }));
  }
}

// Shared row shape + mappers for the pgvector store.
interface PgRow {
  id: string;
  tenant_id: string;
  kind: MemoryKind;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
  distance: string | number;
  importance?: string | number | null; // present only on the audit SELECT
  embedding?: string; // present only on the hybrid lexical SELECT (embedding::text)
}

function rowToHitByDistance(r: PgRow): RecallHit {
  const distance = Number(r.distance);
  return baseHit(r, distance, 1 - distance);
}
// Hybrid hit: `score` is the REAL cosine similarity; `rrfScore` is the fusion value
// that actually decided this hit's rank (ordering is done upstream by RRF).
function rowToHitHybrid(r: PgRow, cosine: number, rrfScore: number): RecallHit {
  return { ...baseHit(r, 1 - cosine, cosine), rrfScore };
}
function baseHit(r: PgRow, distance: number, score: number): RecallHit {
  return {
    ...baseMemoryRecord(r),
    distance,
    score,
  };
}

function baseMemoryRecord(r: PgRow): MemoryRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    company: r.company,
    period: r.period,
    sourceRef: r.source_ref,
    content: r.content,
    metadata: r.metadata,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function toIsoOrNull(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseVector(literal: string): number[] {
  return literal.replace(/^\[|\]$/g, "").split(",").map(Number);
}

function clampImportance(v: number | undefined): number {
  if (v == null || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function companyKey(company: string | undefined): string {
  const key = canonicalBusinessLabel(company ?? "_global");
  return key || "_global";
}

function lifecycleAudit(opts: LifecycleAtomicOptions, persisted: boolean): LifecycleAuditProvenance {
  return {
    operationId: opts.operationId,
    actor: opts.actor,
    reason: opts.reason,
    persisted,
    completedAt: persisted ? new Date().toISOString() : null,
  };
}

function lifecycleScopeTooLarge(candidateCap: number): Error & { statusCode: number; code: string } {
  return Object.assign(
    new Error(`lifecycle scope exceeds candidate cap ${candidateCap}; use a narrower company scope`),
    { statusCode: 409, code: "scope_too_large" },
  );
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

// ── In-memory store (unit tests — no DB, no creds) ────────────────────────────
// Same cosine-distance ranking as pgvector's `<=>`, computed over plain arrays,
// so the memory logic (filter + top-k ordering) is verifiable with zero infra.
interface MemRow extends MemoryRecord {
  embedding: number[];
  embedModel: string;
  importance: number;
  supersededAt: string | null;
  idempotencyKey: string | null;
}

export class InMemoryStore implements MemoryStore {
  private rows: MemRow[] = [];
  private feedback = new Map<string, { requestHash: string; result: FeedbackResult }>();
  private conflictResolutions = new Map<string, { requestHash: string; result: ConflictResolutionResult }>();
  private lifecycleOperations = new Map<string, {
    requestHash: string;
    result: ConsolidationAtomicResult | ForgetAtomicResult;
  }>();

  async remember(m: StoredMemory): Promise<string> {
    return (await this.rememberMany([m]))[0]!;
  }

  async rememberMany(memories: StoredMemory[]): Promise<string[]> {
    const staged: MemRow[] = [];
    const ids: string[] = [];
    for (const m of memories) {
      const tenantId = m.tenantId ?? DEFAULT_TENANT_ID;
      const idempotencyKey = m.idempotencyKey ?? null;
      const existing = idempotencyKey
        ? [...this.rows, ...staged].find((r) => r.tenantId === tenantId && r.idempotencyKey === idempotencyKey)
        : undefined;
      if (existing) {
        if (!sameLogicalMemory(existing, m)) {
          throw Object.assign(new Error("idempotency key was already used for a different logical memory"), { statusCode: 409 });
        }
        ids.push(existing.id);
        continue;
      }
      const id = randomUUID();
      staged.push({
        id,
        tenantId,
        kind: m.kind,
        company: m.company ?? "_global",
        period: m.period ?? null,
        sourceRef: m.sourceRef ?? null,
        content: m.content,
        metadata: m.metadata ?? null,
        createdAt: new Date().toISOString(),
        embedding: m.embedding,
        embedModel: m.embedModel,
        importance: clampImportance(m.importance),
        supersededAt: null,
        idempotencyKey,
      });
      ids.push(id);
    }
    this.rows.push(...staged);
    return ids;
  }

  private scope(opts: RecallOptions): MemRow[] {
    return this.rows
      .filter((r) => r.tenantId === (opts.tenantId ?? DEFAULT_TENANT_ID))
      .filter((r) => (opts.includeSuperseded ? true : r.supersededAt === null))
      .filter((r) => (opts.kind ? r.kind === opts.kind : true))
      .filter((r) => (opts.company ? companyKey(r.company) === companyKey(opts.company) : true))
      .filter((r) => (opts.embedModel ? r.embedModel === opts.embedModel : true));
  }

  async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const scoped = this.scope(opts);

    if (opts.hybrid && opts.queryText) {
      // Real cosine similarity per candidate (reused for dense ranking AND the hit
      // score), so the returned `score` is a true cosine — RRF only sets ORDER.
      const cosineById = new Map(scoped.map((r) => [r.id, cosineSimilarity(queryVec, r.embedding)]));
      const dense = topK(
        scoped.map((r) => ({ id: r.id, score: cosineById.get(r.id)! })),
        POOL_K
      );
      const bm25 = new BM25(scoped.map((r) => ({ id: r.id, content: r.content })));
      const lexical = topK(bm25.scoreAll(opts.queryText), POOL_K);
      const fused = rrfFuse([dense, lexical]);
      const rrfById = new Map(fused.map((f) => [f.id, f.score]));
      const byId = new Map(scoped.map((r) => [r.id, r]));
      return topK(fused, limit).map((id) => {
        const r = byId.get(id)!;
        const cosine = cosineById.get(id) ?? 0;
        return { ...toHit(r, 1 - cosine, cosine), rrfScore: rrfById.get(id) ?? 0 };
      });
    }

    return scoped
      .map((r) => {
        const distance = cosineDistance(queryVec, r.embedding);
        return toHit(r, distance, 1 - distance);
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  async count(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<number> {
    return this.rows.filter((r) =>
      r.tenantId === tenantId && (company ? companyKey(r.company) === companyKey(company) : true)
    ).length;
  }

  async ready(): Promise<void> {
    // In-memory implementation is always ready.
  }

  async getMemoryForFeedback(
    memoryId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<FeedbackTarget | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === memoryId);
    if (!row) return null;
    const { embedding: _embedding, embedModel: _embedModel, idempotencyKey: _idempotencyKey, ...record } = row;
    return {
      ...record,
      importance: row.importance,
      supersededAt: row.supersededAt,
    };
  }

  async getFeedback(
    feedbackId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<FeedbackLookup | null> {
    const existing = this.feedback.get(`${tenantId}:${feedbackId}`);
    return existing
      ? { requestHash: existing.requestHash, result: structuredClone(existing.result) }
      : null;
  }

  async applyFeedback(input: FeedbackWrite): Promise<FeedbackResult> {
    const feedbackKey = `${input.tenantId}:${input.feedbackId}`;
    const existing = this.feedback.get(feedbackKey);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw Object.assign(new Error("feedback id was already used for a different request"), { statusCode: 409 });
      }
      return structuredClone(existing.result);
    }
    const row = this.rows.find((r) => r.tenantId === input.tenantId && r.id === input.memoryId);
    if (!row) throw Object.assign(new Error("memory not found in this tenant"), { statusCode: 404 });
    if (row.supersededAt) throw Object.assign(new Error("memory is already superseded"), { statusCode: 409 });
    const before = { importance: row.importance, supersededAt: row.supersededAt };
    let correctedMemoryId: string | null = null;
    if (input.outcome === "correct") {
      row.importance = Math.max(row.importance, 0.95);
    } else {
      if (!input.correction) throw Object.assign(new Error("incorrect feedback requires a corrected fact"), { statusCode: 400 });
      correctedMemoryId = (await this.rememberMany([{ ...input.correction, tenantId: input.tenantId }]))[0]!;
      row.supersededAt = new Date().toISOString();
      (row as MemRow & { supersededBy?: string }).supersededBy = correctedMemoryId;
    }
    const result: FeedbackResult = {
      feedbackId: input.feedbackId,
      memoryId: input.memoryId,
      outcome: input.outcome,
      correctedMemoryId,
      before,
      after: {
        importance: row.importance,
        supersededAt: row.supersededAt,
        supersededBy: correctedMemoryId,
      },
    };
    this.feedback.set(feedbackKey, { requestHash: input.requestHash, result: structuredClone(result) });
    return result;
  }

  // Test seam invoked after in-memory row changes but before the durable result
  // is published. The base implementation is inert; a fault-injection subclass
  // proves the snapshot rollback leaves no partial conflict resolution.
  protected beforeConflictResolutionCommit(_input: ConflictResolutionWrite): void {}

  async resolveConflict(input: ConflictResolutionWrite): Promise<ConflictResolutionResult> {
    const key = `${input.tenantId}:${input.decisionId}`;
    const existing = this.conflictResolutions.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw Object.assign(new Error("decision id was already used for a different request"), { statusCode: 409 });
      }
      return structuredClone(existing.result);
    }
    const targets = [...new Set(input.targetMemoryIds)].sort();
    const selected = this.rows.find((row) =>
      row.tenantId === input.tenantId && row.id === input.selectedMemoryId && row.supersededAt === null
    );
    if (!selected) throw Object.assign(new Error("selected memory is stale or unavailable in this tenant"), { statusCode: 409 });
    const scoped = this.rows.filter((row) =>
      row.tenantId === input.tenantId && companyKey(row.company) === companyKey(selected.company) && row.period === selected.period &&
      row.supersededAt === null && subjectKey(row) === input.subject
    );
    const carriers = scoped.filter((row) => Object.prototype.hasOwnProperty.call(row.metadata ?? {}, input.attribute));
    if (!carriers.some((row) => row.id === input.selectedMemoryId)) {
      throw Object.assign(new Error("selected memory is outside the disputed scope or does not carry the disputed attribute"), { statusCode: 409 });
    }
    const expectedTargets = carriers.filter((row) => row.id !== input.selectedMemoryId).map((row) => row.id).sort();
    if (!sameStringSet(targets, expectedTargets)) {
      throw Object.assign(new Error("target set must contain every active non-selected conflict carrier"), { statusCode: 409 });
    }
    const finding = auditConsistency(carriers).contradictions.find(
      (candidate) => candidate.subject === input.subject && candidate.attribute === input.attribute,
    );
    if (!finding) throw Object.assign(new Error("declared active memories do not form this contradiction"), { statusCode: 409 });

    const rowsBefore = structuredClone(this.rows);
    const resolutionsBefore = new Map(this.conflictResolutions);
    try {
      const beforeImportance = selected.importance;
      selected.importance = Math.max(selected.importance, 0.95);
      const at = new Date().toISOString();
      for (const row of this.rows) {
        if (row.tenantId === input.tenantId && targets.includes(row.id) && row.supersededAt === null) {
          row.supersededAt = at;
          (row as MemRow & { supersededBy?: string }).supersededBy = selected.id;
        }
      }
      this.beforeConflictResolutionCommit(input);
      const result: ConflictResolutionResult = {
        decisionId: input.decisionId,
        subject: input.subject,
        attribute: input.attribute,
        selectedMemoryId: selected.id,
        supersededMemoryIds: targets,
        actor: input.actor,
        reason: input.reason,
        before: { activeCarriers: carriers.length, selectedImportance: beforeImportance },
        after: { activeCarriers: 1, selectedImportance: selected.importance },
        resolvedAt: at,
      };
      this.conflictResolutions.set(key, { requestHash: input.requestHash, result: structuredClone(result) });
      return result;
    } catch (error) {
      this.rows = rowsBefore;
      this.conflictResolutions = resolutionsBefore;
      throw error;
    }
  }

  async clear(): Promise<void> {
    this.rows = [];
    this.feedback.clear();
    this.conflictResolutions.clear();
    this.lifecycleOperations.clear();
  }

  async listForConsolidation(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ConsolidatableMemory[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.supersededAt === null && (company ? companyKey(r.company) === companyKey(company) : true))
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        company: r.company,
        period: r.period,
        content: r.content,
        embedding: r.embedding,
        importance: r.importance,
        createdAt: r.createdAt,
      }));
  }

  async supersede(loserIds: string[], winnerId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<number> {
    const losers = new Set(loserIds);
    let n = 0;
    const at = new Date().toISOString();
    for (const r of this.rows) {
      if (r.tenantId === tenantId && losers.has(r.id) && r.supersededAt === null) {
        r.supersededAt = at;
        (r as MemRow & { supersededBy?: string }).supersededBy = winnerId;
        n++;
      }
    }
    return n;
  }

  async consolidateAtomic(opts: LifecycleAtomicOptions & { threshold: number }): Promise<ConsolidationAtomicResult> {
    const candidateCap = configuredLifecycleCandidateCap(opts.candidateCap);
    const operationKey = `${opts.tenantId}:${opts.operationId}`;
    if (!opts.dryRun) {
      const replay = this.lifecycleOperations.get(operationKey);
      if (replay) {
        if (replay.requestHash !== opts.requestHash) {
          throw Object.assign(new Error("lifecycle operation id was already used for a different request"), { statusCode: 409 });
        }
        return structuredClone(replay.result) as ConsolidationAtomicResult;
      }
    }
    const scoped = this.rows
      .filter((row) => row.tenantId === opts.tenantId && row.supersededAt === null)
      .filter((row) => (opts.company ? companyKey(row.company) === companyKey(opts.company) : true))
      .filter((row) => (opts.embedModel ? row.embedModel === opts.embedModel : true));
    if (scoped.length > candidateCap) throw lifecycleScopeTooLarge(candidateCap);
    const memories: ConsolidatableMemory[] = scoped
      .map((row) => ({
        id: row.id, kind: row.kind, company: row.company, period: row.period, content: row.content,
        embedding: row.embedding, importance: row.importance, createdAt: row.createdAt,
      }));
    const plan = planConsolidation(memories, opts.threshold);
    if (opts.dryRun) return {
      clusters: plan.groups.length, planned: plan.supersededCount, superseded: 0, dryRun: true,
      scanned: memories.length, candidateCap, truncated: false,
      audit: lifecycleAudit(opts, false),
    };
    let superseded = 0;
    const at = new Date().toISOString();
    for (const group of plan.groups) {
      for (const row of this.rows) {
        if (row.tenantId === opts.tenantId && group.losers.includes(row.id) && row.supersededAt === null) {
          row.supersededAt = at;
          (row as MemRow & { supersededBy?: string }).supersededBy = group.winner;
          superseded++;
        }
      }
    }
    const result: ConsolidationAtomicResult = {
      clusters: plan.groups.length, planned: plan.supersededCount, superseded, dryRun: false,
      scanned: memories.length, candidateCap, truncated: false,
      audit: lifecycleAudit(opts, true),
    };
    this.lifecycleOperations.set(operationKey, { requestHash: opts.requestHash, result: structuredClone(result) });
    return result;
  }

  async listForForget(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ForgetCandidate[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && (company ? companyKey(r.company) === companyKey(company) : true))
      .map((r) => ({
        id: r.id,
        importance: r.importance,
        createdAt: r.createdAt,
        supersededAt: r.supersededAt,
      }));
  }

  async deleteMemories(ids: string[], tenantId: string = DEFAULT_TENANT_ID): Promise<number> {
    const del = new Set(ids);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.tenantId !== tenantId || !del.has(r.id));
    return before - this.rows.length;
  }

  async forgetAtomic(opts: LifecycleAtomicOptions & { policy: ForgetPolicy; now?: Date }): Promise<ForgetAtomicResult> {
    const candidateCap = configuredLifecycleCandidateCap(opts.candidateCap);
    const operationKey = `${opts.tenantId}:${opts.operationId}`;
    if (!opts.dryRun) {
      const replay = this.lifecycleOperations.get(operationKey);
      if (replay) {
        if (replay.requestHash !== opts.requestHash) {
          throw Object.assign(new Error("lifecycle operation id was already used for a different request"), { statusCode: 409 });
        }
        return structuredClone(replay.result) as ForgetAtomicResult;
      }
    }
    const scoped = this.rows
      .filter((row) => row.tenantId === opts.tenantId && (opts.company ? companyKey(row.company) === companyKey(opts.company) : true));
    if (scoped.length > candidateCap) throw lifecycleScopeTooLarge(candidateCap);
    const candidates: ForgetCandidate[] = scoped
      .map((row) => ({ id: row.id, importance: row.importance, createdAt: row.createdAt, supersededAt: row.supersededAt }));
    const ids = planForget(candidates, opts.policy, opts.now);
    if (opts.dryRun) return {
      candidates: ids.length, forgotten: 0, dryRun: true,
      scanned: candidates.length, candidateCap, truncated: false,
      audit: lifecycleAudit(opts, false),
    };
    const remove = new Set(ids);
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.tenantId !== opts.tenantId || !remove.has(row.id));
    const result: ForgetAtomicResult = {
      candidates: ids.length, forgotten: before - this.rows.length, dryRun: false,
      scanned: candidates.length, candidateCap, truncated: false,
      audit: lifecycleAudit(opts, true),
    };
    this.lifecycleOperations.set(operationKey, { requestHash: opts.requestHash, result: structuredClone(result) });
    return result;
  }

  async listForAudit(
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind; limit?: number } = {}
  ): Promise<AuditMemory[]> {
    const rows = this.rows
      .filter((r) => r.tenantId === (scope.tenantId ?? DEFAULT_TENANT_ID))
      .filter((r) => r.supersededAt === null)
      .filter((r) => (scope.company ? companyKey(r.company) === companyKey(scope.company) : true))
      .filter((r) => (scope.period ? r.period === scope.period : true))
      .filter((r) => (scope.kind ? r.kind === scope.kind : true));
    const bounded = scope.limit == null
      ? rows
      : [...rows].sort((a, b) => a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, Math.max(1, Math.min(Math.trunc(scope.limit), 1_001)));
    return bounded
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        company: r.company,
        period: r.period,
        sourceRef: r.sourceRef,
        content: r.content,
        metadata: r.metadata,
        createdAt: r.createdAt,
        importance: r.importance,
      }));
  }

  async listForSemanticAudit(
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind; limit?: number; embedModel?: string } = {},
  ): Promise<SemanticAuditMemory[]> {
    const rows = this.rows
      .filter((r) => r.tenantId === (scope.tenantId ?? DEFAULT_TENANT_ID))
      .filter((r) => r.supersededAt === null)
      .filter((r) => (scope.company ? companyKey(r.company) === companyKey(scope.company) : true))
      .filter((r) => (scope.period ? r.period === scope.period : true))
      .filter((r) => (scope.kind ? r.kind === scope.kind : true))
      .filter((r) => (scope.embedModel ? r.embedModel === scope.embedModel : true));
    const bounded = scope.limit == null
      ? rows
      : [...rows].sort((a, b) => a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, Math.max(1, Math.min(Math.trunc(scope.limit), 501)));
    return bounded
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        company: r.company,
        period: r.period,
        sourceRef: r.sourceRef,
        content: r.content,
        metadata: r.metadata,
        createdAt: r.createdAt,
        importance: r.importance,
        embedding: [...r.embedding],
      }));
  }
}

function toHit(r: MemRow, distance: number, score: number): RecallHit {
  const { embedding, embedModel: _embedModel, importance, supersededAt, idempotencyKey, ...rec } = r;
  return { ...rec, distance, score };
}

// Cosine distance = 1 - cosine similarity, matching pgvector's `<=>` operator.
function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

function sameLogicalMemory(existing: MemRow, incoming: StoredMemory): boolean {
  return existing.kind === incoming.kind &&
    companyKey(existing.company) === companyKey(incoming.company) &&
    existing.period === (incoming.period ?? null) &&
    existing.sourceRef === (incoming.sourceRef ?? null) &&
    existing.content === incoming.content &&
    isDeepStrictEqual(existing.metadata, incoming.metadata ?? null) &&
    existing.importance === clampImportance(incoming.importance);
}
