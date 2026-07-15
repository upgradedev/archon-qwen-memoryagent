// E2E — the READINESS GATE runs and the OFFLINE automatable path clears the bar.
//
// This proves the gate is executable, self-consistent, and green on the offline
// path (no DB, no key, no network): the same guarantee CI's `readiness` job gives,
// asserted here inside the test pyramid so a regression that drops automatable
// completeness below 95% fails the build in two independent places.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("readiness requires access-free public video visibility without naming alternate modes", async () => {
  const report = await runChecks();
  const mediaContract = report.criteria
    .find((c) => c.criterion === "Presentation")!
    .checks.find((r) => r.id === "Pr2-final-media-contract")!;
  assert.equal(mediaContract.status, "pass", `final-media contract must pass: ${mediaContract.detail}`);
  assert.match(mediaContract.detail, /public=true/);

  const checklist = readFileSync(new URL("../../demo/FINAL_MEDIA_CHECKLIST.md", import.meta.url), "utf8");
  assert.match(checklist, /Public visibility with no login or access request/i);
  assert.doesNotMatch(checklist, /Public\s*\(not\s+(?:Unlisted|Private)/i);
});

test("judge-facing handoff uses the canonical 16:9 architecture hero", () => {
  const checklist = readFileSync(new URL("../../demo/FINAL_MEDIA_CHECKLIST.md", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const story = readFileSync(new URL("../../demo/PROJECT_STORY.md", import.meta.url), "utf8");

  assert.match(checklist, /0:29–0:53[^\n]+demo\/final-media\/judge-architecture\.jpg/);
  assert.match(checklist, /Architecture: use the canonical 16:9[^\n]+final-media\/judge-architecture\.jpg/i);
  assert.match(checklist, /Architecture: upload the canonical 16:9[^\n]+final-media\/judge-architecture\.jpg/i);
  assert.doesNotMatch(checklist, /Architecture: (?:export\/use|upload)[^\n]+docs\/architecture\.png/i);
  assert.match(readme, /Judge-facing 16:9 submission hero:[^\n]+demo\/final-media\/judge-architecture\.jpg/i);
  assert.match(story, /canonical judge-facing asset is the 16:9[^\n]+demo\/final-media\/judge-architecture\.jpg/i);
  assert.match(story, /dense[^\n]+docs\/architecture\.png[^\n]+technical appendix/i);
});

test("readiness gates the NEW assurance dimension (security / load / e2e) on top of the rubric", async () => {
  delete process.env.DASHSCOPE_API_KEY;
  const report = await runChecks();

  // The assurance dimension is separate from the 4 weighted rubric criteria, so it
  // does NOT distort the sum-to-100 invariant above — but it IS gated.
  assert.ok(Array.isArray(report.assurance) && report.assurance.length >= 3, "expected the security/load/e2e assurance checks");
  const ids = report.assurance.map((r) => r.id).sort();
  assert.deepEqual(ids, ["E2E1-e2e-layer", "LOAD1-load-layer", "SEC1-pentest-layer"]);
  for (const r of report.assurance) {
    assert.equal(r.criterion, "Assurance", `${r.id} must be classed under the Assurance dimension`);
    assert.equal(r.status, "pass", `assurance check ${r.id} must pass: ${r.detail}`);
  }
  assert.equal(report.assuranceCompletenessPct, 100, "every assurance layer must be wired");

  // The composite gate requires BOTH the rubric bar AND all assurance checks.
  assert.equal(report.gate.rubricPass, true);
  assert.equal(report.gate.assurancePass, true);
  assert.equal(report.gate.pass, true, "gate is green only when rubric AND assurance both pass");
});

test("the 4 weighted rubric criteria still sum to 100 — the assurance dimension does not leak into them", async () => {
  const report = await runChecks();
  // Re-assert the invariant explicitly now that a 5th (non-rubric) criterion name
  // exists: Assurance checks must NOT appear inside report.criteria.
  const rubricNames = report.criteria.map((c) => c.criterion);
  assert.ok(!rubricNames.includes("Assurance" as never), "Assurance must never be a rubric criterion");
  const totalAutomatable = report.criteria.reduce((s, c) => s + c.automatableWeight, 0);
  assert.equal(totalAutomatable, 100);
});

test("live-deploy and hosted-video checks are correctly classed user-gated (excluded from automatable %)", async () => {
  const report = await runChecks();
  const ids = report.userGated.map((r) => r.id).sort();
  assert.ok(ids.includes("UG1-live-semantic-route"), "live-box probe must be user-gated");
  assert.ok(ids.includes("UG2-video-hosted"), "hosted-video must be user-gated");
  assert.ok(ids.includes("UG3-final-video-reviewed"), "new canonical video review must be user-gated");
  for (const r of report.userGated) assert.equal(r.status, "user-gated");
});
