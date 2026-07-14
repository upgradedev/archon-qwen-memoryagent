// Live API client with a hard timeout and an explicitly-labelled demo fallback.
// The production default is the HTTPS judge endpoint. A static deployment can
// override it with VITE_API_URL; failed live calls are never represented as live.

import type { Health, MemoryCount, RecallResponse, ConsistencyReport } from "./types";
import { DEMO_HEALTH, DEMO_COUNT, DEMO_RECALL, DEMO_CONSISTENCY } from "./demo";

export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ??
  "https://memory.43.106.13.19.sslip.io";

const TIMEOUT_MS = 5000;

// A live-call outcome: either real data (`live: true`) or the demo fallback
// (`live: false`) carrying the reason we fell back, so the UI can show a notice.
export type LiveResult<T> =
  | { live: true; data: T }
  | { live: false; data: T; reason: string };

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function fallbackReason(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return "DEMO FALLBACK — live API timed out; the data below is canned";
  }
  return "DEMO FALLBACK — live API unavailable; the data below is canned";
}

async function withFallback<T>(fn: () => Promise<T>, demo: T): Promise<LiveResult<T>> {
  try {
    return { live: true, data: await fn() };
  } catch (err) {
    return { live: false, data: demo, reason: fallbackReason(err) };
  }
}

export function getHealth(): Promise<LiveResult<Health>> {
  return withFallback(() => fetchJson<Health>("/health"), DEMO_HEALTH);
}

export function getMemoryCount(): Promise<LiveResult<MemoryCount>> {
  return withFallback(() => fetchJson<MemoryCount>("/memory/count"), DEMO_COUNT);
}

export function postRecall(question: string): Promise<LiveResult<RecallResponse>> {
  return withFallback(
    () =>
      fetchJson<RecallResponse>("/recall", {
        method: "POST",
        body: JSON.stringify({ question, hybrid: true }),
      }),
    DEMO_RECALL
  );
}

export function postConsistency(): Promise<LiveResult<ConsistencyReport>> {
  return withFallback(
    () => fetchJson<ConsistencyReport>("/consistency", { method: "POST", body: "{}" }),
    DEMO_CONSISTENCY
  );
}
