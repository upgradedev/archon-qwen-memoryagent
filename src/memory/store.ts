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
import { query, toVectorLiteral } from "../db/client.js";
import { rrfFuse, topK, BM25, cosineSimilarity } from "./retrieval.js";
import type { ConsolidatableMemory, ForgetCandidate } from "./consolidation.js";
import type { AuditMemory } from "./consistency.js";

export type MemoryKind = "document" | "payroll_event" | "validation" | "insight";

export interface MemoryInput {
  kind: MemoryKind;
  company?: string; // defaults to '_global'
  period?: string | null;
  sourceRef?: string | null; // originating row id
  content: string; // the recallable natural-language fact
  metadata?: Record<string, unknown> | null;
  importance?: number; // 0..1 salience, defaults to 0.5
}

// A memory ready to persist: the input plus its embedding + which model produced it.
export interface StoredMemory extends MemoryInput {
  embedding: number[];
  embedModel: string;
}

export interface MemoryRecord {
  id: string;
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
  score: number; // 1 - distance, convenience similarity
}

export interface RecallOptions {
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

export interface MemoryStore {
  remember(m: StoredMemory): Promise<string>;
  recall(queryVec: number[], opts?: RecallOptions): Promise<RecallHit[]>;
  count(company?: string): Promise<number>;
  clear(): Promise<void>;
  // ── memory lifecycle (consolidation / forgetting) ──
  listForConsolidation(company?: string): Promise<ConsolidatableMemory[]>;
  supersede(loserIds: string[], winnerId: string): Promise<number>;
  listForForget(company?: string): Promise<ForgetCandidate[]>;
  deleteMemories(ids: string[]): Promise<number>;
  // ── self-auditing (consistency) ──
  // Read-only: return ACTIVE memories in scope for a consistency audit. Selects
  // only columns that already exist (no schema change — the live table is safe).
  listForAudit(scope?: { company?: string; period?: string; kind?: MemoryKind }): Promise<AuditMemory[]>;
}

const POOL_K = 20; // depth of each ranked list fed into hybrid fusion

// ── pgvector-backed store (production + CI + Alibaba Cloud) ────────────────────
export class PgVectorStore implements MemoryStore {
  async remember(m: StoredMemory): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO agent_memory
         (kind, company, period, source_ref, content, metadata, embedding, embed_model, importance)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9)
       RETURNING id`,
      [
        m.kind,
        m.company ?? "_global",
        m.period ?? null,
        m.sourceRef ?? null,
        m.content,
        m.metadata ? JSON.stringify(m.metadata) : null,
        toVectorLiteral(m.embedding),
        m.embedModel,
        clampImportance(m.importance),
      ]
    );
    return rows[0]!.id;
  }

  private scopeSql(opts: RecallOptions, params: unknown[]): string {
    const filters: string[] = [];
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
      `SELECT id, kind, company, period, source_ref, content, metadata, created_at,
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
  // fuse their RANKINGS with RRF (rank-based → no score normalization needed),
  // then return the fused top-k as RecallHits (score = fused RRF score).
  private async recallHybrid(
    queryVec: number[],
    opts: RecallOptions,
    limit: number
  ): Promise<RecallHit[]> {
    // Dense pool.
    const dParams: unknown[] = [toVectorLiteral(queryVec)];
    const dWhere = this.scopeSql(opts, dParams);
    dParams.push(POOL_K);
    const dense = await query<PgRow>(
      `SELECT id, kind, company, period, source_ref, content, metadata, created_at,
              (embedding <=> $1::vector) AS distance
         FROM agent_memory ${dWhere}
       ORDER BY embedding <=> $1::vector LIMIT $${dParams.length}`,
      dParams
    );
    // Lexical pool (full-text ts_rank over the same scope).
    const lParams: unknown[] = [opts.queryText!];
    const lWhere = this.scopeSql(opts, lParams);
    const lAnd = lWhere ? `${lWhere} AND` : "WHERE";
    lParams.push(POOL_K);
    const lexical = await query<PgRow>(
      `SELECT id, kind, company, period, source_ref, content, metadata, created_at,
              0 AS distance
         FROM agent_memory
         ${lAnd} to_tsvector('simple', content) @@ plainto_tsquery('simple', $1)
       ORDER BY ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', $1)) DESC
       LIMIT $${lParams.length}`,
      lParams
    );

    const fused = rrfFuse([dense.map((r) => r.id), lexical.map((r) => r.id)]);
    const scoreById = new Map(fused.map((f) => [f.id, f.score]));
    const byId = new Map<string, PgRow>();
    for (const r of [...dense, ...lexical]) if (!byId.has(r.id)) byId.set(r.id, r);
    return topK(fused, limit).map((id) => {
      const r = byId.get(id)!;
      return rowToHitWithScore(r, scoreById.get(id) ?? 0);
    });
  }

  async count(company?: string): Promise<number> {
    const rows = company
      ? await query<{ n: string }>(
          `SELECT count(*) AS n FROM agent_memory WHERE company = $1`,
          [company]
        )
      : await query<{ n: string }>(`SELECT count(*) AS n FROM agent_memory`);
    return Number(rows[0]!.n);
  }

  async clear(): Promise<void> {
    await query(`DELETE FROM agent_memory`);
  }

  async listForConsolidation(company?: string): Promise<ConsolidatableMemory[]> {
    const rows = company
      ? await query<{ id: string; kind: string; content: string; embedding: string; importance: string; created_at: string }>(
          `SELECT id, kind, content, embedding::text AS embedding, importance, created_at
             FROM agent_memory WHERE superseded_at IS NULL AND company = $1`,
          [company]
        )
      : await query<{ id: string; kind: string; content: string; embedding: string; importance: string; created_at: string }>(
          `SELECT id, kind, content, embedding::text AS embedding, importance, created_at
             FROM agent_memory WHERE superseded_at IS NULL`
        );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      content: r.content,
      embedding: parseVector(r.embedding),
      importance: Number(r.importance),
      createdAt: r.created_at,
    }));
  }

  async supersede(loserIds: string[], winnerId: string): Promise<number> {
    if (loserIds.length === 0) return 0;
    const rows = await query<{ id: string }>(
      `UPDATE agent_memory
          SET superseded_at = now(), superseded_by = $1
        WHERE id = ANY($2::uuid[]) AND superseded_at IS NULL
        RETURNING id`,
      [winnerId, loserIds]
    );
    return rows.length;
  }

  async listForForget(company?: string): Promise<ForgetCandidate[]> {
    const rows = company
      ? await query<{ id: string; importance: string; created_at: string; superseded_at: string | null }>(
          `SELECT id, importance, created_at, superseded_at FROM agent_memory WHERE company = $1`,
          [company]
        )
      : await query<{ id: string; importance: string; created_at: string; superseded_at: string | null }>(
          `SELECT id, importance, created_at, superseded_at FROM agent_memory`
        );
    return rows.map((r) => ({
      id: r.id,
      importance: Number(r.importance),
      createdAt: r.created_at,
      supersededAt: r.superseded_at,
    }));
  }

  async deleteMemories(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await query<{ id: string }>(
      `DELETE FROM agent_memory WHERE id = ANY($1::uuid[]) RETURNING id`,
      [ids]
    );
    return rows.length;
  }

  // Read-only audit read. Only ACTIVE (non-superseded) rows, only existing
  // columns — safe against the live table (DEPLOY_STATE.md: a new column 500s).
  async listForAudit(
    scope: { company?: string; period?: string; kind?: MemoryKind } = {}
  ): Promise<AuditMemory[]> {
    const params: unknown[] = [];
    const filters = ["superseded_at IS NULL"];
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
      `SELECT id, kind, company, period, source_ref, content, metadata, created_at,
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
      createdAt: r.created_at,
      importance: r.importance == null ? null : Number(r.importance),
    }));
  }
}

// Shared row shape + mappers for the pgvector store.
interface PgRow {
  id: string;
  kind: MemoryKind;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  distance: string | number;
  importance?: string | number | null; // present only on the audit SELECT
}

function rowToHitByDistance(r: PgRow): RecallHit {
  const distance = Number(r.distance);
  return baseHit(r, distance, 1 - distance);
}
function rowToHitWithScore(r: PgRow, score: number): RecallHit {
  return baseHit(r, 1 - score, score);
}
function baseHit(r: PgRow, distance: number, score: number): RecallHit {
  return {
    id: r.id,
    kind: r.kind,
    company: r.company,
    period: r.period,
    sourceRef: r.source_ref,
    content: r.content,
    metadata: r.metadata,
    createdAt: r.created_at,
    distance,
    score,
  };
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
}

export class InMemoryStore implements MemoryStore {
  private rows: MemRow[] = [];

  async remember(m: StoredMemory): Promise<string> {
    const id = randomUUID();
    this.rows.push({
      id,
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
    });
    return id;
  }

  private scope(opts: RecallOptions): MemRow[] {
    return this.rows
      .filter((r) => (opts.includeSuperseded ? true : r.supersededAt === null))
      .filter((r) => (opts.kind ? r.kind === opts.kind : true))
      .filter((r) => (opts.company ? r.company === opts.company : true));
  }

  async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const scoped = this.scope(opts);

    if (opts.hybrid && opts.queryText) {
      const dense = topK(
        scoped.map((r) => ({ id: r.id, score: cosineSimilarity(queryVec, r.embedding) })),
        POOL_K
      );
      const bm25 = new BM25(scoped.map((r) => ({ id: r.id, content: r.content })));
      const lexical = topK(bm25.scoreAll(opts.queryText), POOL_K);
      const fused = rrfFuse([dense, lexical]);
      const scoreById = new Map(fused.map((f) => [f.id, f.score]));
      const byId = new Map(scoped.map((r) => [r.id, r]));
      return topK(fused, limit).map((id) => {
        const r = byId.get(id)!;
        const score = scoreById.get(id) ?? 0;
        return toHit(r, 1 - score, score);
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

  async count(company?: string): Promise<number> {
    return this.rows.filter((r) => (company ? r.company === company : true)).length;
  }

  async clear(): Promise<void> {
    this.rows = [];
  }

  async listForConsolidation(company?: string): Promise<ConsolidatableMemory[]> {
    return this.rows
      .filter((r) => r.supersededAt === null && (company ? r.company === company : true))
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        content: r.content,
        embedding: r.embedding,
        importance: r.importance,
        createdAt: r.createdAt,
      }));
  }

  async supersede(loserIds: string[], winnerId: string): Promise<number> {
    const losers = new Set(loserIds);
    let n = 0;
    const at = new Date().toISOString();
    for (const r of this.rows) {
      if (losers.has(r.id) && r.supersededAt === null) {
        r.supersededAt = at;
        (r as MemRow & { supersededBy?: string }).supersededBy = winnerId;
        n++;
      }
    }
    return n;
  }

  async listForForget(company?: string): Promise<ForgetCandidate[]> {
    return this.rows
      .filter((r) => (company ? r.company === company : true))
      .map((r) => ({
        id: r.id,
        importance: r.importance,
        createdAt: r.createdAt,
        supersededAt: r.supersededAt,
      }));
  }

  async deleteMemories(ids: string[]): Promise<number> {
    const del = new Set(ids);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !del.has(r.id));
    return before - this.rows.length;
  }

  async listForAudit(
    scope: { company?: string; period?: string; kind?: MemoryKind } = {}
  ): Promise<AuditMemory[]> {
    return this.rows
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
}

function toHit(r: MemRow, distance: number, score: number): RecallHit {
  const { embedding, importance, supersededAt, ...rec } = r;
  return { ...rec, distance, score };
}

// Cosine distance = 1 - cosine similarity, matching pgvector's `<=>` operator.
function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}
