// Build the grounded-answer fixture — the ONE real qwen-plus pass the accuracy
// benchmark caches so CI can replay it offline (mirrors bench:embed / bench:rerank).
//
//   npm run bench:answers      # needs DASHSCOPE_API_KEY; writes bench/fixtures/answers.json
//
// For each labelled query it runs the SHIPPED recall path (hybrid, top-5) over the
// committed embedding fixture, then asks the SHIPPED QwenNarrator (qwen-plus) for a
// grounded, cited answer — exactly what POST /recall does in production — and
// commits {answer, recalledIds}. The accuracy grader (bench:accuracy) then replays
// these with NO key and grades them deterministically (number presence/grounding).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACCURACY_SET } from "./accuracy-dataset.js";
import {
  loadCorpus,
  queryEmbedding,
  recallHybrid,
  contentById,
} from "./accuracy-common.js";
import { cosineSimilarity } from "../src/memory/retrieval.js";
import { QwenNarrator } from "../src/agents/narrator.js";
import { hasQwenCreds } from "../src/qwen/client.js";
import { sanitizedOperationalFailure } from "../src/server/error-sanitization.js";
import type { RecallHit } from "../src/memory/store.js";
import { CORPUS } from "./dataset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "fixtures", "answers.json");

async function main() {
  if (!hasQwenCreds()) {
    console.error("bench:answers needs DASHSCOPE_API_KEY (it makes one real qwen-plus pass to build the fixture).");
    process.exit(2);
  }
  const corpus = loadCorpus();
  const byId = contentById(corpus);
  const metaById = new Map(CORPUS.map((m) => [m.id, m]));
  const narrator = new QwenNarrator();

  const answers: Record<string, { question: string; recalledIds: string[]; answer: string }> = {};
  for (const q of ACCURACY_SET) {
    const emb = queryEmbedding(q.id);
    const recalledIds = recallHybrid(q.question, emb, corpus);
    // Reconstruct the RecallHit[] the narrator receives in production (real cosine
    // for score; hybrid decided the ORDER).
    const hits: RecallHit[] = recalledIds.map((id) => {
      const score = cosineSimilarity(emb, corpus.find((c) => c.id === id)!.embedding);
      return {
        id,
        kind: "document",
        company: "",
        period: null,
        sourceRef: metaById.get(id)?.id ?? null,
        content: byId.get(id)!,
        metadata: null,
        createdAt: new Date().toISOString(),
        distance: 1 - score,
        score,
      };
    });
    const { answer } = await narrator.narrate(q.question, hits);
    answers[q.id] = { question: q.question, recalledIds, answer };
    console.log(`  ${q.id}: recalled [${recalledIds.join(", ")}] -> ${answer.slice(0, 90)}...`);
  }

  const fixture = {
    model: process.env.QWEN_MODEL || "qwen-plus",
    generatedAt: new Date().toISOString(),
    recallK: 5,
    answers,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`\nwrote ${OUT}  (${Object.keys(answers).length} grounded answers)`);
}

main().catch((error) => {
  console.error("bench:answers failed", sanitizedOperationalFailure("answer_fixture", error));
  process.exit(1);
});
