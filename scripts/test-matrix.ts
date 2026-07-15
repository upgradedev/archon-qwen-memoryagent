/**
 * Canonical test-suite manifest.
 *
 * Keep every executable `*.test.ts` file in exactly one suite here. Package
 * scripts, the full c8 gate, and the drift fitness test all consume this same
 * source so CI cannot silently measure a narrower surface than local runs.
 */
export const TEST_SUITES = {
  docs: [
    "tests/docs/docs-consistency.test.ts",
    "tests/docs/supply-chain-consistency.test.ts",
    "tests/docs/test-suite-consistency.test.ts",
  ],
  unit: [
    "tests/unit/db-least-privilege.test.ts",
    "tests/unit/media-path-containment.test.ts",
    "tests/unit/embeddings.test.ts",
    "tests/unit/narrator.test.ts",
    "tests/unit/memory.test.ts",
    "tests/unit/retrieval.test.ts",
    "tests/unit/metrics.test.ts",
    "tests/unit/consolidation.test.ts",
    "tests/unit/consistency.test.ts",
    "tests/unit/semantic-consistency.test.ts",
    "tests/unit/semantic-heldout.test.ts",
    "tests/unit/semantic-qwen37-candidate.test.ts",
    "tests/unit/scale-evidence.test.ts",
    "tests/unit/rerank.test.ts",
    "tests/unit/accuracy.test.ts",
    "tests/unit/server.test.ts",
    "tests/unit/skills.test.ts",
    "tests/unit/mcp.test.ts",
    "tests/unit/pnl.test.ts",
    "tests/unit/pipeline.test.ts",
  ],
  integration: [
    "tests/integration/pgvector-store.test.ts",
    "tests/integration/pipeline-ingest.test.ts",
  ],
  security: [
    "tests/security/authz.test.ts",
    "tests/security/injection.test.ts",
    "tests/security/mcp-boundary.test.ts",
    "tests/security/mcp-stdio-boundary.test.ts",
    "tests/security/exposure.test.ts",
  ],
  e2e: [
    "tests/e2e/cross-session.test.ts",
    "tests/e2e/templates.test.ts",
    "tests/e2e/http-journeys.test.ts",
    "tests/e2e/mcp-journeys.test.ts",
    "tests/e2e/robustness.test.ts",
    "tests/e2e/full-journey.test.ts",
    "tests/e2e/readiness.test.ts",
  ],
} as const;

export type TestSuiteName = keyof typeof TEST_SUITES;

export const PRODUCT_SUITE_NAMES = ["unit", "integration", "security", "e2e"] as const satisfies readonly TestSuiteName[];

export const COVERAGE_THRESHOLDS = {
  statements: 80,
  branches: 80,
  functions: 80,
  lines: 80,
} as const;

export function filesForSuites(names: readonly TestSuiteName[]): string[] {
  return names.flatMap((name) => [...TEST_SUITES[name]]);
}
