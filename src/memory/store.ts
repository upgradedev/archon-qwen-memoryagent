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
import { query, toVectorLiteral, withClient } from "../db/client.js";
import { rrfFuse, topK, BM25, cosineSimilarity } from "./retrieval.js";
import type { ConsolidatableMemory, ForgetCandidate } from "./consolidation.js";
import type { AuditMemory } from "./consistency.js";

export type MemoryKind = "document" | "payroll_event" | "validation" | "insight" | "invoice" | "action";
export const DEFAULT_TENANT_ID = "_public";

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
  clear(): Promise<void>;
  // ── memory lifecycle (consolidation / forgetting) ──
  listForConsolidation(company?: string, tenantId?: string): Promise<ConsolidatableMemory[]>;
  supersede(loserIds: string[], winnerId: string, tenantId?: string): Promise<number>;
  listForForget(company?: string, tenantId?: string): Promise<ForgetCandidate[]>;
  deleteMemories(ids: string[], tenantId?: string): Promise<number>;
  // ── self-auditing (consistency) ──
  // Read-only: return ACTIVE memories in scope for a consistency audit. Selects
  // only columns that already exist (no schema change — the live table is safe).
  listForAudit(scope?: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind }): Promise<AuditMemory[]>;
  /** Active, tenant-scoped audit rows with their already-persisted embeddings. */
  listForSemanticAudit(scope?: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind }): Promise<SemanticAuditMemory[]>;
}

const POOL_K = 20; // depth of each ranked list fed into hybrid fusion

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
               (tenant_id, kind, company, period, source_ref, content, metadata,
                embedding, embed_model, importance, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11)
             ON CONFLICT (tenant_id, idempotency_key)
               WHERE idempotency_key IS NOT NULL
             DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
               WHERE agent_memory.kind = EXCLUDED.kind
                 AND agent_memory.company = EXCLUDED.company
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
      params.push(opts.company);
      filters.push(`company = $${params.length}`);
    }
    return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  }

  async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    if (opts.hybrid && opts.queryText) return this.recallHybrid(queryVec, opts, limit);

    const params: unknown[] = [toVectorLiteral(queryVec)];
    const where = this.scopeSql(opts, params);
    params.push(limit);
    const rows = await query<PgRow>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata, created_at,
              (embedding <=> $1::vector) AS distance
         FROM agent_memory
         ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $${params.length}`,
      params
    );
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
    const dParams: unknown[] = [toVectorLiteral(queryVec)];
    const dWhere = this.scopeSql(opts, dParams);
    dParams.push(POOL_K);
    const dense = await query<PgRow>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata, created_at,
              (embedding <=> $1::vector) AS distance
         FROM agent_memory ${dWhere}
       ORDER BY embedding <=> $1::vector LIMIT $${dParams.length}`,
      dParams
    );
    // Lexical pool (full-text ts_rank over the same scope). Pull the embedding too,
    // so a lexical-ONLY hit (not in the dense pool) still gets a REAL cosine rather
    // than a fake distance=0.
    const lParams: unknown[] = [opts.queryText!];
    const lWhere = this.scopeSql(opts, lParams);
    const lAnd = lWhere ? `${lWhere} AND` : "WHERE";
    lParams.push(POOL_K);
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
          `SELECT count(*) AS n FROM agent_memory WHERE tenant_id = $1 AND company = $2`,
          [tenantId, company]
        )
      : await query<{ n: string }>(`SELECT count(*) AS n FROM agent_memory WHERE tenant_id = $1`, [tenantId]);
    return Number(rows[0]!.n);
  }

  async ready(): Promise<void> {
    // Readiness is a post-migration contract, not merely a reachable socket.
    // LIMIT 0 verifies every column/type the live request paths depend on.
    await query(
      `SELECT tenant_id, importance, idempotency_key, embedding::text
         FROM agent_memory LIMIT 0`,
    );
    await query(`SELECT request_hash, result FROM memory_feedback LIMIT 0`);
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
               (tenant_id, kind, company, period, source_ref, content, metadata,
                embedding, embed_model, importance, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11)
             ON CONFLICT (tenant_id, idempotency_key)
               WHERE idempotency_key IS NOT NULL
             DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
               WHERE agent_memory.kind = EXCLUDED.kind
                 AND agent_memory.company = EXCLUDED.company
                 AND agent_memory.period IS NOT DISTINCT FROM EXCLUDED.period
                 AND agent_memory.source_ref IS NOT DISTINCT FROM EXCLUDED.source_ref
                 AND agent_memory.content = EXCLUDED.content
                 AND agent_memory.metadata IS NOT DISTINCT FROM EXCLUDED.metadata
                 AND agent_memory.importance = EXCLUDED.importance
             RETURNING id`,
            [
              input.tenantId, m.kind, m.company ?? "_global", m.period ?? null,
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

  async clear(): Promise<void> {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`DELETE FROM memory_feedback`);
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
             FROM agent_memory WHERE tenant_id = $1 AND superseded_at IS NULL AND company = $2`,
          [tenantId, company]
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

  async listForForget(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ForgetCandidate[]> {
    const rows = company
      ? await query<{ id: string; importance: string; created_at: string | Date; superseded_at: string | null }>(
          `SELECT id, importance, created_at, superseded_at FROM agent_memory WHERE tenant_id = $1 AND company = $2`,
          [tenantId, company]
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

  // Read-only audit read. Only ACTIVE (non-superseded) rows, only existing
  // columns — safe against the live table (DEPLOY_STATE.md: a new column 500s).
  async listForAudit(
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind } = {}
  ): Promise<AuditMemory[]> {
    const params: unknown[] = [scope.tenantId ?? DEFAULT_TENANT_ID];
    const filters = ["tenant_id = $1", "superseded_at IS NULL"];
    if (scope.company) {
      params.push(scope.company);
      filters.push(`company = $${params.length}`);
    }
    if (scope.period) {
      params.push(scope.period);
      filters.push(`period = $${params.length}`);
    }
    if (scope.kind) {
      params.push(scope.kind);
      filters.push(`kind = $${params.length}`);
    }
    const rows = await query<PgRow>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata, created_at,
              importance, 0 AS distance
         FROM agent_memory
        WHERE ${filters.join(" AND ")}`,
      params
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
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind } = {},
  ): Promise<SemanticAuditMemory[]> {
    const params: unknown[] = [scope.tenantId ?? DEFAULT_TENANT_ID];
    const filters = ["tenant_id = $1", "superseded_at IS NULL"];
    if (scope.company) {
      params.push(scope.company);
      filters.push(`company = $${params.length}`);
    }
    if (scope.period) {
      params.push(scope.period);
      filters.push(`period = $${params.length}`);
    }
    if (scope.kind) {
      params.push(scope.kind);
      filters.push(`kind = $${params.length}`);
    }
    const rows = await query<PgRow>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
              created_at, importance, embedding::text AS embedding, 0 AS distance
         FROM agent_memory
        WHERE ${filters.join(" AND ")}`,
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

// ── In-memory store (unit tests — no DB, no creds) ────────────────────────────
// Same cosine-distance ranking as pgvector's `<=>`, computed over plain arrays,
// so the memory logic (filter + top-k ordering) is verifiable with zero infra.
interface MemRow extends MemoryRecord {
  embedding: number[];
  importance: number;
  supersededAt: string | null;
  idempotencyKey: string | null;
}

export class InMemoryStore implements MemoryStore {
  private rows: MemRow[] = [];
  private feedback = new Map<string, { requestHash: string; result: FeedbackResult }>();

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
      .filter((r) => (opts.company ? r.company === opts.company : true));
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
    return this.rows.filter((r) => r.tenantId === tenantId && (company ? r.company === company : true)).length;
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
    const { embedding: _embedding, idempotencyKey: _idempotencyKey, ...record } = row;
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

  async clear(): Promise<void> {
    this.rows = [];
    this.feedback.clear();
  }

  async listForConsolidation(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ConsolidatableMemory[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.supersededAt === null && (company ? r.company === company : true))
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

  async listForForget(company?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ForgetCandidate[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && (company ? r.company === company : true))
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

  async listForAudit(
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind } = {}
  ): Promise<AuditMemory[]> {
    return this.rows
      .filter((r) => r.tenantId === (scope.tenantId ?? DEFAULT_TENANT_ID))
      .filter((r) => r.supersededAt === null)
      .filter((r) => (scope.company ? r.company === scope.company : true))
      .filter((r) => (scope.period ? r.period === scope.period : true))
      .filter((r) => (scope.kind ? r.kind === scope.kind : true))
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
    scope: { tenantId?: string; company?: string; period?: string; kind?: MemoryKind } = {},
  ): Promise<SemanticAuditMemory[]> {
    return this.rows
      .filter((r) => r.tenantId === (scope.tenantId ?? DEFAULT_TENANT_ID))
      .filter((r) => r.supersededAt === null)
      .filter((r) => (scope.company ? r.company === scope.company : true))
      .filter((r) => (scope.period ? r.period === scope.period : true))
      .filter((r) => (scope.kind ? r.kind === scope.kind : true))
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
  const { embedding, importance, supersededAt, idempotencyKey, ...rec } = r;
  return { ...rec, distance, score };
}

// Cosine distance = 1 - cosine similarity, matching pgvector's `<=>` operator.
function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

function sameLogicalMemory(existing: MemRow, incoming: StoredMemory): boolean {
  return existing.kind === incoming.kind &&
    existing.company === (incoming.company ?? "_global") &&
    existing.period === (incoming.period ?? null) &&
    existing.sourceRef === (incoming.sourceRef ?? null) &&
    existing.content === incoming.content &&
    isDeepStrictEqual(existing.metadata, incoming.metadata ?? null) &&
    existing.importance === clampImportance(incoming.importance);
}
