// Objective figure-hit / traceability benchmark for our own frozen fixture.
//
//   npm run bench:accuracy          # replay the committed answers, print the table
//   npm run bench:accuracy -- --gate  # also FAIL if below the enforced floors (CI)
//
// Fully OFFLINE and DETERMINISTIC: it replays the qwen-plus answers cached in
// bench/fixtures/answers.json (built once by bench:answers) and grades them by
// NUMBER PRESENCE — no LLM-judge, no prose grading. Three measures:
//
//   RECALL      — did hybrid recall surface the gold memory into the top-5?
//   GOLD EUR-TOKEN HIT — does the narrated answer state a labelled gold amount?
//   COMPLETE EUR-LABELLED TRACEABILITY — does EVERY EUR-labelled amount in
//                 the answer occur in a recalled memory?
//
// Why grading prose numbers is legitimate here (BENCHMARK.md expands): we do NOT
// grade phrasing or use an LLM judge (brittle + circular). We grade whether a
// specific, labelled FIGURE is present and whether every asserted euro figure
// is traceable — both objective, reproducible string/number facts. These narrow
// metrics are not general answer correctness or semantic faithfulness scores.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACCURACY_SET } from "./accuracy-dataset.js";
import { euroFiguresIn } from "./accuracy-common.js";
import { CORPUS } from "./dataset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "answers.json");

interface AnswersFixture {
  model: string;
  generatedAt: string;
  recallK: number;
  answers: Record<string, { question: string; recalledIds: string[]; answer: string }>;
}

// Enforced FLOORS. Set to the MEASURED result, not an aspiration — the benchmark
// reports the live numbers every run; these gates fail CI only on a real regression.
// Grounding floor is 0.90, not 1.0, and here is the honest reason: on the frozen
// fixture 10/11 answers are perfectly grounded; the one miss (q08) is the narrator
// DERIVING €2,800 = operating-profit €41,200 − EBITDA €38,400 (the D&A gap) — an
// arithmetically-correct but not-stored figure. The grounding metric CORRECTLY
// flags it (that is the metric working, not failing). We floor at what the shipped
// narrator actually achieves and catch any regression below it.
const GATE_GOLD_FIGURE_HIT = 1.0;
const GATE_COMPLETE_EURO_FIGURE_TRACEABILITY = 0.9; // ≤1 derived/untraceable figure across all answers

function main() {
  const gate = process.argv.slice(2).includes("--gate");
  if (!existsSync(FIXTURE)) {
    console.error(`No answers fixture at ${FIXTURE} — run \`npm run bench:answers\` (needs DASHSCOPE_API_KEY).`);
    process.exit(2);
  }
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as AnswersFixture;
  const content = new Map(CORPUS.map((m) => [m.id, m.content]));

  console.log(`\nArchon MemoryAgent — objective figure traceability (${fx.model}, replayed from fixture)`);
  console.log(`Questions: ${ACCURACY_SET.length} · recall: hybrid top-${fx.recallK}\n`);
  console.log(`Query  Recall  Gold hit  Traceable  Answer figures`);
  console.log("-".repeat(78));

  let recallHit = 0, goldFigureHit = 0, completeTraceability = 0;
  for (const q of ACCURACY_SET) {
    const row = fx.answers[q.id];
    if (!row) {
      console.error(`fixture missing answer for ${q.id} — re-run bench:answers`);
      process.exit(2);
    }
    // RECALL: any gold memory in the recalled set.
    const golds = q.goldMemory.split("/");
    const rHit = golds.some((g) => row.recalledIds.includes(g));
    // GOLD EUR-TOKEN HIT: a developer-labelled amount appears with an explicit
    // EUR/€ marker; dates and percentages cannot satisfy this check by accident.
    const answerEuroFigures = euroFiguresIn(row.answer);
    const hasGoldFigure = q.goldFigures.some((f) => answerEuroFigures.includes(f));
    // TRACEABILITY: every EUR-labelled amount appears, also EUR-labelled, in a
    // recalled memory. This is literal provenance—not prose or arithmetic truth.
    const recalledNums = new Set<number>();
    for (const id of row.recalledIds) for (const n of euroFiguresIn(content.get(id) ?? "")) recalledNums.add(n);
    const figs = answerEuroFigures;
    const untraceable = figs.filter((f) => !recalledNums.has(f));
    const isCompletelyTraceable = untraceable.length === 0;

    recallHit += rHit ? 1 : 0;
    goldFigureHit += hasGoldFigure ? 1 : 0;
    completeTraceability += isCompletelyTraceable ? 1 : 0;

    const mark = (b: boolean) => (b ? "  ✓  " : "  ✗  ");
    console.log(
      `${q.id.padEnd(6)}${mark(rHit)}  ${mark(hasGoldFigure)}  ${mark(isCompletelyTraceable)}   ` +
        `[${figs.join(", ")}]${untraceable.length ? `  UNTRACEABLE: ${untraceable.join(", ")}` : ""}`
    );
  }

  const n = ACCURACY_SET.length;
  const pRecall = recallHit / n;
  const pGoldFigureHit = goldFigureHit / n;
  const pCompleteTraceability = completeTraceability / n;
  console.log("-".repeat(78));
  console.log(`Gold-memory recall@${fx.recallK} : ${recallHit}/${n}  (${(pRecall * 100).toFixed(1)}%)`);
  console.log(`Gold EUR-token hit      : ${goldFigureHit}/${n}  (${(pGoldFigureHit * 100).toFixed(1)}%)`);
  console.log(`Complete EUR traceability: ${completeTraceability}/${n}  (${(pCompleteTraceability * 100).toFixed(1)}%)`);

  if (gate) {
    const ok = pGoldFigureHit >= GATE_GOLD_FIGURE_HIT - 1e-9 && pCompleteTraceability >= GATE_COMPLETE_EURO_FIGURE_TRACEABILITY - 1e-9;
    console.log(`\nGate: gold EUR-token hit ≥ ${(GATE_GOLD_FIGURE_HIT * 100).toFixed(0)}% AND complete EUR traceability ≥ ${(GATE_COMPLETE_EURO_FIGURE_TRACEABILITY * 100).toFixed(0)}%`);
    if (!ok) {
      console.error(
        `\nGATE FAILED — gold EUR-token hit ${(pGoldFigureHit * 100).toFixed(1)}%, complete EUR traceability ${(pCompleteTraceability * 100).toFixed(1)}%.`
      );
      process.exit(1);
    }
    console.log("GATE PASSED.");
  }
}

main();
