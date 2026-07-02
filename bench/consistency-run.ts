// Self-auditing memory-consistency evaluation — the measured claim.
//
//   npm run bench:consistency         # print detection + precision, exit 0
//   npm run bench:consistency -- --gate  # also FAIL if not perfect (CI gate)
//
// Runs the pure `auditConsistency` engine over the labelled dataset and reports:
//   detection — injected contradictions + absences the audit found (recall)
//   precision — findings that were genuinely labelled (no false positives on the
//               consistent control set: agreeing re-ingests, float-noise,
//               different records sharing an attribute name).
// Offline, deterministic, no key, no DB — same engine the /consistency route uses.

import { auditConsistency } from "../src/memory/consistency.js";
import { CONSISTENCY_CASE } from "./consistency-dataset.js";

function key(subject: string, attribute: string): string {
  return `${subject}::${attribute}`;
}

function main() {
  const gate = process.argv.slice(2).includes("--gate");
  const { memories, expectContradictions, expectAbsences } = CONSISTENCY_CASE;

  const report = auditConsistency(memories);

  const goldC = new Set(expectContradictions.map((e) => key(e.subject, e.attribute)));
  const gotC = new Set(report.contradictions.map((c) => key(c.subject, c.attribute)));
  const goldA = new Set(expectAbsences);
  const gotA = new Set(report.absences.map((a) => a.subject));

  const cTrue = [...gotC].filter((k) => goldC.has(k)).length;
  const cFalse = [...gotC].filter((k) => !goldC.has(k)).length;
  const aTrue = [...gotA].filter((k) => goldA.has(k)).length;
  const aFalse = [...gotA].filter((k) => !goldA.has(k)).length;

  const injected = goldC.size + goldA.size;
  const detected = cTrue + aTrue;
  const falsePositives = cFalse + aFalse;

  console.log(`\nArchon MemoryAgent — self-auditing memory-consistency evaluation`);
  console.log(`Memories audited: ${report.audited}  ·  distinct records: ${report.subjects}\n`);

  console.log(`Contradictions (cross-session value conflicts):`);
  for (const c of report.contradictions) {
    const vals = c.values.map((v) => `${JSON.stringify(v.value)}@${v.createdAt.slice(0, 10)}`).join(" ≠ ");
    const tag = goldC.has(key(c.subject, c.attribute)) ? "OK " : "FP!";
    console.log(`  [${tag}] ${c.subject}.${c.attribute}: ${vals}`);
  }
  console.log(`\nAbsences (dangling references):`);
  for (const a of report.absences) {
    const tag = goldA.has(a.subject) ? "OK " : "FP!";
    console.log(`  [${tag}] ${a.subject} referenced by ${a.referencedBy.map((r) => r.sourceRef).join(", ")}`);
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(`Injected problems      : ${injected}`);
  console.log(`Detected               : ${detected}/${injected}`);
  console.log(`False positives (control): ${falsePositives}`);
  const detRate = injected ? (100 * detected) / injected : 0;
  const prec = detected + falsePositives ? (100 * detected) / (detected + falsePositives) : 100;
  console.log(`Detection rate         : ${detRate.toFixed(1)}%`);
  console.log(`Precision              : ${prec.toFixed(1)}%`);

  if (gate) {
    const perfect = detected === injected && falsePositives === 0;
    if (!perfect) {
      console.error(`\nGATE FAILED — detected ${detected}/${injected}, ${falsePositives} false positives.`);
      process.exit(1);
    }
    console.log(`\nGATE PASSED — ${detected}/${injected} detected, 0 false positives.`);
  }
}

main();
