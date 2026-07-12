// Semantic self-auditing — the agent that catches its OWN memory contradicting
// itself IN MEANING, not just in a matching metadata field.
//
// `auditConsistency` (./consistency.ts) is the rule-based layer: it groups
// memories by the RECORD they name and flags two write events that assign
// DIFFERENT values to the SAME attribute (two totals for one invoice) or a
// dangling reference. That layer is exact and cheap, but it is blind to a whole
// class of real contradiction — two memories that OPPOSE each other in meaning
// while sharing NO comparable metadata key:
//
//   A (session 1): "Vendor Northwind always pays its invoices on time."
//   B (session 5): "Vendor Northwind is chronically late paying invoices."
//
// Neither carries a numeric `paid_on_time` attribute to compare, and they may be
// stored under different sourceRefs, so the rule-based audit groups nothing and
// reports OK. The disagreement lives in the prose. This module catches exactly
// that, WITHOUT replacing or weakening the rule-based path:
//
//   1. SUBJECT GATE — embed each memory (the same text-embedding-v4 path recall
//      uses) and consider only pairs whose cosine similarity clears a threshold:
//      they are about the same subject. This both finds candidate pairs and keeps
//      the (paid) judge calls bounded to plausibly-related memories.
//   2. OPPOSITION JUDGE — for each near pair ask a judge "do these DIRECTLY
//      contradict?". Online that is qwen-plus (real semantic reasoning); offline
//      it is a deterministic polarity/negation heuristic (FakeJudge) so the whole
//      path runs in CI with zero credentials, exactly like the rest of the suite.
//
// Like the rule-based layer this is READ-ONLY and a RECOMMENDER: every finding
// carries the SAME `Resolution` shape, produced by the SAME importance→authority→
// recency ladder (reused from ./consistency.ts). It NEVER mutates memory.
//
// Design: `detectSemanticContradictions` is a PURE async function over memories
// that ALREADY carry an embedding + an injected judge — no embedder I/O, no DB,
// deterministic given its inputs. `auditSemanticConsistency` is the thin wrapper
// that performs the embedding I/O (via the injected Embedder) and delegates.

import { cosineSimilarity } from "./retrieval.js";
import { resolveContradiction, type AuditMemory, type Resolution } from "./consistency.js";
import type { Embedder } from "./embeddings.js";
import {
  createQwenClient,
  hasQwenCreds,
  type QwenChatClient,
} from "../qwen/client.js";

// The judge model. qwen-plus is the same chat model the narrator uses, reached
// through the identical OpenAI-compatible Model Studio surface — no new provider.
export const DEFAULT_JUDGE_MODEL = process.env.QWEN_JUDGE_MODEL || "qwen-plus";

// The default subject-similarity gate, tuned for REAL text-embedding-v4 vectors:
// two statements about the same subject (even opposing ones) land close in that
// space, so a fairly high threshold both catches same-subject pairs and rejects
// unrelated ones. The deterministic FakeEmbedder is a crude bag-of-words hash
// whose scale is different, so tests that exercise the offline path pass an
// explicit lower threshold — never rely on this default for the fake.
export const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

// Safety cap on judge calls per audit (the pair count is O(n²) before the gate).
// The gate usually keeps this far lower; the cap bounds cost on a pathological
// set where everything is mutually similar.
export const DEFAULT_MAX_PAIRS = 500;

// A judge's verdict on whether two statements directly contradict. `confidence`
// is a heuristic 0..1 ordinal, NOT a calibrated probability.
export interface JudgeVerdict {
  contradict: boolean;
  confidence: number;
  reason: string;
}

// The pluggable opposition judge — QwenJudge online, FakeJudge in CI.
export interface SemanticJudge {
  readonly modelId: string;
  judge(a: string, b: string): Promise<JudgeVerdict>;
}

// A memory the semantic audit can compare: the domain-neutral audit view PLUS an
// embedding of its content (the subject-similarity signal).
export interface SemanticMemory extends AuditMemory {
  embedding: number[];
}

// One semantically-opposed pair the agent found in its own memory.
export interface SemanticContradiction {
  type: "semantic-contradiction";
  // Cosine similarity of the two memories' embeddings (how strongly the subject
  // gate fired) — the evidence they are about the same thing.
  similarity: number;
  // The two conflicting write events, earliest first (session ordering).
  memories: Array<{
    memoryId: string;
    sourceRef: string | null;
    content: string;
    createdAt: string;
  }>;
  // The judge's opposition verdict (which model, why, how sure).
  judge: { confidence: number; reason: string; model: string };
  // A recommendation for which side to trust — SAME shape + SAME policy ladder as
  // the rule-based audit (recommender, not ground truth). Never mutates memory.
  resolution: Resolution;
}

export interface SemanticConsistencyReport {
  audited: number; // memories examined
  compared: number; // pairs that cleared the subject gate (i.e. judge calls made)
  semanticContradictions: SemanticContradiction[];
  ok: boolean; // true ⇔ no findings
}

export interface SemanticAuditOptions {
  // Minimum embedding cosine similarity for two memories to be treated as the
  // same subject (and thus worth judging). Defaults to DEFAULT_SIMILARITY_THRESHOLD.
  similarityThreshold?: number;
  // Hard cap on judge calls per audit. Defaults to DEFAULT_MAX_PAIRS.
  maxPairs?: number;
}

// ── Pure detector ────────────────────────────────────────────────────────────
// Over memories that ALREADY carry embeddings + an injected judge, find every
// same-subject pair the judge rules a contradiction. No embedder I/O, no DB —
// deterministic given (memories, judge, opts). The judge is the only async seam.
export async function detectSemanticContradictions(
  memories: SemanticMemory[],
  judge: SemanticJudge,
  opts: SemanticAuditOptions = {}
): Promise<SemanticConsistencyReport> {
  const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;

  // Deterministic iteration order (by id) → stable output + stable judge-call order.
  const sorted = [...memories].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const found: SemanticContradiction[] = [];
  let compared = 0;

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (compared >= maxPairs) break;
      const a = sorted[i]!;
      const b = sorted[j]!;
      const similarity = cosineSimilarity(a.embedding, b.embedding);
      if (similarity < threshold) continue; // not the same subject → skip
      compared++;

      const verdict = await judge.judge(a.content, b.content);
      if (!verdict.contradict) continue;

      // Reuse the rule-based resolver: each memory is one side (distinct content).
      // The importance→authority→recency ladder recommends which to trust.
      const resolution = resolveContradiction([
        { value: a.content, memories: [a] },
        { value: b.content, memories: [b] },
      ]);

      // Earliest write first (session ordering), matching the rule-based report.
      const pair = [a, b]
        .map((m) => ({
          memoryId: m.id,
          sourceRef: m.sourceRef,
          content: m.content,
          createdAt: m.createdAt,
        }))
        .sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));

      found.push({
        type: "semantic-contradiction",
        similarity: round4(similarity),
        memories: pair,
        judge: {
          confidence: clamp(verdict.confidence, 0, 1),
          reason: verdict.reason,
          model: judge.modelId,
        },
        resolution,
      });
    }
    if (compared >= maxPairs) break;
  }

  // Deterministic ordering for stable output / tests.
  found.sort((a, b) => {
    const ak = a.memories.map((m) => m.memoryId).join("|");
    const bk = b.memories.map((m) => m.memoryId).join("|");
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  return {
    audited: memories.length,
    compared,
    semanticContradictions: found,
    ok: found.length === 0,
  };
}

// ── Wrapper: embed then detect ───────────────────────────────────────────────
// The thin I/O layer. Embeds each memory's content with the injected Embedder
// (the same production path recall uses), then runs the pure detector. Keeping
// the embedding here (not on the store) means NO schema/store change.
export async function auditSemanticConsistency(
  memories: AuditMemory[],
  embedder: Embedder,
  judge: SemanticJudge,
  opts: SemanticAuditOptions = {}
): Promise<SemanticConsistencyReport> {
  const withEmbeddings: SemanticMemory[] = [];
  for (const m of memories) {
    withEmbeddings.push({ ...m, embedding: await embedder.embed(m.content) });
  }
  return detectSemanticContradictions(withEmbeddings, judge, opts);
}

// ── QwenJudge (online path) ──────────────────────────────────────────────────
// Real semantic reasoning: asks qwen-plus whether two statements directly
// contradict, via the same OpenAI-compatible client the narrator uses. FAILS
// CLOSED — any error, timeout, or unparseable response yields "no contradiction",
// never a manufactured one (a hallucinated contradiction is a trust regression).
const JUDGE_SYSTEM =
  "You are a meticulous memory-consistency auditor. You are given two statements " +
  "that were stored independently, at different times, in an agent's long-term " +
  "memory about a business. Decide whether they DIRECTLY CONTRADICT each other — " +
  "i.e. they assert OPPOSITE facts about the SAME subject and cannot both be true. " +
  "Two statements that are merely different, complementary, about different " +
  "subjects, or about different time periods do NOT contradict. Respond with ONLY " +
  'a compact JSON object and nothing else: {"contradict": boolean, "confidence": ' +
  'number between 0 and 1, "reason": short string}.';

export class QwenJudge implements SemanticJudge {
  readonly modelId: string;
  constructor(
    private client: QwenChatClient = createQwenClient(),
    modelId: string = DEFAULT_JUDGE_MODEL
  ) {
    this.modelId = modelId;
  }

  async judge(a: string, b: string): Promise<JudgeVerdict> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.modelId,
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `Statement A: ${a}\nStatement B: ${b}` },
        ],
        temperature: 0,
        max_tokens: 200,
      });
      const raw = res.choices?.[0]?.message?.content ?? "";
      return parseVerdict(raw);
    } catch {
      // Fail closed: never invent a contradiction on an upstream failure.
      return { contradict: false, confidence: 0, reason: "judge unavailable" };
    }
  }
}

// Parse a judge model's JSON verdict defensively. Strips markdown code fences and
// fails CLOSED on anything it cannot confidently read as a contradiction verdict.
export function parseVerdict(raw: string): JudgeVerdict {
  const cleaned = stripCodeFences(raw).trim();
  // Extract the first {...} block so trailing prose can't defeat the parse.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      if (typeof o.contradict === "boolean") {
        const c = Number(o.confidence);
        return {
          contradict: o.contradict,
          confidence: Number.isFinite(c) ? clamp(c, 0, 1) : 0,
          reason: typeof o.reason === "string" ? o.reason : "",
        };
      }
    } catch {
      // fall through to fail-closed
    }
  }
  return { contradict: false, confidence: 0, reason: "unparseable judge response" };
}

function stripCodeFences(s: string): string {
  return s.replace(/```(?:json)?/gi, "").replace(/```/g, "");
}

// ── FakeJudge (offline / CI path) ────────────────────────────────────────────
// Deterministic, dependency-free polarity/negation opposition detector — the
// offline analogue of qwen-plus, so the full semantic path runs in CI with zero
// credentials (same pattern as FakeEmbedder / FakeNarrator). It is a genuine
// heuristic, not a stub: two statements contradict when they land on OPPOSITE
// sides of one polarity cluster (with negation flipping the side). NOT as capable
// as the real model — that is the point of the online path — but honest and real.
interface PolarityCluster {
  readonly name: string;
  readonly pos: readonly string[];
  readonly neg: readonly string[];
}

const POLARITY_CLUSTERS: readonly PolarityCluster[] = [
  {
    name: "punctuality",
    pos: ["on time", "on-time", "timely", "prompt", "promptly", "reliable", "reliably", "punctual"],
    neg: ["late", "overdue", "delinquent", "delayed", "unreliable", "tardy"],
  },
  {
    name: "payment",
    pos: ["paid", "settled", "cleared"],
    neg: ["unpaid", "outstanding", "owing", "defaulted", "default"],
  },
  {
    name: "trend",
    pos: ["increased", "increasing", "rose", "grew", "growth", "higher"],
    neg: ["decreased", "decreasing", "fell", "dropped", "decline", "declined", "lower"],
  },
  {
    name: "result",
    pos: ["profit", "profitable", "surplus"],
    neg: ["loss", "loss-making", "deficit", "unprofitable"],
  },
  {
    name: "decision",
    pos: ["approved", "accepted"],
    neg: ["rejected", "declined", "denied"],
  },
  {
    name: "status",
    pos: ["active", "ongoing"],
    neg: ["closed", "terminated", "cancelled", "inactive"],
  },
  {
    name: "solvency",
    pos: ["solvent"],
    neg: ["insolvent", "bankrupt"],
  },
  {
    name: "compliance",
    pos: ["compliant"],
    neg: ["non-compliant", "noncompliant", "in breach"],
  },
];

export class FakeJudge implements SemanticJudge {
  readonly modelId = "fake-polarity-judge";

  async judge(a: string, b: string): Promise<JudgeVerdict> {
    const la = " " + a.toLowerCase() + " ";
    const lb = " " + b.toLowerCase() + " ";
    for (const cluster of POLARITY_CLUSTERS) {
      const pa = clusterPolarity(la, cluster);
      const pb = clusterPolarity(lb, cluster);
      if (pa !== 0 && pb !== 0 && pa !== pb) {
        return {
          contradict: true,
          confidence: 0.7,
          reason: `Opposite '${cluster.name}' polarity between the two statements.`,
        };
      }
    }
    return { contradict: false, confidence: 0.6, reason: "No opposing polarity cue found." };
  }
}

// Net polarity of a text within one cluster: +1 leans positive, -1 negative, 0
// none/ambiguous. A negation immediately governing a cue flips its contribution.
function clusterPolarity(lowerText: string, cluster: PolarityCluster): number {
  let score = 0;
  for (const cue of cluster.pos) if (hasCue(lowerText, cue)) score += isNegated(lowerText, cue) ? -1 : 1;
  for (const cue of cluster.neg) if (hasCue(lowerText, cue)) score += isNegated(lowerText, cue) ? 1 : -1;
  return Math.sign(score);
}

function hasCue(lowerText: string, cue: string): boolean {
  return new RegExp(`(?:^|[^a-z])${escapeRe(cue)}(?:[^a-z]|$)`).test(lowerText);
}

// A cue is negated when a negation word governs it within a short window before it
// ("does NOT pay on time", "NEVER late", "no longer active").
function isNegated(lowerText: string, cue: string): boolean {
  return new RegExp(
    `\\b(?:not|never|no longer|without|isn't|aren't|wasn't|weren't|fails? to|failed to)\\b[^.;!?]{0,24}${escapeRe(cue)}`
  ).test(lowerText);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pick the judge by environment: real qwen-plus when a DashScope key is present,
// the deterministic fake otherwise. Same contract; callers can always inject.
export function defaultSemanticJudge(): SemanticJudge {
  return hasQwenCreds() ? new QwenJudge() : new FakeJudge();
}

// ── small helpers ────────────────────────────────────────────────────────────
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
