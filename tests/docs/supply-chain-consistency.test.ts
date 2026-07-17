// Supply-chain reproducibility fitness functions. These fail closed if a
// workflow returns to a mutable action tag/runtime range, an unpinned service
// image, an unchecked binary download, or an unhashed Python install.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deterministicTextSummary } from "../../load/deterministic-summary.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readText = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const NODE_VERSION = "24.18.0";
const NPM_VERSION = "11.16.0";
const PYTHON_VERSION = "3.11.15";
const BUILD_NODE_IMAGE =
  "node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd";
const RUNTIME_NODE_IMAGE =
  "node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd";
const PGVECTOR_IMAGE =
  "pgvector/pgvector:0.8.5-pg16-bookworm@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb";
const K6_VERSION = "2.1.0";
const K6_SHA256 = "295d961ebfca306f295f1133068dcd403a8171c87f387928f5f30b0fbcff858a";

const ACTION_PINS = new Map([
  ["actions/checkout", { sha: "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0", release: "v7.0.0" }],
  ["actions/setup-node", { sha: "820762786026740c76f36085b0efc47a31fe5020", release: "v7.0.0" }],
  ["actions/setup-python", { sha: "ece7cb06caefa5fff74198d8649806c4678c61a1", release: "v6.3.0" }],
  ["actions/upload-artifact", { sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", release: "v7.0.1" }],
  ["github/codeql-action", { sha: "7188fc363630916deb702c7fdcf4e481b751f97a", release: "v4.37.1" }],
]);

const workflowFiles = readdirSync(join(ROOT, ".github", "workflows"))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
const workflows = workflowFiles.map((name) => ({ name, text: readText(`.github/workflows/${name}`) }));

test("CHECK 4a — every external GitHub Action is pinned to its verified release commit", () => {
  let usesCount = 0;
  for (const { name, text } of workflows) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!/^\s*(?:-\s+)?uses:\s+/.test(line)) continue;
      usesCount += 1;
      const match = line.match(/^\s*(?:-\s+)?uses:\s+([^@\s]+)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+)\s*$/);
      assert.ok(match, `${name}:${index + 1} must use an immutable 40-hex SHA plus a release comment: ${line.trim()}`);
      const action = match![1]!;
      const key = [...ACTION_PINS.keys()].find((candidate) => action === candidate || action.startsWith(`${candidate}/`));
      assert.ok(key, `${name}:${index + 1} uses an unreviewed action: ${action}`);
      const expected = ACTION_PINS.get(key!)!;
      assert.equal(match![2], expected.sha, `${name}:${index + 1} ${action} SHA drifted`);
      assert.equal(match![3], expected.release, `${name}:${index + 1} ${action} release comment drifted`);
    }
  }
  assert.ok(usesCount >= 30, `expected the complete workflow action surface, found only ${usesCount} uses`);
});

test("CHECK 4a2 — CodeQL v4 uses the supported plural languages input", () => {
  const workflow = readText(".github/workflows/codeql.yml");
  assert.ok(
    workflow.includes("          languages: ${{ matrix.language }}"),
    "CodeQL init must bind the matrix through its supported languages input",
  );
  assert.ok(
    !workflow.includes("          language: ${{ matrix.language }}"),
    "the unsupported singular CodeQL language input must not return",
  );
});

test("CHECK 4b — CI runtimes, runner OS, Docker base, and package metadata agree exactly", () => {
  let nodeSetups = 0;
  let pythonSetups = 0;
  for (const { name, text } of workflows) {
    assert.ok(!text.includes("ubuntu-latest"), `${name} must not float to ubuntu-latest`);
    for (const match of text.matchAll(/^\s*runs-on:\s*(\S+)\s*$/gm)) {
      assert.equal(match[1], "ubuntu-24.04", `${name} runner label drifted`);
    }
    for (const match of text.matchAll(/^\s*node-version:\s*["']?([^\s"']+)["']?\s*$/gm)) {
      nodeSetups += 1;
      assert.equal(match[1], NODE_VERSION, `${name} Node runtime drifted`);
    }
    for (const match of text.matchAll(/^\s*python-version:\s*["']?([^\s"']+)["']?\s*$/gm)) {
      pythonSetups += 1;
      assert.equal(match[1], PYTHON_VERSION, `${name} Python runtime drifted`);
    }
  }
  assert.ok(nodeSetups >= 9, `expected all Node jobs to be checked, found ${nodeSetups}`);
  assert.equal(pythonSetups, 2, `expected both Python video workflows, found ${pythonSetups}`);

  const dockerfile = readText("Dockerfile");
  const nodeBases = [...dockerfile.matchAll(/^FROM\s+(node:\S+)\s+AS\s+/gm)].map((match) => match[1]);
  assert.equal(nodeBases.length, 2, "expected exactly one build and one runtime Node stage");
  assert.deepEqual(nodeBases, [BUILD_NODE_IMAGE, RUNTIME_NODE_IMAGE]);
  assert.match(dockerfile, /RUN rm -rf \/usr\/local\/lib\/node_modules \/opt\/yarn-\*/);
  for (const tool of ["npm", "npx", "corepack", "yarn", "yarnpkg", "pnpm", "pnpx"]) {
    assert.ok(dockerfile.includes(`/usr/local/bin/${tool}`), `runtime package-manager removal omitted ${tool}`);
  }
  assert.equal(readText(".nvmrc").trim(), NODE_VERSION);

  for (const rel of ["package.json", "web/package.json"]) {
    const pkg = JSON.parse(readText(rel));
    assert.equal(pkg.packageManager, `npm@${NPM_VERSION}`, `${rel} packageManager drifted`);
    assert.equal(pkg.engines?.node, NODE_VERSION, `${rel} Node engine drifted`);
    assert.equal(pkg.engines?.npm, NPM_VERSION, `${rel} npm engine drifted`);
  }
  for (const rel of ["package-lock.json", "web/package-lock.json"]) {
    const lock = JSON.parse(readText(rel));
    assert.equal(lock.packages?.[""]?.engines?.node, NODE_VERSION, `${rel} Node engine drifted`);
    assert.equal(lock.packages?.[""]?.engines?.npm, NPM_VERSION, `${rel} npm engine drifted`);
  }
});

test("CHECK 4c — every pgvector service and k6 installer is immutable and checksum-gated", () => {
  const all = workflows.map(({ text }) => text).join("\n");
  const pgvectorImages = [...all.matchAll(/^\s*image:\s*(pgvector\/pgvector:\S+)\s*$/gm)].map((match) => match[1]);
  assert.equal(pgvectorImages.length, 4, `expected four real-pgvector CI services, found ${pgvectorImages.length}`);
  assert.deepEqual(new Set(pgvectorImages), new Set([PGVECTOR_IMAGE]));
  const compose = readText("docker-compose.yml");
  assert.ok(compose.includes(`image: ${PGVECTOR_IMAGE}`), "active production Compose pgvector image must be digest-pinned");
  assert.ok(!all.includes("apt-get install -y k6"), "k6 must not come from a mutable apt repository");
  assert.ok(!all.includes("keyserver.ubuntu.com"), "k6 installation must not depend on a mutable keyserver flow");
  assert.ok(!all.includes("dl.k6.io/deb"), "k6 installation must not depend on the mutable apt channel");

  for (const rel of [".github/workflows/ci.yml", ".github/workflows/load-test.yml"]) {
    const workflow = readText(rel);
    assert.ok(workflow.includes(`K6_VERSION: "${K6_VERSION}"`), `${rel} k6 version drifted`);
    assert.ok(workflow.includes(`K6_SHA256: "${K6_SHA256}"`), `${rel} k6 checksum drifted`);
    assert.ok(workflow.includes(".artifacts/tools"), `${rel} must keep downloads inside the repository`);
    assert.ok(workflow.includes("sha256sum --check --strict"), `${rel} must verify the archive before extraction`);
  }
});

function assertHashLock(rel: string) {
  const lock = readText(rel);
  const starts = [...lock.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\$/gm)];
  assert.ok(starts.length > 0, `${rel} contains no exact requirements`);
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!.index!;
    const end = index + 1 < starts.length ? starts[index + 1]!.index! : lock.length;
    const block = lock.slice(start, end);
    assert.match(block, /--hash=sha256:[0-9a-f]{64}/, `${rel} ${starts[index]![1]} lacks a SHA-256 hash`);
  }
  assert.ok(!/(?:^|\n)[A-Za-z0-9_.-]+\s*(?:>=|~=|\^|\*)/m.test(lock), `${rel} contains a version range`);
}

test("CHECK 4d — demo Python dependencies are exact, transitive, and installed hash-only", () => {
  assertHashLock("requirements/video-demo.lock");
  assertHashLock("requirements/video-selftest.lock");
  for (const rel of ["requirements/video-demo.in", "requirements/video-selftest.in"]) {
    const declarations = readText(rel)
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith("#"));
    assert.ok(declarations.length > 0, `${rel} contains no direct dependencies`);
    for (const declaration of declarations) {
      assert.match(declaration, /^[A-Za-z0-9_.-]+==[^\s]+$/, `${rel} direct dependency must be exact: ${declaration}`);
    }
  }

  const demo = readText(".github/workflows/demo-video.yml");
  const selftest = readText(".github/workflows/video-sync-gate-selftest.yml");
  for (const [name, workflow, lock] of [
    ["demo-video", demo, "requirements/video-demo.lock"],
    ["video-selftest", selftest, "requirements/video-selftest.lock"],
  ] as const) {
    assert.ok(workflow.includes(lock), `${name} must install and cache its committed lock`);
    assert.ok(workflow.includes("--require-hashes"), `${name} must reject unhashed artifacts`);
    assert.ok(workflow.includes("--only-binary=:all:"), `${name} must reject mutable source builds`);
    assert.ok(workflow.includes("python -m pip check"), `${name} must validate the installed graph`);
    assert.ok(!workflow.includes("pip install --upgrade pip"), `${name} must use setup-python's bundled pip`);
  }
  const combined = `${demo}\n${selftest}`;
  assert.ok(!/pip install[^\n]*(?:pillow|playwright|edge-tts)[><=]/i.test(combined), "ranged/direct video pip install returned");
});

test("CHECK 4e — executable source cannot import JavaScript over the network", () => {
  const extensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
  const roots = ["src", "scripts", "tests", "load", "bench", "web/src"];
  const violations: string[] = [];

  const walk = (rel: string) => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      if (!extensions.has(extension)) continue;
      const text = readText(child);
      const remoteStatic = /\b(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?["'`]https?:\/\//;
      const remoteDynamic = /\b(?:import|require)\s*\(\s*["'`]https?:\/\//;
      if (remoteStatic.test(text) || remoteDynamic.test(text)) violations.push(child);
    }
  };
  for (const root of roots) walk(root);

  assert.deepEqual(violations, [], `remote executable imports found: ${violations.join(", ")}`);
  assert.ok(
    readText("load/recall-load.js").includes('from "./deterministic-summary.js"'),
    "k6 must use the repository-local deterministic summary formatter",
  );
});

test("CHECK 4f — local k6 summary is deterministic and preserves threshold outcomes", () => {
  const fixture = {
    metrics: {
      z_metric: {
        type: "trend",
        contains: "time",
        values: { max: 20, avg: 10 },
        thresholds: { "p(95)<25": { ok: true } },
      },
      a_metric: {
        type: "rate",
        contains: "default",
        values: { rate: 0.5 },
        thresholds: { "rate>0.9": { ok: false } },
      },
    },
  };
  assert.equal(
    deterministicTextSummary(fixture),
    [
      "",
      "MemoryAgent k6 summary (deterministic; raw k6 units)",
      "thresholds: FAIL (1/2)",
      " - a_metric [rate/default]: rate=0.5 | rate>0.9=FAIL",
      " - z_metric [trend/time]: avg=10, max=20 | p(95)<25=PASS",
      "",
    ].join("\n"),
  );
});

const sha256File = (rel: string) =>
  createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");

const workflowEnv = (workflow: string, name: string) => {
  const match = workflow.match(new RegExp("^      " + name + ":\\s+[\"']?([^\\s\"']+)[\"']?\\s*$", "m"));
  assert.ok(match, "missing supply-chain environment anchor " + name);
  return match[1]!;
};

test("CHECK 4g — production image supply-chain workflow is immutable, minimal, and ordered", () => {
  const workflow = readText(".github/workflows/supply-chain.yml").replace(/\r\n/g, "\n");
  assert.ok(
    workflow.startsWith(
      "name: Production Image Supply Chain\n\n" +
        "# Builds the production Dockerfile",
    ),
  );
  assert.match(
    workflow,
    /on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:\n/,
  );
  assert.match(
    workflow,
    /permissions:\n  contents: read\n  security-events: write\n\njobs:/,
  );
  const jobKeys = [...workflow.split("\njobs:\n")[1]!.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(jobKeys, ["image-sbom-vulnerability-gate"]);
  assert.match(workflow, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(workflow, /^    timeout-minutes: 45$/m);

  const stepNames = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(stepNames, [
    "Checkout exact source",
    "Select exact Node runtime",
    "Anchor immutable production inputs",
    "Build the exact production image",
    "Exercise the constrained production runtime",
    "Install pinned Syft and Grype archives",
    "Verify scanner policy and provenance",
    "Import the immutable vulnerability database snapshot",
    "Generate retained image SBOMs",
    "Validate and seal the pre-scan SBOM bundle",
    "Retain SBOM evidence before vulnerability scanning",
    "Produce JSON, SARIF, and human-readable vulnerability reports",
    "Gate every high or critical finding (no current allowlist)",
    "Validate and hash the combined evidence",
    "Upload Grype SARIF to GitHub code scanning",
    "Retain SBOM, scan, database, and provenance evidence",
  ]);
  const actionUses = [...workflow.matchAll(/^        uses: (\S+)\s+#\s+(v\d+\.\d+\.\d+)$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(actionUses, [
    "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "github/codeql-action/upload-sarif@7188fc363630916deb702c7fdcf4e481b751f97a",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ]);
  assert.match(
    workflow,
    /- name: Select exact Node runtime\n        uses: actions\/setup-node@[0-9a-f]{40} # v7\.0\.0\n        with:\n          node-version: "24\.18\.0"\n          package-manager-cache: false\n/,
    "the security workflow must explicitly disable setup-node v7 automatic package-manager caching",
  );
  assert.equal((workflow.match(/^        run: \|$/gm) ?? []).length, 11);
  assert.equal((workflow.match(/^          set -euo pipefail$/gm) ?? []).length, 11);

  const anchoredFiles = new Map([
    ["EXPECTED_DOCKERFILE_SHA256", "Dockerfile"],
    ["EXPECTED_DOCKERIGNORE_SHA256", ".dockerignore"],
    ["EXPECTED_GITATTRIBUTES_SHA256", ".gitattributes"],
    ["EXPECTED_PACKAGE_LOCK_SHA256", "package-lock.json"],
    ["EXPECTED_SYFT_POLICY_SHA256", ".syft.yaml"],
    ["EXPECTED_GRYPE_POLICY_SHA256", ".grype.yaml"],
  ]);
  for (const [environmentName, rel] of anchoredFiles) {
    assert.equal(workflowEnv(workflow, environmentName), sha256File(rel), rel + " hash anchor drifted");
  }
  assert.equal(workflowEnv(workflow, "SYFT_VERSION"), "1.46.0");
  assert.equal(
    workflowEnv(workflow, "SYFT_SHA256"),
    "d654f678b709eb53c393d38519d5ed7d2e57205529404018614cfefa0fb2b5ca",
  );
  assert.equal(
    workflowEnv(workflow, "EXPECTED_SYFT_BINARY_SHA256"),
    "574df1a0862ff88ad933be214e81069e35b17618a13e019f8f1c84fe063222a2",
  );
  assert.equal(workflowEnv(workflow, "GRYPE_VERSION"), "0.115.0");
  assert.equal(
    workflowEnv(workflow, "GRYPE_SHA256"),
    "3fad92940650e514c0aa2dad83526942a055e210cec09a8a59d9c024adc2b90e",
  );
  assert.equal(
    workflowEnv(workflow, "EXPECTED_GRYPE_BINARY_SHA256"),
    "05ffd2c28a607e48fb2269d9aac5b3d53e8a51bbac501946644745eae2119907",
  );
  assert.equal(
    workflowEnv(workflow, "GRYPE_DB_SHA256"),
    "0d9ac9d49c93649ea6bf713c60960b46e33c939d49ac7de52df649453d29cf8e",
  );
});

test("CHECK 4h — sealed-SBOM vulnerability gate has no suppression or substitution path", () => {
  const workflow = readText(".github/workflows/supply-chain.yml").replace(/\r\n/g, "\n");
  const syftPolicy = readText(".syft.yaml")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(syftPolicy, [
    "check-for-app-update: false",
    "scope: squashed",
    "default-catalogers: []",
    "select-catalogers: []",
    "exclude: []",
  ]);
  const grypePolicy = readText(".grype.yaml")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(grypePolicy, [
    "check-for-app-update: false",
    "db:",
    "auto-update: false",
    "validate-age: false",
    "require-update-check: false",
    "external-sources:",
    "enable: false",
    "ignore: []",
  ]);

  for (const forbidden of [
    "continue-on-error",
    "only-fixed",
    "ignore-wont-fix",
    "--exclude",
    "--add-cpes-if-none",
    "scope: all-layers",
    'GRYPE_DB_AUTO_UPDATE: "true"',
    'SYFT_CHECK_FOR_APP_UPDATE: "true"',
  ]) {
    assert.ok(!workflow.includes(forbidden), "forbidden supply-chain weakening returned: " + forbidden);
  }
  assert.equal((workflow.match(/--fail-on/g) ?? []).length, 1);
  assert.match(workflow, /--by-cve --fail-on high --output table/);
  assert.ok(!/\|\|\s*true/.test(workflow));

  const runtimeStart = workflow.indexOf("Exercise the constrained production runtime");
  const runtimeEnd = workflow.indexOf("Install pinned Syft and Grype archives");
  assert.ok(runtimeStart > 0 && runtimeStart < runtimeEnd);
  const runtimeBlock = workflow.slice(runtimeStart, runtimeEnd);
  assert.match(
    runtimeBlock,
    /assert\.deepEqual\(config\.Entrypoint, \["docker-entrypoint\.sh"\]\);/,
  );
  assert.ok(!runtimeBlock.includes("assert.equal(config.Entrypoint, null)"));
  const entrypointCanaryStart = runtimeBlock.indexOf('DEFAULT_ENTRYPOINT_OUTPUT="$(');
  const entrypointCanaryEnd = runtimeBlock.indexOf('\n          )"', entrypointCanaryStart);
  assert.ok(entrypointCanaryStart > 0 && entrypointCanaryStart < entrypointCanaryEnd);
  const entrypointCanary = runtimeBlock.slice(entrypointCanaryStart, entrypointCanaryEnd);
  for (const constraint of [
    "--network none",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges",
    "--pids-limit 64",
    "--memory 256m",
    "--cpus 1",
    "--tmpfs /tmp:rw,noexec,nosuid,size=16m",
  ]) {
    assert.ok(entrypointCanary.includes(constraint), "entrypoint canary lost " + constraint);
  }
  assert.ok(!entrypointCanary.includes("--entrypoint"));
  assert.match(entrypointCanary, /"\$IMAGE" node --version/);
  assert.match(runtimeBlock, /test "\$DEFAULT_ENTRYPOINT_OUTPUT" = "v24\.18\.0"/);
  for (const tool of ["npm", "npx", "corepack"]) {
    assert.ok(runtimeBlock.includes(`! command -v ${tool} >/dev/null`), `runtime canary omitted ${tool} absence`);
  }
  assert.ok(runtimeBlock.includes("runtime-app-import-passed"), "runtime canary omitted the compiled app import smoke");
  assert.match(
    runtimeBlock,
    /printf '%s\\n' "\$DEFAULT_ENTRYPOINT_OUTPUT" > "\$EVIDENCE_DIR\/runtime-entrypoint\.txt"/,
  );

  const scannerInvocations = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith('"$TOOLS_DIR/syft/syft"') ||
        line.startsWith('"$TOOLS_DIR/grype/grype"'),
    );
  assert.equal(scannerInvocations.filter((line) => line.includes("/syft/syft")).length, 3);
  assert.equal(scannerInvocations.filter((line) => line.includes("/grype/grype")).length, 6);
  for (const invocation of scannerInvocations) {
    assert.ok(
      invocation.includes('--config "$EVIDENCE_DIR/input-locks/'),
      "scanner invocation omitted the explicit reviewed config: " + invocation,
    );
  }
  assert.ok((workflow.match(/docker image inspect --format '\{\{\.Id\}\}' "\$IMAGE"/g) ?? []).length >= 3);
  assert.ok((workflow.match(/sha256sum "\$EVIDENCE_DIR\/memoryagent\.syft\.json"/g) ?? []).length >= 3);
  assert.match(workflow, /echo "image_id=\$IMAGE_ID" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /echo "syft_sha256=\$SCANNED_SBOM_SHA256" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /ignored\.length, 0/);

  const retainBefore = workflow.indexOf("Retain SBOM evidence before vulnerability scanning");
  const seal = workflow.indexOf("Validate and seal the pre-scan SBOM bundle");
  const report = workflow.indexOf("Produce JSON, SARIF, and human-readable vulnerability reports");
  const gate = workflow.indexOf("Gate every high or critical finding");
  const validateCombined = workflow.indexOf("Validate and hash the combined evidence");
  const uploadSarif = workflow.indexOf("Upload Grype SARIF to GitHub code scanning");
  const retainFinal = workflow.indexOf("Retain SBOM, scan, database, and provenance evidence");
  assert.ok(
    seal > 0 && seal < retainBefore && retainBefore < report && report < gate &&
      gate < validateCombined && validateCombined < uploadSarif && uploadSarif < retainFinal,
  );
  const sealBlock = workflow.slice(seal, retainBefore);
  assert.match(sealBlock, /runtime-entrypoint\.txt/);
  assert.ok(
    sealBlock.includes('/usr/local/lib/node_modules/'),
    "sealed SBOM validation omitted global package-manager module rejection",
  );
  assert.ok(!sealBlock.includes("syft.artifacts.length >="), "sealed SBOM returned to an arbitrary count floor");
  for (const runtimeArtifact of ["alpine-release", "busybox", "ca-certificates-bundle", "libssl3", "musl"]) {
    assert.ok(sealBlock.includes(`"${runtimeArtifact}"`), `sealed SBOM omitted semantic runtime artifact ${runtimeArtifact}`);
  }
  const preScanBlock = workflow.slice(retainBefore, report);
  assert.match(preScanBlock, /runtime-entrypoint\.txt/);
  assert.match(preScanBlock, /if-no-files-found: error/);
  assert.match(preScanBlock, /retention-days: 30/);
  const validateCombinedBlock = workflow.slice(validateCombined, uploadSarif);
  assert.match(validateCombinedBlock, /runtime-entrypoint\.txt/);
  const finalBlock = workflow.slice(retainFinal);
  assert.match(finalBlock, /runtime-entrypoint\.txt/);
  assert.match(finalBlock, /if: always\(\)/);
  assert.match(finalBlock, /if-no-files-found: warn/);
  assert.match(finalBlock, /retention-days: 30/);
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
});

test("CHECK 4i — supply-chain documentation, line endings, and review routing cannot drift", () => {
  const attributes = readText(".gitattributes");
  for (const line of [
    "Dockerfile text eol=lf",
    ".dockerignore text eol=lf",
    ".gitattributes text eol=lf",
    "package-lock.json text eol=lf",
    ".syft.yaml text eol=lf",
    ".grype.yaml text eol=lf",
    ".github/workflows/*.yml text eol=lf",
  ]) {
    assert.equal(attributes.split(/\r?\n/).filter((candidate) => candidate === line).length, 1);
  }
  assert.equal(
    readText(".dockerignore").split(/\r?\n/).filter((line) => line === ".artifacts").length,
    1,
  );

  const owners = readText(".github/CODEOWNERS");
  for (const line of [
    "/Dockerfile @upgradedev",
    "/.dockerignore @upgradedev",
    "/.gitattributes @upgradedev",
    "/package.json @upgradedev",
    "/package-lock.json @upgradedev",
    "/.github/workflows/supply-chain.yml @upgradedev",
    "/.syft.yaml @upgradedev",
    "/.grype.yaml @upgradedev",
    "/tests/docs/supply-chain-consistency.test.ts @upgradedev",
    "/docs/SUPPLY_CHAIN.md @upgradedev",
  ]) {
    assert.equal(owners.split(/\r?\n/).filter((candidate) => candidate === line).length, 1);
  }

  const supply = readText("docs/SUPPLY_CHAIN.md").replace(/[*_`]/g, "").replace(/\s+/g, " ");
  assert.match(supply, /SPDX 2\.3/);
  assert.match(supply, /CycloneDX JSON/);
  assert.match(supply, /SARIF 2\.1\.0/);
  assert.match(supply, /as of 2026-07-15/i);
  assert.match(supply, /not a security certification/i);
  assert.match(supply, /no current CVE allowlist/i);
  assert.match(supply, /including a finding with no available fix/i);
  assert.match(supply, /Do not claim a green image gate until/i);
  for (const rel of ["README.md", "SECURITY.md", "docs/CLAIM_EVIDENCE_MATRIX.md", "docs/JUDGE-GUIDE.md"]) {
    const text = readText(rel).replace(/\s+/g, " ");
    assert.match(text, /SUPPLY_CHAIN\.md/);
    assert.match(text, /security certification/i);
    assert.match(text, /high\/critical/i);
  }
});
