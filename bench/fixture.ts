// Shared fixture types + loader for the benchmark.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = join(HERE, "fixtures", "embeddings.json");
export const RERANK_FIXTURE_PATH = join(HERE, "fixtures", "rerank.json");

export interface EmbeddingFixture {
  model: string;
  dim: number;
  generatedAt: string;
  memories: Record<string, number[]>; // memory id → embedding
  queries: Record<string, number[]>; // query id → embedding
}

export function loadFixture(): EmbeddingFixture | null {
  if (!existsSync(FIXTURE_PATH)) return null;
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as EmbeddingFixture;
}

// Cached cross-encoder re-rank scores: query id → { memory id → relevance }.
// Built once by `npm run bench:rerank` (real qwen-plus), replayed offline in CI.
export interface RerankFixture {
  model: string;
  generatedAt: string;
  scores: Record<string, Record<string, number>>;
}

export function loadRerankFixture(): RerankFixture | null {
  if (!existsSync(RERANK_FIXTURE_PATH)) return null;
  return JSON.parse(readFileSync(RERANK_FIXTURE_PATH, "utf8")) as RerankFixture;
}
