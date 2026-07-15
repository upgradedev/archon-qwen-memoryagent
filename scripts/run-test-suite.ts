import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVERAGE_THRESHOLDS,
  PRODUCT_SUITE_NAMES,
  TEST_SUITES,
  filesForSuites,
  type TestSuiteName,
} from "./test-matrix.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const suiteNames = Object.keys(TEST_SUITES) as TestSuiteName[];

function finish(command: string, args: string[]): never {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`test process terminated by ${result.signal}`);
  }
  process.exit(result.status ?? 1);
}

function nodeTest(files: readonly string[], serial: boolean): never {
  const args = ["--import", "tsx", "--test"];
  if (serial) args.push("--test-concurrency=1");
  args.push(...files);
  return finish(process.execPath, args);
}

function coverage(files: readonly string[], checkThresholds: boolean): never {
  // Invoke the installed, package-lock-pinned c8 entrypoint directly. This
  // avoids dynamic package resolution and behaves identically on CI and locally.
  const c8Cli = join(ROOT, "node_modules", "c8", "bin", "c8.js");
  if (!existsSync(c8Cli)) {
    throw new Error("c8 is not installed; run `npm ci` before the coverage gate");
  }

  const c8Args = checkThresholds
    ? [
        "--check-coverage",
        ...Object.entries(COVERAGE_THRESHOLDS).map(([metric, floor]) => `--${metric}=${floor}`),
      ]
    : ["--check-coverage=false"];

  return finish(process.execPath, [
    c8Cli,
    ...c8Args,
    process.execPath,
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    ...files,
  ]);
}

if (suiteNames.includes(mode as TestSuiteName)) {
  const name = mode as TestSuiteName;
  nodeTest(TEST_SUITES[name], name !== "unit" && name !== "docs");
}

switch (mode) {
  case "all":
    nodeTest(filesForSuites(PRODUCT_SUITE_NAMES), true);
  case "coverage":
    coverage(filesForSuites(PRODUCT_SUITE_NAMES), true);
  case "coverage-unit":
    coverage(TEST_SUITES.unit, false);
  default:
    throw new Error(
      `unknown test mode ${JSON.stringify(mode)}; expected ${[
        ...suiteNames,
        "all",
        "coverage",
        "coverage-unit",
      ].join(" | ")}`,
    );
}
