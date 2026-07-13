// E2E — the READINESS GATE runs and the OFFLINE automatable path clears the bar.
//
// This proves the gate is executable, self-consistent, and green on the offline
// path (no DB, no key, no network): the same guarantee CI's `readiness` job gives,
// asserted here inside the test pyramid so a regression that drops automatable
// completeness below 95% fails the build in two independent places.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks } from "../../scripts/readiness.js";

test("readiness gate runs offline and clears the 95% automatable bar", async () => {
  delete process.env.DASHSCOPE_API_KEY; // force the offline Fakes
  const report = await runChecks();

  // The gate is meaningful only if it CAN fail — assert the shape, then the pass.
  assert.ok(report.automatableChecks >= 10, "expected a real check catalogue");
  assert.ok(
    report.automatableCompletenessPct >= 95,
    `automatable completeness ${report.automatableCompletenessPct}% < 95% — failing checks: ${report.criteria
      .flatMap((c) => c.checks)
      .filter((r) => r.status === "fail")
      .map((r) => `${r.id} (${r.detail})`)
      .join("; ")}`,
  );
  assert.equal(report.gate.pass, true, "gate must pass on the offline path");
});

test("readiness encodes all four weighted rubric criteria", async () => {
  const report = await runChecks();
  const names = report.criteria.map((c) => c.criterion).sort();
  assert.deepEqual(names, ["Innovation", "Presentation", "Problem", "Technical"]);
  const weights = Object.fromEntries(report.criteria.map((c) => [c.criterion, c.rubricWeight]));
  assert.deepEqual(weights, { Technical: 30, Innovation: 30, Problem: 25, Presentation: 15 });
  // Automatable weights across all criteria must sum to the full 100-point rubric.
  const totalAutomatable = report.criteria.reduce((s, c) => s + c.automatableWeight, 0);
  assert.equal(totalAutomatable, 100, "automatable check weights must sum to the 100-point rubric");
});

test("readiness surfaces the measured semantic number and it is internally consistent", async () => {
  const report = await runChecks();
  // The measured detector number is present and honest (recall 90, precision 100).
  assert.equal(report.semantic.precisionPct, 100);
  assert.equal(report.semantic.falsePositives, 0);
  assert.ok(report.semantic.recallPct >= 90);
  assert.ok(report.semantic.contradictionsSurfaced > 0);
  assert.equal(report.semantic.ruleBasedCaught, 0, "the rule-based audit must catch 0 of the meaning-level contradictions");

  // The Problem-value consistency check (P2) must itself be passing.
  const p2 = report.criteria
    .find((c) => c.criterion === "Problem")!
    .checks.find((r) => r.id === "P2-impact-consistent")!;
  assert.equal(p2.status, "pass", `impact number must be consistent (computed==golden==docs): ${p2.detail}`);
});

test("live-deploy and hosted-video checks are correctly classed user-gated (excluded from automatable %)", async () => {
  const report = await runChecks();
  const ids = report.userGated.map((r) => r.id).sort();
  assert.ok(ids.includes("UG1-live-semantic-route"), "live-box probe must be user-gated");
  assert.ok(ids.includes("UG2-video-hosted"), "hosted-video must be user-gated");
  for (const r of report.userGated) assert.equal(r.status, "user-gated");
});
