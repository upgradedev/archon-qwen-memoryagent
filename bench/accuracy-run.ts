// Grounded-answer accuracy benchmark — the measured number for our OWN pipeline.
//
//   npm run bench:accuracy          # replay the committed answers, print the table
//   npm run bench:accuracy -- --gate  # also FAIL if below the enforced floors (CI)
//
// Fully OFFLINE and DETERMINISTIC: it replays the qwen-plus answers cached in
// bench/fixtures/answers.json (built once by bench:answers) and grades them by
// NUMBER PRESENCE — no LLM-judge, no prose grading. Three measures:
//
//   RECALL      — did hybrid recall surface the gold memory into the top-5?
//   CORRECTNESS — does the narrated answer state a gold figure?
//   GROUNDING   — does EVERY euro figure in the answer trace to a recalled memory
//                 (i.e. no invented figures)? This is the faithfulness number.
//
// Why grading prose numbers is legitimate here (BENCHMARK.md expands): we do NOT
// grade phrasing or use an LLM judge (brittle + circular). We grade whether a
// specific, labelled FIGURE is present and whether every asserted figure is
// grounded — both objective, reproducible string/number facts.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACCURACY_SET } from "./accuracy-dataset.js";
import { numbersIn, euroFiguresIn } from "./accuracy-common.js";
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
const GATE_CORRECTNESS = 1.0; // every labelled question answered with a gold figure
const GATE_GROUNDING = 0.9; // ≤1 derived/ungrounded figure across all answers

function main() {
  const gate = process.argv.slice(2).includes("--gate");
  if (!existsSync(FIXTURE)) {
    console.error(`No answers fixture at ${FIXTURE} — run \`npm run bench:answers\` (needs DASHSCOPE_API_KEY).`);
    process.exit(2);
  }
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as AnswersFixture;
  const content = new Map(CORPUS.map((m) => [m.id, m.content]));

  console.log(`\nArchon MemoryAgent — grounded-answer accuracy (${fx.model}, replayed from fixture)`);
  console.log(`Questions: ${ACCURACY_SET.length} · recall: hybrid top-${fx.recallK}\n`);
  console.log(`Query  Recall  Correct  Grounded  Answer figures`);
  console.log("-".repeat(78));

  let recallHit = 0, correct = 0, grounded = 0;
  for (const q of ACCURACY_SET) {
    const row = fx.answers[q.id];
    if (!row) {
      console.error(`fixture missing answer for ${q.id} — re-run bench:answers`);
      process.exit(2);
    }
    // RECALL: any gold memory in the recalled set.
    const golds = q.goldMemory.split("/");
    const rHit = golds.some((g) => row.recalledIds.includes(g));
    // CORRECTNESS: a gold figure present in the answer.
    const ansNums = numbersIn(row.answer);
    const isCorrect = q.goldFigures.some((f) => ansNums.has(f));
    // GROUNDING: every euro figure in the answer is a number present in a recalled memory.
    const recalledNums = new Set<number>();
    for (const id of row.recalledIds) for (const n of numbersIn(content.get(id) ?? "")) recalledNums.add(n);
    const figs = euroFiguresIn(row.answer);
    const ungrounded = figs.filter((f) => !recalledNums.has(f));
    const isGrounded = ungrounded.length === 0;

    recallHit += rHit ? 1 : 0;
    correct += isCorrect ? 1 : 0;
    grounded += isGrounded ? 1 : 0;

    const mark = (b: boolean) => (b ? "  ✓  " : "  ✗  ");
    console.log(
      `${q.id.padEnd(6)}${mark(rHit)}  ${mark(isCorrect)}  ${mark(isGrounded)}   ` +
        `[${figs.join(", ")}]${ungrounded.length ? `  UNGROUNDED: ${ungrounded.join(", ")}` : ""}`
    );
  }

  const n = ACCURACY_SET.length;
  const pRecall = recallHit / n, pCorrect = correct / n, pGrounded = grounded / n;
  console.log("-".repeat(78));
  console.log(`Gold-memory recall@${fx.recallK} : ${recallHit}/${n}  (${(pRecall * 100).toFixed(1)}%)`);
  console.log(`Answer correctness      : ${correct}/${n}  (${(pCorrect * 100).toFixed(1)}%)`);
  console.log(`Answer grounding        : ${grounded}/${n}  (${(pGrounded * 100).toFixed(1)}%)  ← faithfulness`);

  if (gate) {
    const ok = pCorrect >= GATE_CORRECTNESS - 1e-9 && pGrounded >= GATE_GROUNDING - 1e-9;
    console.log(`\nGate: correctness ≥ ${(GATE_CORRECTNESS * 100).toFixed(0)}% AND grounding ≥ ${(GATE_GROUNDING * 100).toFixed(0)}%`);
    if (!ok) {
      console.error(
        `\nGATE FAILED — correctness ${(pCorrect * 100).toFixed(1)}%, grounding ${(pGrounded * 100).toFixed(1)}%.`
      );
      process.exit(1);
    }
    console.log("GATE PASSED.");
  }
}

main();
