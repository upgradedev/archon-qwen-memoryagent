// Qwen narrator — the RAG answer over recalled memories.
//
// Given a recall query and the top-k memories recalled from the pgvector index,
// the narrator writes a CFO-level answer that is GROUNDED in and CITES those
// memories. This is the "R" (retrieve) → "AG" (augmented generation) seam of the
// agentic memory loop: recall pulls the evidence, the narrator turns it into a
// trustworthy, sourced answer.
//
// Two implementations behind one `Narrator` interface, mirroring the Embedder
// pattern in ../memory/embeddings.ts:
//   QwenNarrator — real RAG via a Qwen chat model (qwen-plus) on Model Studio.
//   FakeNarrator — deterministic, dependency-free, no key. Composes a cited
//                  answer straight from the hits so the recall→narrate path
//                  runs offline in CI and local dev.
// `defaultNarrator()` auto-selects Qwen when a DashScope key is present, the
// fake otherwise — same auto-detection as `defaultEmbedder()`.

import {
  createQwenClient,
  hasQwenCreds,
  type QwenChatClient,
} from "../qwen/client.js";
import type { RecallHit } from "../memory/store.js";

export const DEFAULT_NARRATOR_MODEL = process.env.QWEN_MODEL || "qwen-plus";

// A single grounding source surfaced to the caller alongside the answer, so a UI
// (or a test) can render/verify the exact memories the answer was built from.
export interface Citation {
  marker: string; // "[1]", "[2]", … — appears verbatim in the answer text
  kind: RecallHit["kind"];
  score: number; // similarity (1 - cosine distance)
  sourceRef: string | null;
  content: string;
}

export interface NarratedAnswer {
  answer: string; // grounded prose citing [n] markers
  citations: Citation[]; // the memories the answer is grounded in
  modelId: string; // which narrator produced it (real model id or the fake tag)
}

export interface Narrator {
  readonly modelId: string;
  narrate(question: string, hits: RecallHit[]): Promise<NarratedAnswer>;
}

const NO_MEMORY = "No relevant memories found in the agent's persistent memory.";

// Render the recalled memories as a numbered context block the model (or the
// fake) cites by [n]. Kept identical across both narrators so citations line up.
function toCitations(hits: RecallHit[]): Citation[] {
  return hits.map((h, i) => ({
    marker: `[${i + 1}]`,
    kind: h.kind,
    score: h.score,
    sourceRef: h.sourceRef,
    content: h.content,
  }));
}

function contextBlock(citations: Citation[]): string {
  return citations
    .map((c) => `${c.marker} (${c.kind}, similarity ${c.score.toFixed(3)}) ${c.content}`)
    .join("\n");
}

const SYSTEM_PROMPT =
  "You are Archon, a financial-intelligence analyst with a persistent memory of a " +
  "small business's consolidated financial picture — sales and purchase invoices, " +
  "orders, payments, bank statements, expenses, P&L, EBITDA, cash, and cross-check " +
  "findings. Answer the user's question using ONLY the numbered MEMORY items " +
  "provided. Ground every claim in that memory and cite the item(s) you used with " +
  "their bracketed markers, e.g. [1] or [2]. Quote the exact euro figures from the " +
  "memory. If the memory does not contain the answer, say so plainly. Be concise " +
  "(2-4 sentences), in plain English, no bullet lists. When the memory reveals a " +
  "completeness or consistency issue — such as a bank payment with no matching " +
  "invoice, or an amount recorded inconsistently — flag it clearly as something to " +
  "review.";

// Real RAG narrator: retrieved memories → Qwen chat model on Model Studio →
// cited answer. Uses the injectable OpenAI-compatible client, so it stays
// entirely on Alibaba Cloud and is unit-testable with a canned client.
export class QwenNarrator implements Narrator {
  readonly modelId: string;
  constructor(
    private client: QwenChatClient = createQwenClient(),
    modelId: string = DEFAULT_NARRATOR_MODEL
  ) {
    this.modelId = modelId;
  }

  async narrate(question: string, hits: RecallHit[]): Promise<NarratedAnswer> {
    const citations = toCitations(hits);
    // No evidence → answer deterministically without spending a model call.
    if (citations.length === 0) {
      return { answer: NO_MEMORY, citations, modelId: this.modelId };
    }
    const userText =
      `MEMORY (recalled from the pgvector memory store by semantic similarity):\n` +
      `${contextBlock(citations)}\n\n` +
      `QUESTION: ${question}\n\n` +
      `Write the grounded, cited answer now.`;
    const res = await this.client.chat.completions.create({
      model: this.modelId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
      temperature: 0.2,
      max_tokens: 512,
    });
    const answer = res.choices?.[0]?.message?.content?.trim() || NO_MEMORY;
    return { answer, citations, modelId: this.modelId };
  }
}

// Deterministic offline narrator — no key. Composes a grounded, cited answer
// directly from the recalled memories so the full recall→narrate path executes
// in CI and local dev with FakeEmbedder. Intentionally domain-agnostic: it
// summarizes and cites whatever memories recall returned, rather than
// pattern-matching the question (which would be brittle and untestable).
export class FakeNarrator implements Narrator {
  readonly modelId = "fake-narrator";

  async narrate(question: string, hits: RecallHit[]): Promise<NarratedAnswer> {
    const citations = toCitations(hits);
    if (citations.length === 0) {
      return { answer: NO_MEMORY, citations, modelId: this.modelId };
    }
    const grounded = citations.map((c) => `${c.marker} ${c.content}`).join(" ");
    const answer =
      `Based on ${citations.length} recalled memory item(s), grounded in the ` +
      `agent's persistent memory: ${grounded} ` +
      `(In answer to: "${question}".)`;
    return { answer, citations, modelId: this.modelId };
  }
}

// Pick the narrator by environment: real Qwen when a DashScope key is present,
// the deterministic fake otherwise. Same contract either way; callers can always
// inject their own.
export function defaultNarrator(): Narrator {
  return hasQwenCreds() ? new QwenNarrator() : new FakeNarrator();
}
