// Agent memory — the heart of the entry.
//
// This module turns a pgvector store into the agent's persistent, semantic
// memory by pairing an Embedder with a MemoryStore:
//   remember() : embed a natural-language fact and durably store it + metadata
//   recall()   : embed a question and run ANN vector search (cosine) for top-k
//
// Every durable thing an Archon agent learns (an extracted document, a fused
// payroll event, a validation finding, a narrated insight) becomes a memory.
// On the next run — even a different session, a different process — the agent
// recalls the relevant prior facts by MEANING and reasons with continuity
// instead of starting cold. That is the MemoryAgent track: persistent, queryable
// memory that survives across sessions.

import type { Embedder } from "./embeddings.js";
import type { MemoryInput, MemoryStore, RecallHit, RecallOptions } from "./store.js";

/** A single atomic write may never fan out into an unbounded provider burst. */
export const MAX_MEMORY_BATCH = 64;
export const DEFAULT_EMBEDDING_CONCURRENCY = boundedInteger(
  process.env.EMBEDDING_CONCURRENCY,
  4,
  1,
  8,
);

export interface RememberManyOptions {
  /** Test/tuning seam; production is bounded by DEFAULT_EMBEDDING_CONCURRENCY. */
  concurrency?: number;
  /** Cancels queued work and is forwarded to every active provider request. */
  signal?: AbortSignal;
}

// Embed `content` and persist the memory through the store. Returns the row id.
export async function remember(
  embedder: Embedder,
  store: MemoryStore,
  input: MemoryInput
): Promise<string> {
  const embedding = await embedder.embed(input.content);
  return store.remember({ ...input, embedding, embedModel: embedder.modelId });
}

// Embed a logical batch before opening the store transaction, then persist all
// rows atomically. Stable idempotency keys make a retried producer operation
// return the original ids instead of duplicating durable memories.
export async function rememberMany(
  embedder: Embedder,
  store: MemoryStore,
  inputs: MemoryInput[],
  options: RememberManyOptions = {},
): Promise<string[]> {
  if (inputs.length > MAX_MEMORY_BATCH) {
    throw Object.assign(
      new Error(`memory batch exceeds hard cap ${MAX_MEMORY_BATCH}`),
      { statusCode: 413 },
    );
  }
  if (inputs.length === 0) return [];

  const concurrency = boundedInteger(
    options.concurrency == null ? undefined : String(options.concurrency),
    DEFAULT_EMBEDDING_CONCURRENCY,
    1,
    8,
  );
  const controller = new AbortController();
  let firstError: unknown;
  let nextIndex = 0;
  const stored = new Array<MemoryInput & { embedding: number[]; embedModel: string }>(inputs.length);

  const abortFromCaller = () => {
    if (firstError == null) firstError = abortReason(options.signal);
    controller.abort(firstError);
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const worker = async () => {
    while (firstError == null) {
      const index = nextIndex++;
      if (index >= inputs.length) return;
      const input = inputs[index]!;
      try {
        const embedding = await embedder.embed(input.content, controller.signal);
        stored[index] = { ...input, embedding, embedModel: embedder.modelId };
      } catch (error) {
        if (firstError == null) {
          firstError = error;
          // Abort siblings that support cancellation, then wait below for every
          // already-started request to settle before surfacing the failure.
          controller.abort(error);
        }
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()),
    );
  } finally {
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
  if (firstError != null) throw firstError;
  return store.rememberMany(stored);
}

// Recall the top-k memories most semantically similar to `queryText`, optionally
// pre-filtered by kind/company. The question is embedded with the SAME model the
// memories were written with, then ranked by cosine distance in the store.
export async function recall(
  embedder: Embedder,
  store: MemoryStore,
  queryText: string,
  opts: RecallOptions = {}
): Promise<RecallHit[]> {
  const qvec = await embedder.embed(queryText);
  // Thread the raw query text through so hybrid recall has the lexical half. The
  // store uses it only when opts.hybrid is set.
  return store.recall(qvec, {
    ...opts,
    queryText,
    // A model promotion must never compare its query vector with an
    // incompatible historical vector space, even when dimensions happen to
    // match. Old rows remain durable and can be explicitly re-embedded.
    embedModel: embedder.modelId,
  });
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("embedding batch aborted"), { name: "AbortError" });
}
