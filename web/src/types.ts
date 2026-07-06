// API contract for the Archon MemoryAgent HTTP service. These interfaces mirror
// the server's response shapes 1:1 (see backend src/server.ts, src/agents/
// narrator.ts, src/memory/consistency.ts) so that the canned demo data and the
// live payloads render through the SAME components — any drift is a compile error.

export type MemoryKind = "document" | "payroll_event" | "validation" | "insight";

// GET /health
export interface Health {
  status: string;
  embedder: string; // live embedder model id, e.g. "text-embedding-v4"
  narrator: string; // live narrator model id, e.g. "qwen-plus"
  embedDim: number; // embedding dimension, e.g. 1024
}

// GET /memory/count
export interface MemoryCount {
  count: number;
}

// One recalled memory (RecallHit) — a stored memory plus its retrieval scores.
export interface RecallHit {
  id: string;
  kind: MemoryKind;
  company: string;
  period: string | null;
  sourceRef: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  distance: number; // cosine distance (0 = identical direction)
  score: number; // cosine SIMILARITY (1 - distance)
  rrfScore?: number; // hybrid fusion score that decided ordering (optional)
}

// One grounding source cited by the answer.
export interface Citation {
  marker: string; // "[1]", "[2]", … — appears verbatim in the answer text
  kind: MemoryKind;
  score: number; // cosine similarity
  sourceRef: string | null;
  content: string;
}

// A recommendation for which side of a contradiction to trust. Never mutates
// memory — it is a recommender, not ground truth.
export interface Resolution {
  recommendedMemoryId: string;
  recommendedValue: unknown;
  rule: "recency" | "importance" | "source-authority";
  confidence: number; // heuristic ordinal confidence in [0,1]
  rationale: string;
}

export interface ContradictionValue {
  memoryId: string;
  sourceRef: string | null;
  value: unknown;
  createdAt: string;
}

export interface Contradiction {
  type: "contradiction";
  subject: string; // the record all these memories describe
  attribute: string; // the metadata field they disagree on
  values: ContradictionValue[];
  resolution: Resolution;
}

export interface Absence {
  type: "absence";
  subject: string;
  referencedBy: Array<{ memoryId: string; sourceRef: string | null }>;
}

// POST /consistency  (also embedded as `consistency` on a /recall response)
export interface ConsistencyReport {
  audited: number;
  subjects: number;
  contradictions: Contradiction[];
  absences: Absence[];
  ok: boolean;
}

// POST /recall
export interface RecallResponse {
  answer: string;
  hits: RecallHit[];
  citations: Citation[];
  modelId: string;
  consistency: ConsistencyReport; // best-effort self-audit over recalled memories
}
