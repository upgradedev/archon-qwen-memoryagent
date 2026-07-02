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

// Embed `content` and persist the memory through the store. Returns the row id.
export async function remember(
  embedder: Embedder,
  store: MemoryStore,
  input: MemoryInput
): Promise<string> {
  const embedding = await embedder.embed(input.content);
  return store.remember({ ...input, embedding, embedModel: embedder.modelId });
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
  return store.recall(qvec, { queryText, ...opts });
}
