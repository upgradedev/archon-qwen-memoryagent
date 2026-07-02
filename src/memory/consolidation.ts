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

// Single-link clustering by cosine similarity within the same `kind`. Threshold
// ~0.95 means "these two memories say the same thing"; distinct facts stay apart.
export function planConsolidation(
  memories: ConsolidatableMemory[],
  threshold = 0.95
): ConsolidationPlan {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // path-compress
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  for (const m of memories) parent.set(m.id, m.id);

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]!;
      const b = memories[j]!;
      if (a.kind !== b.kind) continue;
      if (cosineSimilarity(a.embedding, b.embedding) >= threshold) union(a.id, b.id);
    }
  }

  const byRoot = new Map<string, ConsolidatableMemory[]>();
  for (const m of memories) {
    const root = find(m.id);
    (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(m);
  }

  const groups: SupersedePlan[] = [];
  let supersededCount = 0;
  for (const members of byRoot.values()) {
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

export interface ForgetPolicy {
  // Hard-delete rows already superseded by consolidation (default true).
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
  const { deleteSuperseded = true, olderThanDays, maxImportance } = policy;
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
      new Date(m.createdAt).getTime() < cutoff
    ) {
      ids.push(m.id);
    }
  }
  return ids;
}
