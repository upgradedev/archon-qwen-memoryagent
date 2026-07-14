import { withClient } from "../db/client.js";

export interface QuotaResult {
  ok: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface QuotaCharge {
  bucket: string;
  subject: string;
  limit: number;
}

/** Injectable seam; production defaults to the durable PostgreSQL backend. */
export interface DailyQuotaBackend {
  consume(bucket: string, subject: string, limit: number): Promise<QuotaResult>;
  /** Atomically consume every charge, or leave every counter unchanged. */
  consumeMany(charges: readonly QuotaCharge[]): Promise<QuotaResult>;
}

export class InMemoryDailyQuotaBackend implements DailyQuotaBackend {
  private readonly buckets = new Map<string, { day: string; count: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async consume(bucket: string, subject: string, limit: number): Promise<QuotaResult> {
    return this.consumeMany([{ bucket, subject, limit }]);
  }

  async consumeMany(charges: readonly QuotaCharge[]): Promise<QuotaResult> {
    if (charges.length === 0) throw new Error("at least one quota charge is required");
    const current = this.now();
    const day = current.toISOString().slice(0, 10);
    const resetAt = new Date(`${day}T00:00:00.000Z`);
    resetAt.setUTCDate(resetAt.getUTCDate() + 1);
    const pending = new Map<string, number>();
    const normalized = charges.map((charge) => ({
      ...charge,
      limit: clampLimit(charge.limit),
      key: `${charge.bucket}:${charge.subject}`,
    }));

    for (const charge of normalized) {
      const state = this.buckets.get(charge.key);
      const currentCount = state?.day === day ? state.count : 0;
      const proposed = currentCount + (pending.get(charge.key) ?? 0) + 1;
      if (proposed > charge.limit) {
        return { ok: false, remaining: 0, limit: charge.limit, resetAt: resetAt.toISOString() };
      }
      pending.set(charge.key, (pending.get(charge.key) ?? 0) + 1);
    }

    for (const [key, increment] of pending) {
      const state = this.buckets.get(key);
      const count = (state?.day === day ? state.count : 0) + increment;
      this.buckets.set(key, { day, count });
    }
    const last = normalized.at(-1)!;
    const lastCount = this.buckets.get(last.key)!.count;
    return {
      ok: true,
      remaining: Math.max(0, last.limit - lastCount),
      limit: last.limit,
      resetAt: resetAt.toISOString(),
    };
  }
}

/** Shared, atomic quota backend for every replica connected to PostgreSQL. */
export class PgDailyQuotaBackend implements DailyQuotaBackend {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async consume(bucket: string, subject: string, limit: number): Promise<QuotaResult> {
    return this.consumeMany([{ bucket, subject, limit }]);
  }

  async consumeMany(charges: readonly QuotaCharge[]): Promise<QuotaResult> {
    if (charges.length === 0) throw new Error("at least one quota charge is required");
    const current = this.now();
    const day = current.toISOString().slice(0, 10);
    const resetAt = new Date(`${day}T00:00:00.000Z`);
    resetAt.setUTCDate(resetAt.getUTCDate() + 1);
    const normalized = charges.map((charge, index) => ({
      index,
      bucket: charge.bucket.slice(0, 64),
      subject: charge.subject.slice(0, 128),
      limit: clampLimit(charge.limit),
    }));
    // Stable lock order prevents two differently ordered batches deadlocking.
    const ordered = [...normalized].sort((a, b) =>
      `${a.bucket}\0${a.subject}`.localeCompare(`${b.bucket}\0${b.subject}`),
    );
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const results = new Map<number, QuotaResult>();
        for (const charge of ordered) {
          const rows = await client.query<{ count: number | string }>(
            `INSERT INTO api_daily_quota (quota_day, bucket, subject, count)
             VALUES ($1::date, $2, $3, 1)
             ON CONFLICT (quota_day, bucket, subject) DO UPDATE
               SET count = api_daily_quota.count + 1
               WHERE api_daily_quota.count < $4
             RETURNING count`,
            [day, charge.bucket, charge.subject, charge.limit],
          );
          if (rows.rows.length === 0) {
            await client.query("ROLLBACK");
            return { ok: false, remaining: 0, limit: charge.limit, resetAt: resetAt.toISOString() };
          }
          const count = Number(rows.rows[0]!.count);
          results.set(charge.index, {
            ok: true,
            remaining: Math.max(0, charge.limit - count),
            limit: charge.limit,
            resetAt: resetAt.toISOString(),
          });
        }
        await client.query("COMMIT");
        return results.get(normalized.length - 1)!;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });
  }
}

export interface QwenQuotaPolicy {
  recallPerSubject: number;
  recallGlobal: number;
  ingestPerSubject: number;
  ingestGlobal: number;
  semanticPerSubject: number;
  semanticGlobal: number;
}

export function loadQwenQuotaPolicy(): QwenQuotaPolicy {
  return {
    recallPerSubject: envLimit("RECALL_DAILY_LIMIT", 200),
    recallGlobal: envLimit("RECALL_DAILY_LIMIT_GLOBAL", 2_000),
    ingestPerSubject: envLimit("INGEST_DAILY_LIMIT", 100),
    ingestGlobal: envLimit("INGEST_DAILY_LIMIT_GLOBAL", 500),
    semanticPerSubject: envLimit("SEMANTIC_AUDIT_DAILY_LIMIT", 20),
    semanticGlobal: envLimit("SEMANTIC_AUDIT_DAILY_LIMIT_GLOBAL", 100),
  };
}

export async function consumeTwoTierQuota(
  backend: DailyQuotaBackend,
  bucket: string,
  subject: string,
  perSubject: number,
  global: number,
): Promise<QuotaResult> {
  return backend.consumeMany([
    { bucket: `${bucket}:subject`, subject, limit: perSubject },
    { bucket: `${bucket}:global`, subject: "global", limit: global },
  ]);
}

function envLimit(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return clampLimit(raw);
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(Math.floor(value), 1_000_000));
}
