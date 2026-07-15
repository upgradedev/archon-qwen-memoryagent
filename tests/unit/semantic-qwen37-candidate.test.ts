import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  QWEN37_RC_DATASET_SHA256,
  QWEN37_RC_PROTOCOL_SHA256,
  QWEN37_RC_RUNTIME,
  QWEN37_PROMOTION_SOURCE_EVIDENCE,
  PROMOTION_DASHSCOPE_BASE_URL,
  assertPromotionBaseUrl,
  classifyPromotionDirtyPaths,
  embedPair,
  prepareCandidateAttempt,
  sanitizedCandidateCommand,
  type AttemptIo,
  type RepositoryStartSnapshot,
} from "../../bench/semantic-qwen37-candidate-run.js";
import {
  createQwenClient,
  officialEvidenceEndpoint,
  officialRuntimeEndpoint,
} from "../../src/qwen/client.js";

test("candidate provenance records a canonical repo-relative command without host paths", () => {
  const command = sanitizedCandidateCommand([
    "C:\\Users\\reviewer\\private-runner.ts",
    "--attempt-id=test-run-0001",
    "--output=C:\\private\\artifact.json",
  ]);
  assert.equal(command, "node bench/semantic-qwen37-candidate-run.ts --attempt-id=test-run-0001");
  assert.doesNotMatch(command, /[A-Za-z]:\\|private-runner|--output/);
});

test("promotion accepts only the canonical DashScope international endpoint", () => {
  assert.equal(
    assertPromotionBaseUrl("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/"),
    PROMOTION_DASHSCOPE_BASE_URL,
  );
  for (const endpoint of [
    "http://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "https://llm-example123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://example.test/compatible-mode/v1",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1?proxy=1",
    "https://user:secret@dashscope-intl.aliyuncs.com/compatible-mode/v1",
  ]) {
    assert.throws(() => assertPromotionBaseUrl(endpoint), /official DashScope international base URL/);
  }
});

test("official endpoint policy normalizes only documented Alibaba production surfaces", () => {
  assert.deepEqual(
    officialRuntimeEndpoint("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/"),
    {
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      region: "ap-southeast-1",
      access: "dashscope",
    },
  );
  assert.deepEqual(
    officialRuntimeEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      region: "cn-beijing",
      access: "dashscope",
    },
  );
  assert.deepEqual(
    officialRuntimeEndpoint("https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1"),
    {
      baseUrl: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
      region: "cn-hongkong",
      access: "dashscope",
    },
  );
  assert.deepEqual(
    officialRuntimeEndpoint("https://dashscope-us.aliyuncs.com/compatible-mode/v1"),
    {
      baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      region: "us-east-1",
      access: "dashscope",
    },
  );
  assert.deepEqual(
    officialRuntimeEndpoint(
      "https://llm-example123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/",
    ),
    {
      baseUrl: "https://llm-example123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1",
      region: "eu-central-1",
      access: "workspace-dedicated",
    },
  );

  assert.deepEqual(
    officialEvidenceEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1/"),
    {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      region: "china-beijing",
    },
  );
  assert.throws(
    () => officialEvidenceEndpoint(
      "https://llm-example123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ),
    /official shared Alibaba Model Studio/,
  );

  for (const endpoint of [
    "https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://coding-intl.dashscope.aliyuncs.com/v1",
    "https://llm-example123.mars-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://llm-example-.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    `https://llm-${"a".repeat(60)}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`,
    "https://llm-example123.ap-southeast-1.maas.aliyuncs.com/v1",
    "https://llm-example123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/extra",
    "https://proxy.example.test/compatible-mode/v1",
    "http://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    " https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "https://user:secret@dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1?proxy=1",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1#fragment",
  ]) {
    assert.throws(
      () => officialRuntimeEndpoint(endpoint),
      /official|credential-free HTTPS/,
    );
  }

  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(
      () => createQwenClient("test-key", "https://proxy.example.test/v1"),
      /official pay-as-you-go Alibaba Model Studio/,
    );
    assert.doesNotThrow(() => createQwenClient(
      "test-key",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/",
    ));
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("timed-out shared embeddings are aborted and drained before returning", async () => {
  let active = 0;
  let aborted = 0;
  const embedder = {
    embed(_text: string, signal?: AbortSignal): Promise<number[]> {
      active += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { active -= 1; resolve([1, 0]); }, 250);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          active -= 1;
          aborted += 1;
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  };
  const result = await embedPair({
    id: "timeout-case",
    statementA: "A",
    statementB: "B",
    contradicts: false,
    category: "agreement-control",
    sameSubject: true,
    note: "abort regression",
  }, embedder, 5);
  assert.equal(result.error, "embedding_unavailable_or_timed_out");
  assert.equal(aborted, 2);
  assert.equal(active, 0, "embedPair must drain both aborted calls before judge work can begin");
});

const snapshot: RepositoryStartSnapshot = Object.freeze({
  gitCommit: "a".repeat(40),
  gitBranch: "feat/release-candidate",
  gitSourceCleanAtStart: true,
  gitWholeTreeCleanAtStart: true,
  allowedPriorEvidenceChanges: [],
  capturedAt: "2026-07-15T10:00:00.000Z",
  command: "node candidate --attempt-id=test-run",
  node: "v22.0.0",
  appVersion: "0.1.0",
  openaiSdkVersion: "4.77.0",
});

test("Qwen 3.7 A/B protocol is explicitly observed-set regression and structured-output safe", () => {
  const raw = readFileSync(resolve("bench/protocol/semantic-qwen37-ab-promotion-v1.json"), "utf8");
  const protocol = JSON.parse(raw) as Record<string, any>;
  assert.match(QWEN37_RC_DATASET_SHA256, /^[a-f0-9]{64}$/);
  assert.match(QWEN37_RC_PROTOCOL_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(protocol.datasetSha256, QWEN37_RC_DATASET_SHA256);
  assert.match(protocol.datasetStatus, /Previously observed/i);
  assert.match(protocol.purpose, /not held-out, confirmatory, independent/i);
  assert.deepEqual(protocol.models.arms.map((arm: any) => [arm.id, arm.judge]), [
    ["baseline", "qwen-plus"],
    ["candidate", "qwen3.7-plus-2026-05-26"],
  ]);
  for (const arm of protocol.models.arms) {
    assert.equal(arm.judgeTemperature, 0);
    assert.equal(arm.judgeResponseFormat, "json_object");
    assert.equal(arm.judgeEnableThinking, false);
    assert.match(arm.judgeMaxTokens, /^omitted/);
  }
  assert.deepEqual(protocol.executionOrder, ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"]);
  assert.equal(protocol.provider.baseUrl, PROMOTION_DASHSCOPE_BASE_URL);
  assert.equal(protocol.provider.customEndpointsAllowed, false);
  assert.equal(QWEN37_RC_RUNTIME.baselineModel, "qwen-plus");
  assert.equal(QWEN37_RC_RUNTIME.candidateModel, "qwen3.7-plus-2026-05-26");
  assert.equal(QWEN37_RC_RUNTIME.enableThinking, false);
  assert.equal(QWEN37_RC_RUNTIME.maxTokensOmitted, true);
  assert.deepEqual(QWEN37_RC_RUNTIME.executionOrder, protocol.executionOrder);
  assert.equal(QWEN37_PROMOTION_SOURCE_EVIDENCE.files.length, protocol.sourceFiles.length);
  assert.match(QWEN37_PROMOTION_SOURCE_EVIDENCE.bundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(QWEN37_PROMOTION_SOURCE_EVIDENCE.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), true);
});

test("promotion provenance permits only prior repo-local promotion evidence dirtiness", () => {
  assert.deepEqual(
    classifyPromotionDirtyPaths(" M bench/results/semantic-qwen37-promotion-v1-attempt-old.jsonl\n?? bench/results/scale-promotion.json"),
    {
      allowedEvidence: [
        "bench/results/scale-promotion.json",
        "bench/results/semantic-qwen37-promotion-v1-attempt-old.jsonl",
      ],
      disallowed: [],
    },
  );
  const rejected = classifyPromotionDirtyPaths(" M src/memory/semantic-consistency.ts\n?? C:/outside/promotion.json");
  assert.deepEqual(rejected.allowedEvidence, []);
  assert.equal(rejected.disallowed.length, 2);
});

test("attempt preparation captures clean whole-tree provenance once before every write", () => {
  const calls: string[] = [];
  let startEvent: any;
  let ledgerEvent: any;
  const io: AttemptIo = {
    artifactExists() { calls.push("artifact-exists"); return false; },
    ledgerContainsAttempt() { calls.push("ledger-contains"); return false; },
    captureRepository() { calls.push("capture"); return snapshot; },
    initializeArtifact(_path, event) { calls.push("artifact-write"); startEvent = event; },
    appendLedger(_path, event) { calls.push("ledger-write"); ledgerEvent = event; },
  };
  const prepared = prepareCandidateAttempt(
    "test-run-0001",
    { artifact: "bench/results/attempt.jsonl", ledger: "bench/results/ledger.jsonl" },
    io,
    () => "2026-07-15T10:01:00.000Z",
  );
  assert.deepEqual(calls, ["artifact-exists", "ledger-contains", "capture", "artifact-write", "ledger-write"]);
  assert.equal(calls.filter((call) => call === "capture").length, 1);
  assert.strictEqual(prepared.repository, snapshot);
  assert.strictEqual(startEvent.repository, snapshot);
  assert.equal(startEvent.repository.gitSourceCleanAtStart, true);
  assert.equal(startEvent.provider.baseUrl, PROMOTION_DASHSCOPE_BASE_URL);
  assert.equal(prepared.providerBaseUrl, PROMOTION_DASHSCOPE_BASE_URL);
  assert.equal(ledgerEvent.gitSourceCleanAtStart, true);
  assert.match(startEvent.evaluationClass, /observed-developer-labelled-synthetic/i);
  assert.match(startEvent.caveats.join(" "), /NOT held-out/i);
  assert.match(startEvent.source.bundleSha256, /^[a-f0-9]{64}$/);
});

test("existing attempt is refused before capture or writes", () => {
  const calls: string[] = [];
  const io: AttemptIo = {
    artifactExists() { calls.push("artifact-exists"); return true; },
    ledgerContainsAttempt() { calls.push("ledger-contains"); return false; },
    captureRepository() { calls.push("capture"); return snapshot; },
    initializeArtifact() { calls.push("artifact-write"); },
    appendLedger() { calls.push("ledger-write"); },
  };
  assert.throws(
    () => prepareCandidateAttempt("test-run-0002", { artifact: "attempt", ledger: "ledger" }, io),
    /already exists/,
  );
  assert.deepEqual(calls, ["artifact-exists"]);
});
