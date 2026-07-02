// Contradiction-RESOLUTION evaluation — the measured recommender claim.
//
//   npm run bench:resolution          # print resolution accuracy, exit 0
//   npm run bench:resolution -- --gate  # also FAIL on regression (CI gate)
//
// Runs the pure `auditConsistency` engine over the labelled resolution dataset
// and reports, for every detected contradiction, whether the recommender picked
// the hand-labelled winning memory and applied the expected rule.
//
// The gate enforces only ROBUST, deterministic facts (mirroring the repo's
// philosophy of never gating brittle numbers):
//   • every contradiction carries a resolution whose recommendedMemoryId is one
//     of that contradiction's own memories, with confidence in [0,1]  (structural)
//   • winner-accuracy == 100% against the labelled policy                (conformance)
// Rule-accuracy is REPORTED but framed as diagnostic. Offline, no key, no DB.

import { auditConsistency } from "../src/memory/consistency.js";
import { RESOLUTION_CASE } from "./resolution-dataset.js";

function key(subject: string, attribute: string): string {
  return `${subject}::${attribute}`;
}

function main() {
  const gate = process.argv.slice(2).includes("--gate");
  const { memories, expect } = RESOLUTION_CASE;

  const report = auditConsistency(memories);
  const byKey = new Map(report.contradictions.map((c) => [key(c.subject, c.attribute), c]));
  const gold = new Map(expect.map((e) => [key(e.subject, e.attribute), e]));

  console.log(`\nArchon MemoryAgent — contradiction-resolution evaluation`);
  console.log(`Contradictions: ${report.contradictions.length}  ·  labelled: ${expect.length}\n`);

  let winnerHits = 0;
  let ruleHits = 0;
  let structuralFails = 0;
  const allMemIds = new Set(memories.map((m) => m.id));

  for (const e of expect) {
    const c = byKey.get(key(e.subject, e.attribute));
    if (!c) {
      console.log(`  [MISS] ${e.subject}.${e.attribute}: expected a contradiction, none raised`);
      structuralFails++;
      continue;
    }
    const r = c.resolution;
    const winnerOk = r.recommendedMemoryId === e.winnerMemoryId;
    const ruleOk = r.rule === e.rule;
    // Structural invariants (robust, non-circular): the recommendation must point
    // at a real memory of THIS contradiction, at a confidence in [0,1].
    const carriesId = c.values.some((v) => v.memoryId === r.recommendedMemoryId);
    const idIsReal = allMemIds.has(r.recommendedMemoryId);
    const confOk = r.confidence >= 0 && r.confidence <= 1;
    // recommendedMemoryId may be the LATEST carrier of a value while values[]
    // lists the earliest representative, so accept either "in values[]" or "the
    // labelled winner" as evidence it points at a real contradiction memory.
    const structuralOk = idIsReal && confOk && (carriesId || winnerOk);
    if (!structuralOk) structuralFails++;
    if (winnerOk) winnerHits++;
    if (ruleOk) ruleHits++;

    const tag = winnerOk ? (ruleOk ? "OK " : "RULE?") : "WRONG";
    console.log(
      `  [${tag}] ${e.subject}.${e.attribute}: → ${r.recommendedMemoryId} ` +
        `(${fmt(r.recommendedValue)}) via ${r.rule} conf=${r.confidence}` +
        (winnerOk ? "" : ` — expected ${e.winnerMemoryId} via ${e.rule}`)
    );
    console.log(`         ${r.rationale}`);
  }

  const n = expect.length;
  const winnerAcc = n ? (100 * winnerHits) / n : 100;
  const ruleAcc = n ? (100 * ruleHits) / n : 100;

  console.log(`\n${"-".repeat(60)}`);
  console.log(`Labelled contradictions : ${n}`);
  console.log(`Winner accuracy         : ${winnerHits}/${n}  (${winnerAcc.toFixed(1)}%)`);
  console.log(`Rule accuracy           : ${ruleHits}/${n}  (${ruleAcc.toFixed(1)}%)`);
  console.log(`Structural failures     : ${structuralFails}`);

  if (gate) {
    const ok = structuralFails === 0 && winnerHits === n;
    if (!ok) {
      console.error(
        `\nGATE FAILED — winner ${winnerHits}/${n}, ${structuralFails} structural failure(s).`
      );
      process.exit(1);
    }
    console.log(`\nGATE PASSED — ${winnerHits}/${n} winners correct, 0 structural failures.`);
  }
}

function fmt(v: unknown): string {
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

main();
