// Meaning-level (semantic) self-auditing evaluation — the MEASURED number.
//
//   npm run bench:semantic            # print recall / precision / FP-rate, exit 0
//   npm run bench:semantic -- --gate  # also FAIL below the enforced floors (CI)
//
// Runs the pure `detectSemanticContradictions` engine over the labelled corpus
// (bench/semantic-consistency-dataset.ts) with the deterministic offline
// `FakeJudge` — the exact path CI and the live box's `/consistency/semantic` take
// with no DashScope key. Reports:
//   recall     — same-subject opposed pairs the offline judge catches
//   PRECISION  — the load-bearing number: false positives are the dangerous
//                failure (a hallucinated contradiction is a trust regression), so
//                the gate is HARD on precision (0 FP required)
//   FP-rate    — false positives / non-contradiction pairs that were judged
//   surfaced   — contradictions the meaning-level audit surfaces that the RULE-
//                BASED audit (and any naive store) serve as truth (it catches 0)
//
// Offline, deterministic, no key, no DB — same engine, same judge as the route.

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { detectSemanticContradictions, FakeJudge } from "../src/memory/semantic-consistency.js";
import { auditConsistency } from "../src/memory/consistency.js";
import {
  buildSemanticBenchCorpus,
  corpusAsAuditMemories,
  SEMANTIC_BENCH_THRESHOLD,
} from "./semantic-consistency-dataset.js";

// Enforced FLOORS — set to the MEASURED result, not an aspiration (same stance as
// bench/accuracy-run.ts, which floors grounding at its real 0.909 with a reason).
//
// PRECISION floor 100%: the control set exists precisely to keep the audit silent
// on things that only LOOK like conflicts (agreeing, negation-agreeing,
// complementary, cross-cluster, different-subject); a false positive is a trust
// regression, so we gate hard on it.
//
// RECALL floor 90%: the offline heuristic honestly catches 9 of 10 labelled
// contradictions. The one miss is CUE-FREE ("ahead of schedule" vs "behind
// schedule") — no lexical polarity cue the offline judge can see. That is not a
// bug to paper over with a 100% target: it is the documented reason the ONLINE
// qwen-plus judge exists. We floor at what the shipped offline judge actually
// achieves and catch any regression below it.
export const GATE_PRECISION_PCT = 100;
export const GATE_RECALL_PCT = 90;

export interface SemanticBenchResult {
  audited: number; // memories examined
  compared: number; // pairs that cleared the subject gate (judge calls made)
  gold: number; // labelled same-subject contradiction pairs
  truePositives: number; // gold pairs the offline judge flagged
  falsePositives: number; // non-gold pairs the offline judge flagged (must be 0)
  offlineMisses: number; // gold pairs the offline judge missed (the cue-free case)
  recallPct: number;
  precisionPct: number;
  fpRatePct: number;
  // Problem-value: meaning-level contradictions the self-audit SURFACES that the
  // rule-based field-level audit — and any naive vector store — serve as truth.
  contradictionsSurfaced: number; // == truePositives
  ruleBasedCaught: number; // rule-based audit's catches on the SAME corpus (0)
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

// Importable core — no stdout, no process.exit — so the readiness gate and the
// unit test can assert on the numbers directly (no output parsing).
export async function runSemanticBench(): Promise<SemanticBenchResult> {
  const { memories, goldPairs } = buildSemanticBenchCorpus();

  const report = await detectSemanticContradictions(memories, new FakeJudge(), {
    similarityThreshold: SEMANTIC_BENCH_THRESHOLD,
  });

  let truePositives = 0;
  let falsePositives = 0;
  for (const f of report.semanticContradictions) {
    const key = f.memories
      .map((m) => m.memoryId)
      .sort()
      .join("|");
    if (goldPairs.has(key)) truePositives++;
    else falsePositives++;
  }

  const gold = goldPairs.size;
  // Every gold pair is same-subject (shares an axis) → all cleared the gate, so
  // the non-contradiction pairs actually judged = compared − gold.
  const nonGoldJudged = Math.max(1, report.compared - gold);
  const offlineMisses = gold - truePositives;

  const ruleBasedCaught = auditConsistency(corpusAsAuditMemories()).contradictions.length;

  return {
    audited: report.audited,
    compared: report.compared,
    gold,
    truePositives,
    falsePositives,
    offlineMisses,
    recallPct: round1(gold ? (100 * truePositives) / gold : 0),
    precisionPct: round1(truePositives + falsePositives ? (100 * truePositives) / (truePositives + falsePositives) : 100),
    fpRatePct: round1((100 * falsePositives) / nonGoldJudged),
    contradictionsSurfaced: truePositives,
    ruleBasedCaught,
  };
}

async function main() {
  const gate = process.argv.slice(2).includes("--gate");
  const r = await runSemanticBench();

  console.log(`\nArchon MemoryAgent — meaning-level (semantic) self-audit evaluation`);
  console.log(`Memories audited: ${r.audited}  ·  pairs judged (subject gate): ${r.compared}\n`);
  console.log(`${"-".repeat(64)}`);
  console.log(`Labelled contradictions : ${r.gold}`);
  console.log(`Detected (true positives): ${r.truePositives}/${r.gold}`);
  console.log(`Offline misses (cue-free): ${r.offlineMisses}  (the qwen-plus judge closes these online)`);
  console.log(`False positives (control): ${r.falsePositives}`);
  console.log(`Recall                   : ${r.recallPct.toFixed(1)}%`);
  console.log(`Precision                : ${r.precisionPct.toFixed(1)}%`);
  console.log(`False-positive rate      : ${r.fpRatePct.toFixed(1)}%`);
  console.log(`${"-".repeat(64)}`);
  console.log(
    `Contradictions surfaced  : ${r.contradictionsSurfaced}  ← meaning-level conflicts the self-audit flags`,
  );
  console.log(
    `Rule-based caught (same corpus): ${r.ruleBasedCaught}  ← what a field-level audit / naive store serves as truth`,
  );

  if (gate) {
    const ok =
      r.falsePositives === 0 &&
      r.precisionPct >= GATE_PRECISION_PCT - 1e-9 &&
      r.recallPct >= GATE_RECALL_PCT - 1e-9;
    console.log(
      `\nGate: precision ≥ ${GATE_PRECISION_PCT}% (0 FP) AND recall ≥ ${GATE_RECALL_PCT}%`,
    );
    if (!ok) {
      console.error(
        `\nGATE FAILED — precision ${r.precisionPct.toFixed(1)}% (${r.falsePositives} FP), recall ${r.recallPct.toFixed(1)}%.`,
      );
      process.exit(1);
    }
    console.log(`GATE PASSED — ${r.truePositives}/${r.gold} detected, 0 false positives.`);
  }
}

// Run as a CLI only when invoked directly (not when imported by readiness / tests).
// Compare canonical real paths so it works under tsx on any OS (avoids brittle
// file:// URL string matching / Windows drive-letter casing).
const isDirect = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirect) {
  main();
}
