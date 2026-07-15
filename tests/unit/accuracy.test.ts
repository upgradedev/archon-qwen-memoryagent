// Unit tests for the deterministic graders behind the grounded-answer accuracy
// benchmark (numbersIn / euroFiguresIn). These are the objective, no-LLM-judge
// primitives the correctness + grounding measures are built on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersIn, euroFiguresIn } from "../../bench/accuracy-common.js";

test("numbersIn strips thousands separators and parses every numeric value", () => {
  const ns = numbersIn("Invoice total €18,400 and cash €27,600 at 18.3% margin");
  assert.ok(ns.has(18400));
  assert.ok(ns.has(27600));
  assert.ok(ns.has(18.3));
});

test("numbersIn treats '18,400' as one number, not 18 and 400", () => {
  const ns = numbersIn("€18,400");
  assert.ok(ns.has(18400));
  assert.ok(!ns.has(18));
  assert.ok(!ns.has(400));
});

test("euroFiguresIn returns only €-marked figures (grounding claims)", () => {
  const figs = euroFiguresIn("EBITDA was €38,400 on revenue of €210,000 in 2026");
  assert.deepEqual(figs.sort((a, b) => a - b), [38400, 210000]);
  // a bare year is not a euro figure
  assert.ok(!figs.includes(2026));
});

test("euroFiguresIn recognizes EUR symbol/code on either side without counting bare numbers", () => {
  const figs = euroFiguresIn(
    "Four equivalent claims: EUR 18,400; 6,300 EUR; 2,800 €; €1,075.50. " +
    "Bare 2026, 18.3%, and 999 are not monetary claims.",
  );
  assert.deepEqual(figs, [18400, 6300, 2800, 1075.5]);
});

test("euroFiguresIn flags a derived, ungrounded figure for the grounding check", () => {
  // The q08-style case: €2,800 derived by arithmetic, not stored in memory.
  const figs = euroFiguresIn("operating profit €41,200 is €2,800 higher than EBITDA €38,400");
  assert.ok(figs.includes(2800));
  const recalled = new Set([41200, 38400, 210000]); // what memory actually holds
  const ungrounded = figs.filter((f) => !recalled.has(f));
  assert.deepEqual(ungrounded, [2800]);
});
