// One-time embedding pass — builds the committed fixture the benchmark replays.
//
//   npm run bench:embed         # needs DASHSCOPE_API_KEY (real text-embedding-v4)
//
// Cost-aware + reproducible by design: we call Qwen ONCE over the frozen corpus
// and queries, cache every vector to bench/fixtures/embeddings.json, and commit
// it. From then on `npm run bench` (and CI) replay the numbers from the fixture
// with NO key and NO further spend — so a judge reproduces the headline result
// offline, and CI can gate on it. Re-run this only if the dataset changes.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultEmbedder } from "../src/memory/embeddings.js";
import { CORPUS, QUERIES } from "./dataset.js";
import { FIXTURE_PATH, type EmbeddingFixture } from "./fixture.js";

// Round to keep the committed JSON small without hurting cosine ranking.
const round = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);

async function main() {
  const embedder = defaultEmbedder();
  if (embedder.modelId === "fake-hash-embedder") {
    console.error(
      "Refusing to build the fixture with the FakeEmbedder — the headline benchmark\n" +
        "must use real text-embedding-v4. Set DASHSCOPE_API_KEY and re-run."
    );
    process.exit(1);
  }
  console.log(`Embedding ${CORPUS.length} memories + ${QUERIES.length} queries with ${embedder.modelId} (${embedder.dim}d)…`);

  const memories: Record<string, number[]> = {};
  for (const m of CORPUS) memories[m.id] = round(await embedder.embed(m.content));

  const queries: Record<string, number[]> = {};
  for (const q of QUERIES) queries[q.id] = round(await embedder.embed(q.text));

  const fixture: EmbeddingFixture = {
    model: embedder.modelId,
    dim: embedder.dim,
    generatedAt: new Date().toISOString(),
    memories,
    queries,
  };
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture));
  console.log(`Wrote ${FIXTURE_PATH} (${Object.keys(memories).length} + ${Object.keys(queries).length} vectors).`);
}

main().catch((err) => {
  console.error("bench:embed failed:", err);
  process.exit(1);
});
