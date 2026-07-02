// One-time cross-encoder re-rank pass — builds the fixture the benchmark replays.
//
//   npm run bench:rerank        # needs DASHSCOPE_API_KEY (real qwen-plus)
//
// Cost-aware + reproducible, exactly like bench:embed: we call the re-ranker ONCE
// per query over the full frozen corpus, cache every relevance score to
// bench/fixtures/rerank.json, and commit it. From then on `npm run bench` replays
// the re-ranked condition from the fixture with NO key and NO spend. One call per
// query (15 calls total), listwise over all 32 memories. Re-run only if the
// dataset changes.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CORPUS, QUERIES } from "./dataset.js";
import { RERANK_FIXTURE_PATH, type RerankFixture } from "./fixture.js";
import { defaultReranker } from "../src/memory/rerank.js";

async function main() {
  const reranker = defaultReranker();
  if (reranker.modelId.startsWith("fake")) {
    console.error(
      "Refusing to build the re-rank fixture with the FakeReranker — the top-rank\n" +
        "claim must use the real cross-encoder. Set DASHSCOPE_API_KEY and re-run."
    );
    process.exit(1);
  }
  console.log(`Re-ranking ${QUERIES.length} queries over ${CORPUS.length} memories with ${reranker.modelId}…`);

  const docs = CORPUS.map((m) => ({ id: m.id, content: m.content }));
  const scores: Record<string, Record<string, number>> = {};
  for (const q of QUERIES) {
    const ranked = await reranker.rerank(q.text, docs);
    const row: Record<string, number> = {};
    for (const r of ranked) row[r.id] = Math.round(r.score * 1e4) / 1e4;
    scores[q.id] = row;
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const fixture: RerankFixture = {
    model: reranker.modelId,
    generatedAt: new Date().toISOString(),
    scores,
  };
  mkdirSync(dirname(RERANK_FIXTURE_PATH), { recursive: true });
  writeFileSync(RERANK_FIXTURE_PATH, JSON.stringify(fixture, null, 0));
  console.log(`Wrote ${RERANK_FIXTURE_PATH} (${Object.keys(scores).length} query score-rows).`);
}

main().catch((err) => {
  console.error("bench:rerank failed:", err);
  process.exit(1);
});
