import { withClient } from "../db/client.js";

export const QUOTA_RETENTION_DAYS = 30;

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
  /** Atomic work units reserved by this operation (defaults to one). */
  units?: number;
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
      units: clampUnits(charge.units),
      key: `${charge.bucket}:${charge.subject}`,
    }));

    for (const charge of normalized) {
      const state = this.buckets.get(charge.key);
      const currentCount = state?.day === day ? state.count : 0;
      const proposed = currentCount + (pending.get(charge.key) ?? 0) + charge.units;
      if (proposed > charge.limit) {
        return { ok: false, remaining: 0, limit: charge.limit, resetAt: resetAt.toISOString() };
      }
      pending.set(charge.key, (pending.get(charge.key) ?? 0) + charge.units);
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
      units: clampUnits(charge.units),
    }));
    // The INSERT arm of an upsert has no existing row against which to apply
    // the ON CONFLICT limit predicate. Reject an oversized first-ever charge
    // before opening a transaction so it cannot create an over-limit counter.
    const oversized = normalized.find((charge) => charge.units > charge.limit);
    if (oversized) {
      return { ok: false, remaining: 0, limit: oversized.limit, resetAt: resetAt.toISOString() };
    }
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
             VALUES ($1::date, $2, $3, $5)
             ON CONFLICT (quota_day, bucket, subject) DO UPDATE
               SET count = api_daily_quota.count + $5
               WHERE api_daily_quota.count + $5 <= $4
             RETURNING count`,
            [day, charge.bucket, charge.subject, charge.limit, charge.units],
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
        // Quota rows are operational counters, not a permanent audit log. Keep
        // the table bounded while making cleanup best-effort: a cleanup failure
        // rolls back only to its savepoint and never loses an accepted charge.
        await client.query("SAVEPOINT quota_retention_cleanup");
        try {
          await client.query(
            `DELETE FROM api_daily_quota
              WHERE quota_day < ($1::date - $2::integer)`,
            [day, QUOTA_RETENTION_DAYS],
          );
          await client.query("RELEASE SAVEPOINT quota_retention_cleanup");
        } catch {
          await client.query("ROLLBACK TO SAVEPOINT quota_retention_cleanup");
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
  readinessPerSubject: number;
  readinessJudgeReserve: number;
  recallPerSubject: number;
  recallPublicGlobal: number;
  recallJudgeReserve: number;
  ingestPerSubject: number;
  ingestPublicGlobal: number;
  ingestJudgeReserve: number;
  semanticPerSubject: number;
  semanticPublicGlobal: number;
  semanticJudgeReserve: number;
}

export type QuotaPool = "public" | "judge";

export function loadQwenQuotaPolicy(): QwenQuotaPolicy {
  return {
    readinessPerSubject: envLimit("DEEP_READINESS_DAILY_LIMIT", 30),
    readinessJudgeReserve: envLimit("DEEP_READINESS_DAILY_LIMIT_GLOBAL", 300),
    recallPerSubject: envLimit("RECALL_DAILY_LIMIT", 200),
    recallPublicGlobal: envLimit("RECALL_DAILY_LIMIT_GLOBAL", 2_000),
    recallJudgeReserve: envLimit("RECALL_DAILY_LIMIT_JUDGE_RESERVE", 400),
    ingestPerSubject: envLimit("INGEST_DAILY_LIMIT", 100),
    ingestPublicGlobal: envLimit("INGEST_DAILY_LIMIT_GLOBAL", 500),
    ingestJudgeReserve: envLimit("INGEST_DAILY_LIMIT_JUDGE_RESERVE", 200),
    semanticPerSubject: envLimit("SEMANTIC_AUDIT_DAILY_LIMIT", 500),
    semanticPublicGlobal: envLimit("SEMANTIC_AUDIT_DAILY_LIMIT_GLOBAL", 2_500),
    semanticJudgeReserve: envLimit("SEMANTIC_AUDIT_DAILY_LIMIT_JUDGE_RESERVE", 2_500),
  };
}

export async function consumeTwoTierQuota(
  backend: DailyQuotaBackend,
  bucket: string,
  subject: string,
  perSubject: number,
  global: number,
  pool: QuotaPool = "public",
  units = 1,
): Promise<QuotaResult> {
  return backend.consumeMany([
    { bucket: `${bucket}:${pool}:subject`, subject, limit: perSubject, units },
    { bucket: `${bucket}:${pool}:global`, subject: pool, limit: global, units },
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

function clampUnits(value: number | undefined): number {
  if (value == null) return 1;
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(Math.floor(value), 1_000_000));
}
