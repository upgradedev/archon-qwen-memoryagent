export type QwenAdmissionPool = "public" | "judge";

export interface QwenAdmission {
  tryAcquire(pool: QwenAdmissionPool): (() => void) | null;
}

/**
 * Zero-wait, process-local admission control for Qwen-heavy requests. Public
 * traffic and authenticated reviewer traffic have independent capacities, so a
 * public burst cannot consume the reviewer reserve. Durable daily quotas remain
 * the cross-replica spend boundary; this pool protects sockets and event-loop
 * work inside one replica.
 */
export class TieredQwenAdmission implements QwenAdmission {
  private activePublic = 0;
  private activeJudge = 0;

  constructor(
    readonly publicCapacity = configuredAdmissionCapacity(process.env.QWEN_PUBLIC_CONCURRENCY, 2),
    readonly judgeCapacity = configuredAdmissionCapacity(process.env.QWEN_JUDGE_CONCURRENCY, 2),
  ) {}

  tryAcquire(pool: QwenAdmissionPool): (() => void) | null {
    const active = pool === "judge" ? this.activeJudge : this.activePublic;
    const capacity = pool === "judge" ? this.judgeCapacity : this.publicCapacity;
    if (active >= capacity) return null;
    if (pool === "judge") this.activeJudge += 1;
    else this.activePublic += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (pool === "judge") this.activeJudge = Math.max(0, this.activeJudge - 1);
      else this.activePublic = Math.max(0, this.activePublic - 1);
    };
  }

  snapshot(): { public: number; judge: number } {
    return { public: this.activePublic, judge: this.activeJudge };
  }
}

export function configuredAdmissionCapacity(
  raw: string | number | undefined,
  fallback: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), 32));
}

export const PROCESS_QWEN_ADMISSION: QwenAdmission = new TieredQwenAdmission();
