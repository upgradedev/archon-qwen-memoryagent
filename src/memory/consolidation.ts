// Memory consolidation + forgetting — the lifecycle half of a real MemoryAgent.
//
// An agent that only ever APPENDS memories rots: the same fact gets re-ingested
// every run, near-duplicates crowd recall, and stale facts never leave. A memory
// system needs the two operations a human memory has:
//
//   CONSOLIDATE — collapse near-duplicate memories into one canonical memory,
//                 keeping the freshest/most-important and superseding the rest.
//   FORGET      — drop what no longer earns its place (superseded rows, or
//                 low-importance memories past a retention window).
//
// This module holds the PURE planning logic (no DB), so it is fully unit-testable
// and the store just applies the plan. Consolidation is deliberately conservative:
// it only merges memories whose embeddings are near-identical (cosine >=
// threshold) AND share the same kind, so distinct facts are never lost.

import { cosineSimilarity } from "./retrieval.js";

export interface ConsolidatableMemory {
  id: string;
  kind: string;
  company: string;
  period: string | null;
  content: string;
  embedding: number[];
  importance: number;
  createdAt: string; // ISO
}

export interface SupersedePlan {
  winner: string; // the memory kept
  losers: string[]; // memories superseded by the winner
}

export interface ConsolidationPlan {
  groups: SupersedePlan[]; // one per duplicate cluster (size >= 2)
  supersededCount: number; // total memories that would be superseded
}

// Pick the winner of a duplicate cluster: highest importance, then newest, then
// lowest id (deterministic).
function pickWinner(members: ConsolidatableMemory[]): ConsolidatableMemory {
  return [...members].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1; // newer first
    return a.id < b.id ? -1 : 1;
  })[0]!;
}

export const MIN_CONSOLIDATION_THRESHOLD = 0.9;
export const DEFAULT_CONSOLIDATION_THRESHOLD = 0.95;

// Conservative complete-link clustering within the same kind/company/period.
// Every new member must be near-duplicate with EVERY existing member, preventing
// transitive A≈B≈C chains from merging A and C when they are materially distinct.
export function planConsolidation(
  memories: ConsolidatableMemory[],
  threshold = DEFAULT_CONSOLIDATION_THRESHOLD
): ConsolidationPlan {
  const safeThreshold = normalizeThreshold(threshold);
  const clusters: ConsolidatableMemory[][] = [];
  const sorted = [...memories].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const memory of sorted) {
    const cluster = clusters.find(
      (members) =>
        sameConsolidationScope(memory, members[0]!) &&
        members.every(
          (member) => cosineSimilarity(memory.embedding, member.embedding) >= safeThreshold,
        ),
    );
    if (cluster) cluster.push(memory);
    else clusters.push([memory]);
  }

  const groups: SupersedePlan[] = [];
  let supersededCount = 0;
  for (const members of clusters) {
    if (members.length < 2) continue;
    const winner = pickWinner(members);
    const losers = members.filter((m) => m.id !== winner.id).map((m) => m.id);
    groups.push({ winner: winner.id, losers });
    supersededCount += losers.length;
  }
  // Deterministic order for stable output/tests.
  groups.sort((a, b) => (a.winner < b.winner ? -1 : a.winner > b.winner ? 1 : 0));
  return { groups, supersededCount };
}

function sameConsolidationScope(a: ConsolidatableMemory, b: ConsolidatableMemory): boolean {
  return (
    a.kind === b.kind &&
    a.company.trim().toLocaleLowerCase("en-US") ===
      b.company.trim().toLocaleLowerCase("en-US") &&
    a.period === b.period
  );
}

function normalizeThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONSOLIDATION_THRESHOLD;
  return Math.min(1, Math.max(MIN_CONSOLIDATION_THRESHOLD, value));
}

export interface ForgetPolicy {
  // Hard-delete rows already superseded by consolidation. This must be explicit;
  // an empty/default policy is a safe no-op.
  deleteSuperseded?: boolean;
  // Also forget active memories older than this many days whose importance is
  // below `maxImportance`. Both must be set to enable time-based forgetting.
  olderThanDays?: number;
  maxImportance?: number;
}

export interface ForgetCandidate {
  id: string;
  importance: number;
  createdAt: string;
  supersededAt: string | null;
}

// Decide which memory ids to forget under a policy. Pure — the store deletes them.
export function planForget(
  memories: ForgetCandidate[],
  policy: ForgetPolicy,
  now: Date = new Date()
): string[] {
  const { deleteSuperseded = false } = policy;
  const olderThanDays =
    typeof policy.olderThanDays === "number" &&
    Number.isFinite(policy.olderThanDays) &&
    policy.olderThanDays >= 1
      ? policy.olderThanDays
      : undefined;
  const maxImportance =
    typeof policy.maxImportance === "number" && Number.isFinite(policy.maxImportance)
      ? Math.min(1, Math.max(0, policy.maxImportance))
      : undefined;
  const cutoff =
    olderThanDays != null ? now.getTime() - olderThanDays * 86_400_000 : null;
  const ids: string[] = [];
  for (const m of memories) {
    if (deleteSuperseded && m.supersededAt) {
      ids.push(m.id);
      continue;
    }
    if (
      cutoff != null &&
      maxImportance != null &&
      !m.supersededAt &&
      m.importance <= maxImportance &&
      Number.isFinite(Date.parse(m.createdAt)) &&
      Date.parse(m.createdAt) < cutoff
    ) {
      ids.push(m.id);
    }
  }
  return [...new Set(ids)].sort();
}
