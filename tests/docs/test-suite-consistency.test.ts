import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  COVERAGE_THRESHOLDS,
  PRODUCT_SUITE_NAMES,
  TEST_SUITES,
  filesForSuites,
  type TestSuiteName,
} from "../../scripts/test-matrix.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readText = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SUITE_DIRS = {
  docs: "tests/docs",
  unit: "tests/unit",
  integration: "tests/integration",
  security: "tests/security",
  e2e: "tests/e2e",
} as const satisfies Record<TestSuiteName, string>;

function discoverTests(relDir: string): string[] {
  const discovered: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(join(ROOT, current), { withFileTypes: true })) {
      const child = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) discovered.push(child);
    }
  };
  walk(relDir);
  return discovered.sort();
}

test("CHECK 5a — the canonical manifest contains every test file exactly once", () => {
  const allManifestFiles = filesForSuites(Object.keys(TEST_SUITES) as TestSuiteName[]);
  assert.equal(new Set(allManifestFiles).size, allManifestFiles.length, "the canonical test manifest contains duplicates");

  for (const [suite, relDir] of Object.entries(SUITE_DIRS) as Array<[TestSuiteName, string]>) {
    const discovered = discoverTests(relDir);
    assert.deepEqual(
      [...TEST_SUITES[suite]].sort(),
      discovered,
      `${suite} manifest drifted from ${relDir}; register every test explicitly`,
    );
  }
});

test("CHECK 5b — package scripts and hosted coverage use the one canonical runner", () => {
  const pkg = JSON.parse(readText("package.json")) as { scripts: Record<string, string> };
  const expectedScripts = {
    "test:docs": "node --import tsx scripts/run-test-suite.ts docs",
    "test:unit": "node --import tsx scripts/run-test-suite.ts unit",
    "test:integration": "node --import tsx scripts/run-test-suite.ts integration",
    "test:e2e": "node --import tsx scripts/run-test-suite.ts e2e",
    "test:security": "node --import tsx scripts/run-test-suite.ts security",
    test: "node --import tsx scripts/run-test-suite.ts all",
    coverage: "node --import tsx scripts/run-test-suite.ts coverage",
    "coverage:unit": "node --import tsx scripts/run-test-suite.ts coverage-unit",
  };
  for (const [name, command] of Object.entries(expectedScripts)) {
    assert.equal(pkg.scripts[name], command, `${name} bypasses the canonical test runner`);
  }

  const workflow = readText(".github/workflows/ci.yml");
  const coverageJob = workflow.match(/^  coverage:\r?\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:\r?\n)/m)?.[1];
  assert.ok(coverageJob, "could not find the hosted coverage job");
  assert.match(coverageJob!, /^\s*run:\s*npm run coverage\s*$/m, "hosted coverage must call the canonical npm gate");
  assert.doesNotMatch(coverageJob!, /tests\/(?:unit|integration|security|e2e)\/[^\s]+\.test\.ts/);
  assert.match(coverageJob!, /image:\s*pgvector\/pgvector:[^\s]+@sha256:[0-9a-f]{64}/);
  assert.match(coverageJob!, /run:\s*npm run db:schema/);
  assert.match(coverageJob!, /run:\s*npm run db:verify-role/);
});

test("CHECK 5c — c8 gates the complete product pyramid at an 80% floor", () => {
  assert.deepEqual(PRODUCT_SUITE_NAMES, ["unit", "integration", "security", "e2e"]);
  const covered = filesForSuites(PRODUCT_SUITE_NAMES);
  const expected = [
    ...TEST_SUITES.unit,
    ...TEST_SUITES.integration,
    ...TEST_SUITES.security,
    ...TEST_SUITES.e2e,
  ];
  assert.deepEqual(covered, expected);
  assert.deepEqual(COVERAGE_THRESHOLDS, {
    statements: 80,
    branches: 80,
    functions: 80,
    lines: 80,
  });

  const runner = readText("scripts/run-test-suite.ts");
  assert.match(runner, /"node_modules", "c8", "bin", "c8\.js"/);
  assert.doesNotMatch(runner, /\bnpx\b/);
  assert.match(runner, /"--test-concurrency=1"/);
  assert.match(
    runner,
    /case "coverage":\s*coverage\(filesForSuites\(PRODUCT_SUITE_NAMES\), true\);/,
    "the coverage mode must pass the entire canonical product matrix to c8",
  );
});
