// Retrieval benchmark runner — the "measurable win vs baselines" deliverable.
//
//   npm run bench           # replay the committed real-embedding fixture, print table
//   npm run bench -- --gate # same, but exit non-zero if enhanced < naive (CI gate)
//   npm run bench -- --fake # offline harness sanity with FakeEmbedder (no fixture,
//                             no key) — proves the harness runs; NOT a semantic claim
//
// Conditions (all over the SAME shared retrieval engine in src/memory/retrieval.ts):
//   no-memory     — retrieves nothing (the stateless baseline; all metrics 0)
//   lexical-bm25  — sparse keyword retrieval only
//   naive-vector  — dense top-k (the naive-RAG baseline)
//   hybrid-rrf    — RRF fusion of dense + lexical (our enhancement)
//   hybrid+mmr    — hybrid, then MMR diversity re-ranking (our enhancement)
//
// The headline claim (hybrid beats naive) is measured on REAL text-embedding-v4
// vectors cached in the fixture — never on the Fake, whose bag-of-words hash is
// already lexical and would hide the effect.

import { CORPUS, QUERIES, type BenchQuery } from "./dataset.js";
import { loadFixture } from "./fixture.js";
import {
  retrieveVector,
  retrieveLexical,
  retrieveHybrid,
  retrieveHybridMMR,
  type Candidate,
} from "../src/memory/retrieval.js";
import { aggregate, type MetricRow } from "./metrics.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";

type Retriever = (q: { id: string; text: string; embedding: number[] }, corpus: Candidate[], k: number) => string[];

const K = 5;

const CONDITIONS: Array<{ name: string; run: Retriever }> = [
  { name: "no-memory", run: () => [] },
  { name: "lexical-bm25", run: (q, corpus, k) => retrieveLexical({ text: q.text }, corpus, k) },
  { name: "naive-vector", run: (q, corpus, k) => retrieveVector({ embedding: q.embedding }, corpus, k) },
  { name: "hybrid-rrf", run: (q, corpus, k) => retrieveHybrid({ text: q.text, embedding: q.embedding }, corpus, k) },
  { name: "hybrid+mmr", run: (q, corpus, k) => retrieveHybridMMR({ text: q.text, embedding: q.embedding }, corpus, k) },
];

async function buildInputs(useFake: boolean): Promise<{
  corpus: Candidate[];
  queryVecs: Map<string, number[]>;
  model: string;
}> {
  if (useFake) {
    const fake = new FakeEmbedder();
    const corpus: Candidate[] = [];
    for (const m of CORPUS) corpus.push({ id: m.id, content: m.content, embedding: await fake.embed(m.content) });
    const queryVecs = new Map<string, number[]>();
    for (const q of QUERIES) queryVecs.set(q.id, await fake.embed(q.text));
    return { corpus, queryVecs, model: fake.modelId };
  }
  const fx = loadFixture();
  if (!fx) {
    throw new Error(
      "No embedding fixture found. Run `npm run bench:embed` (needs DASHSCOPE_API_KEY) " +
        "to build bench/fixtures/embeddings.json, or use `--fake` for an offline harness check."
    );
  }
  const corpus: Candidate[] = CORPUS.map((m) => {
    const embedding = fx.memories[m.id];
    if (!embedding) throw new Error(`fixture missing memory embedding ${m.id} — re-run bench:embed`);
    return { id: m.id, content: m.content, embedding };
  });
  const queryVecs = new Map<string, number[]>();
  for (const q of QUERIES) {
    const v = fx.queries[q.id];
    if (!v) throw new Error(`fixture missing query embedding ${q.id} — re-run bench:embed`);
    queryVecs.set(q.id, v);
  }
  return { corpus, queryVecs, model: fx.model };
}

function runCondition(
  run: Retriever,
  corpus: Candidate[],
  queryVecs: Map<string, number[]>,
  filter?: BenchQuery["genre"]
): MetricRow {
  const rows = QUERIES.filter((q) => (filter ? q.genre === filter : true)).map((q) => {
    const embedding = queryVecs.get(q.id)!;
    const ranked = run({ id: q.id, text: q.text, embedding }, corpus, K);
    return { ranked, gold: q.gold };
  });
  return aggregate(rows);
}

function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5) + "%";
}

function fmt(row: MetricRow): string {
  return `R@3 ${pct(row.recallAt3)}  R@5 ${pct(row.recallAt5)}  MRR ${row.mrr.toFixed(3)}  nDCG@5 ${row.ndcgAt5.toFixed(3)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const gate = args.includes("--gate");
  const useFake = args.includes("--fake");

  const { corpus, queryVecs, model } = await buildInputs(useFake);

  console.log(`\nArchon MemoryAgent — retrieval benchmark`);
  console.log(`Embeddings: ${model}${useFake ? "  (OFFLINE harness check — not a semantic claim)" : "  (real, from fixture)"}`);
  console.log(`Corpus: ${corpus.length} memories · Queries: ${QUERIES.length} · k=${K}\n`);

  const results = new Map<string, MetricRow>();
  console.log(`Condition        Overall`);
  console.log(`${"-".repeat(78)}`);
  for (const c of CONDITIONS) {
    const overall = runCondition(c.run, corpus, queryVecs, undefined);
    results.set(c.name, overall);
    console.log(`${c.name.padEnd(15)}  ${fmt(overall)}`);
  }

  console.log(`\nBy query genre (Recall@5):`);
  console.log(`${"-".repeat(78)}`);
  const genres: BenchQuery["genre"][] = ["paraphrase", "specific", "mixed"];
  const header = "Condition".padEnd(15) + genres.map((g) => g.padStart(12)).join("");
  console.log(header);
  for (const c of CONDITIONS) {
    const cells = genres.map((g) => pct(runCondition(c.run, corpus, queryVecs, g).recallAt5).padStart(12));
    console.log(c.name.padEnd(15) + cells.join(""));
  }

  if (gate) {
    if (useFake) {
      console.error("\n--gate requires the real fixture (do not gate on --fake).");
      process.exit(2);
    }
    const naive = results.get("naive-vector")!;
    const hybrid = results.get("hybrid-rrf")!;
    const checks: Array<[string, number, number]> = [
      ["Recall@5", hybrid.recallAt5, naive.recallAt5],
      ["MRR", hybrid.mrr, naive.mrr],
      ["nDCG@5", hybrid.ndcgAt5, naive.ndcgAt5],
    ];
    let ok = true;
    console.log(`\nGate: hybrid-rrf must be >= naive-vector on every metric`);
    for (const [name, h, n] of checks) {
      const pass = h >= n - 1e-9;
      ok = ok && pass;
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}: hybrid ${h.toFixed(3)} vs naive ${n.toFixed(3)}`);
    }
    if (!ok) {
      console.error("\nGATE FAILED — the enhancement regressed below the naive baseline.");
      process.exit(1);
    }
    console.log("\nGATE PASSED.");
  }
}

main().catch((err) => {
  console.error("bench failed:", err);
  process.exit(1);
});
