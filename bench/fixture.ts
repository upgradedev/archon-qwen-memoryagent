// Shared fixture types + loader for the benchmark.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = join(HERE, "fixtures", "embeddings.json");

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
