// Shared helpers for the grounded-answer accuracy benchmark: deterministic number
// extraction (the objective grader) + the production hybrid recall over the frozen
// embedding fixture (so the answers are built from exactly the memories the shipped
// /recall path would surface).

import { CORPUS } from "./dataset.js";
import { loadFixture } from "./fixture.js";
import { retrieveHybrid, type Candidate } from "../src/memory/retrieval.js";

export const RECALL_K = 5;

// All numeric TOKENS in a text, comma-grouping removed ("18,400" → 18400).
// This intentionally has no semantic/context claim; dates and percentages are
// numbers too. Currency-specific grading uses euroFiguresIn below.
export function numbersIn(text: string): Set<number> {
  const cleaned = text.replace(/(\d),(?=\d)/g, "$1"); // strip thousands separators
  const out = new Set<number>();
  for (const m of cleaned.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

const EN_AMOUNT = String.raw`[-+]?(?:\d{1,3}(?:[,\u00a0 ]\d{3})+|\d+)(?:\.\d+)?`;

function parseEnglishAmount(raw: string): number | null {
  const n = Number(raw.replace(/[,\u00a0 ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// The EUR-labelled monetary claims an answer asserts. Accept the symbol or ISO
// code on either side ("€18,400", "EUR 18,400", "18,400 EUR", "18,400 €").
// A bare year or percentage is therefore never accidentally graded as money.
export function euroFiguresIn(answer: string): number[] {
  const out: number[] = [];
  const labelled = new RegExp(
    String.raw`(?:€|EUR)\s*(${EN_AMOUNT})|(${EN_AMOUNT})\s*(?:€|EUR)`,
    "giu",
  );
  for (const match of answer.matchAll(labelled)) {
    const n = parseEnglishAmount(match[1] ?? match[2] ?? "");
    if (n !== null) out.push(n);
  }
  return out;
}

// Build the corpus with real embeddings from the committed fixture.
export function loadCorpus(): Candidate[] {
  const fx = loadFixture();
  if (!fx) {
    throw new Error(
      "No embedding fixture — run `npm run bench:embed` (needs DASHSCOPE_API_KEY) to build bench/fixtures/embeddings.json."
    );
  }
  return CORPUS.map((m) => {
    const embedding = fx.memories[m.id];
    if (!embedding) throw new Error(`fixture missing embedding for ${m.id} — re-run bench:embed`);
    return { id: m.id, content: m.content, embedding };
  });
}

export function queryEmbedding(id: string): number[] {
  const fx = loadFixture();
  const v = fx?.queries[id];
  if (!v) throw new Error(`fixture missing query embedding ${id} — re-run bench:embed`);
  return v;
}

// The production default recall: hybrid (dense + lexical RRF), top-k. Returns the
// recalled memory ids in rank order.
export function recallHybrid(question: string, embedding: number[], corpus: Candidate[]): string[] {
  return retrieveHybrid({ text: question, embedding }, corpus, RECALL_K);
}

export function contentById(corpus: Candidate[]): Map<string, string> {
  return new Map(corpus.map((c) => [c.id, c.content]));
}
