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

export type MemoryKind = "document" | "payroll_event" | "validation" | "insight";

export interface MemoryInput {
  kind: MemoryKind;
  company?: string; // defaults to '_global'
  period?: string | null;
  sourceRef?: string | null; // originating row id
  content: string; // the recallable natural-language fact
  metadata?: Record<string, unknown> | null;
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
}

export interface MemoryStore {
  remember(m: StoredMemory): Promise<string>;
  recall(queryVec: number[], opts?: RecallOptions): Promise<RecallHit[]>;
  count(company?: string): Promise<number>;
  clear(): Promise<void>;
}

// ── pgvector-backed store (production + CI + Alibaba Cloud) ────────────────────
export class PgVectorStore implements MemoryStore {
  async remember(m: StoredMemory): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO agent_memory
         (kind, company, period, source_ref, content, metadata, embedding, embed_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
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
      ]
    );
    return rows[0]!.id;
  }

  async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const qvec = toVectorLiteral(queryVec);
    const filters: string[] = [];
    const params: unknown[] = [qvec];
    if (opts.kind) {
      params.push(opts.kind);
      filters.push(`kind = $${params.length}`);
    }
    if (opts.company) {
      params.push(opts.company);
      filters.push(`company = $${params.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(opts.limit ?? 5, 50)));
    const limitParam = `$${params.length}`;

    const rows = await query<{
      id: string;
      kind: MemoryKind;
      company: string;
      period: string | null;
      source_ref: string | null;
      content: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
      distance: string;
    }>(
      `SELECT id, kind, company, period, source_ref, content, metadata, created_at,
              (embedding <=> $1::vector) AS distance
         FROM agent_memory
         ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT ${limitParam}`,
      params
    );

    return rows.map((r) => {
      const distance = Number(r.distance);
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
        score: 1 - distance,
      };
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
}

// ── In-memory store (unit tests — no DB, no creds) ────────────────────────────
// Same cosine-distance ranking as pgvector's `<=>`, computed over plain arrays,
// so the memory logic (filter + top-k ordering) is verifiable with zero infra.
export class InMemoryStore implements MemoryStore {
  private rows: Array<MemoryRecord & { embedding: number[] }> = [];

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
    });
    return id;
  }

  async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    return this.rows
      .filter((r) => (opts.kind ? r.kind === opts.kind : true))
      .filter((r) => (opts.company ? r.company === opts.company : true))
      .map((r) => {
        const distance = cosineDistance(queryVec, r.embedding);
        const { embedding, ...rec } = r;
        return { ...rec, distance, score: 1 - distance };
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
}

// Cosine distance = 1 - cosine similarity, matching pgvector's `<=>` operator.
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return 1 - dot / denom;
}
