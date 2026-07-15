// Same-commit Qwen A/B promotion regression over an already-observed 48-pair set.
//
// This is deliberately NOT described as a new held-out or confirmatory result.
// Historical qwen-plus v1.1 outcomes were known before this protocol was written.
// This runner therefore reruns both qwen-plus and dated Qwen 3.7 on one commit;
// it measures only observed-set regression/stability, never generalization.
//
// Online only, from a committed source-clean repository:
//   npm run bench:semantic:qwen37:promotion -- --attempt-id=20260715T120000Z
//
// Each explicit attempt gets one append-only JSONL event stream plus records in
// an append-only JSONL ledger. Existing attempt ids/artifacts are refused. The
// source-tree Git provenance is captured exactly once, before the first write,
// then reused in every event so writing the artifact cannot falsify provenance.
// Only earlier repo-local *promotion*.json/jsonl evidence may already be dirty.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  closeSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  QwenJudge,
  detectSemanticContradictions,
  type JudgeVerdict,
  type SemanticJudge,
  type SemanticMemory,
} from "../src/memory/semantic-consistency.js";
import { QwenEmbedder } from "../src/memory/embeddings.js";
import {
  DEFAULT_BASE_URL,
  QWEN_MAX_RETRIES,
  QWEN_REQUEST_TIMEOUT_MS,
  hasQwenCreds,
  officialEvidenceEndpoint,
} from "../src/qwen/client.js";
import { cosineSimilarity } from "../src/memory/retrieval.js";
import {
  HELDOUT_SEMANTIC_CASES,
  assertHeldoutDatasetInvariant,
  type HeldoutSemanticCase,
} from "./semantic-heldout-dataset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const PROTOCOL_PATH = resolve(HERE, "protocol", "semantic-qwen37-ab-promotion-v1.json");
const RESULTS_DIR = resolve(HERE, "results");
const LEDGER_PATH = resolve(RESULTS_DIR, "semantic-qwen37-promotion-v1-attempts.jsonl");
export const PROMOTION_DASHSCOPE_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export type PromotionArmId = "baseline" | "candidate";

interface PromotionArm {
  id: PromotionArmId;
  judge: string;
  judgeTemperature: number;
  judgeResponseFormat: string;
  judgeEnableThinking: boolean;
  judgeMaxTokens: string;
}

interface PromotionProtocol {
  version: string;
  purpose: string;
  dataset: string;
  datasetSha256: string;
  datasetStatus: string;
  cases: number;
  positives: number;
  negatives: number;
  similarityThreshold: number;
  maxPairsPerCase: number;
  caseIsolation: boolean;
  onlineRepetitionsPerArm: number;
  executionOrder: PromotionArmId[];
  executionOrderInterpretation: string;
  embeddingConcurrency: number;
  judgeConcurrency: number;
  judgeTimeoutMs: number;
  embeddingTimeoutMs: number;
  embeddingReuseAcrossArmsAndRepetitions: boolean;
  provider: {
    service: string;
    baseUrl: string;
    customEndpointsAllowed: boolean;
  };
  models: {
    embedder: string;
    embeddingDimensions: number;
    arms: PromotionArm[];
  };
  sourceFiles: string[];
  sdk: {
    configuredMaxRetries: number;
    retryObservability: string;
    applicationLevelRetries: number;
  };
  failureScoring: string;
  reporting: string;
  attemptPolicy: Record<string, unknown>;
  absoluteGate: {
    minimumAccuracyPctPerRun: number;
    minimumPrecisionPctPerRun: number;
    minimumRecallPctPerRun: number;
    minimumCompletionPctPerRun: number;
    maximumInconclusivePerRun: number;
    minimumStablePredictionPct: number;
    maximumPromptInjectionFalsePositivesAcrossRuns: number;
  };
  nonRegressionGate: {
    minimumCandidateMinusBaselineAccuracyPoints: number;
    minimumCandidateMinusBaselinePrecisionPoints: number;
    minimumCandidateMinusBaselineRecallPoints: number;
    minimumCandidateMinusBaselineCompletionPoints: number;
    minimumCandidateMinusBaselineStabilityPoints: number;
    maximumCandidatePromptInjectionFalsePositiveIncrease: number;
  };
  promotionRule: string;
  comparisonPolicy: string;
}

const protocolBytes = readFileSync(PROTOCOL_PATH, "utf8");
const protocol = JSON.parse(protocolBytes) as PromotionProtocol;
const datasetBytes = JSON.stringify(HELDOUT_SEMANTIC_CASES);
export const QWEN37_RC_DATASET_SHA256 = createHash("sha256").update(datasetBytes).digest("hex");
export const QWEN37_RC_PROTOCOL_SHA256 = createHash("sha256").update(protocolBytes).digest("hex");
export const QWEN37_PROMOTION_DATASET_SHA256 = QWEN37_RC_DATASET_SHA256;
export const QWEN37_PROMOTION_PROTOCOL_SHA256 = QWEN37_RC_PROTOCOL_SHA256;

function sourceFileEvidence(files: readonly string[]) {
  const entries = files.map((path) => {
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
      throw new Error("promotion protocol contains an unsafe source path");
    }
    const bytes = readFileSync(resolve(REPO, path));
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const bundle = createHash("sha256");
  for (const entry of entries) bundle.update(`${entry.path}\0${entry.sha256}\n`);
  return { files: entries, bundleSha256: bundle.digest("hex") };
}

export const QWEN37_PROMOTION_SOURCE_EVIDENCE = Object.freeze(sourceFileEvidence(protocol.sourceFiles));

export interface RepositoryStartSnapshot {
  gitCommit: string;
  gitBranch: string;
  gitSourceCleanAtStart: true;
  gitWholeTreeCleanAtStart: boolean;
  allowedPriorEvidenceChanges: string[];
  capturedAt: string;
  command: string;
  node: string;
  appVersion: string;
  openaiSdkVersion: string;
}

export interface AttemptPaths {
  artifact: string;
  ledger: string;
}

export interface AttemptIo {
  artifactExists(path: string): boolean;
  ledgerContainsAttempt(path: string, attemptId: string): boolean;
  captureRepository(): RepositoryStartSnapshot;
  initializeArtifact(path: string, event: unknown): void;
  appendLedger(path: string, event: unknown): void;
}

export interface PreparedAttempt {
  attemptId: string;
  paths: AttemptPaths;
  repository: RepositoryStartSnapshot;
  providerBaseUrl: string;
  startedAt: string;
}

interface EmbeddingPair {
  a: number[];
  b: number[];
  error: string | null;
  latencyMs: number;
}

interface CandidateCaseResult {
  id: string;
  category: string;
  expected: boolean;
  predicted: boolean;
  status: "complete" | "partial" | "inconclusive";
  similarity: number | null;
  subjectGatePassed: boolean;
  judgeCalled: boolean;
  judgeVerdict: JudgeVerdict | null;
  latencyMs: number;
  error: string | null;
}

interface CandidateMetrics {
  cases: number;
  completedCases: number;
  completionPct: number;
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
  inconclusive: number;
  accuracyPct: number;
  precisionPct: number;
  recallPct: number;
  specificityPct: number;
  f1Pct: number;
  detectorJudgeP50Ms: number;
  detectorJudgeP95Ms: number;
}

interface CandidateRun {
  arm: PromotionArmId;
  model: string;
  repetition: number;
  startedAt: string;
  completedAt: string;
  metrics: CandidateMetrics;
  cases: CandidateCaseResult[];
}

function validateAttemptId(attemptId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(attemptId)) {
    throw new Error("--attempt-id must be 8-80 safe characters: letters, digits, dot, underscore or hyphen");
  }
}

export function sanitizedCandidateCommand(args: readonly string[]): string {
  const attempt = args.find((arg) => /^--attempt-id=[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(arg));
  return ["node", "bench/semantic-qwen37-candidate-run.ts", ...(attempt ? [attempt] : [])].join(" ");
}

export function candidateAttemptPaths(attemptId: string): AttemptPaths {
  validateAttemptId(attemptId);
  return {
    artifact: resolve(RESULTS_DIR, `semantic-qwen37-promotion-v1-attempt-${attemptId}.jsonl`),
    ledger: LEDGER_PATH,
  };
}

// Promotion evidence is intentionally tied to the international endpoint
// frozen in this versioned protocol. The shared evidence validator first proves
// this is an official, credential-free Alibaba surface; the protocol then
// narrows that official set to its predeclared region before the first write.
export function assertPromotionBaseUrl(raw: string = DEFAULT_BASE_URL): string {
  let endpoint: ReturnType<typeof officialEvidenceEndpoint>;
  try {
    endpoint = officialEvidenceEndpoint(raw);
  } catch {
    throw new Error("promotion run requires the official DashScope international base URL");
  }
  if (endpoint.baseUrl !== PROMOTION_DASHSCOPE_BASE_URL) {
    throw new Error("promotion run requires the official DashScope international base URL");
  }
  return endpoint.baseUrl;
}

// This small injected seam is regression-tested for the essential ordering:
// a single source-clean repository snapshot MUST precede every artifact/ledger write.
export function prepareCandidateAttempt(
  attemptId: string,
  paths: AttemptPaths,
  io: AttemptIo,
  now: () => string = () => new Date().toISOString(),
  providerBaseUrl: string = assertPromotionBaseUrl(),
): PreparedAttempt {
  validateAttemptId(attemptId);
  const normalizedProviderBaseUrl = assertPromotionBaseUrl(providerBaseUrl);
  if (io.artifactExists(paths.artifact)) throw new Error(`attempt artifact already exists: ${paths.artifact}`);
  if (io.ledgerContainsAttempt(paths.ledger, attemptId)) throw new Error(`attempt id already exists in ledger: ${attemptId}`);

  // Capture exactly once. No mkdir, artifact creation or ledger append may move
  // above this line. The returned immutable value is reused for every event.
  const repository = Object.freeze(io.captureRepository());
  if (repository.gitSourceCleanAtStart !== true) throw new Error("promotion run requires a clean source tree");
  const startedAt = now();
  const prepared = { attemptId, paths, repository, providerBaseUrl: normalizedProviderBaseUrl, startedAt };
  const startEvent = {
    event: "attempt_started",
    schemaVersion: "1",
    attemptId,
    startedAt,
    evaluationClass: "observed-developer-labelled-synthetic-same-commit-ab-promotion",
    dataset: {
      name: protocol.dataset,
      sha256: QWEN37_RC_DATASET_SHA256,
      status: protocol.datasetStatus,
      cases: protocol.cases,
      positives: protocol.positives,
      negatives: protocol.negatives,
    },
    protocol: { ...protocol, sha256: QWEN37_PROMOTION_PROTOCOL_SHA256 },
    source: QWEN37_PROMOTION_SOURCE_EVIDENCE,
    provider: {
      service: protocol.provider.service,
      baseUrl: normalizedProviderBaseUrl,
    },
    models: { embedder: protocol.models.embedder, arms: protocol.models.arms },
    repository,
    requestTelemetry: {
      sdkConfiguredMaxRetries: QWEN_MAX_RETRIES,
      sdkInternalRetriesObserved: null,
      sdkInternalRetriesNote: protocol.sdk.retryObservability,
      applicationLevelRetries: 0,
      tokenUsageObserved: false,
      costClaimed: false,
    },
    caveats: [
      "This dataset and its prior qwen-plus outcomes were observed before this A/B protocol; it is NOT held-out, confirmatory, independent, or statistically powered evidence.",
      "Synthetic developer labels are not independent expert annotations or a production prevalence sample.",
      "Embeddings are frozen once and reused across both arms and all repetitions; repetitions measure output stability, not independent samples.",
      "Every event is append-only. No best attempt or best repetition is selected.",
      "Confidence is ordinal model output, not a calibrated probability.",
    ],
  };
  io.initializeArtifact(paths.artifact, startEvent);
  io.appendLedger(paths.ledger, {
    event: "attempt_started",
    attemptId,
    artifact: `bench/results/${paths.artifact.split(/[\\/]/).at(-1)}`,
    startedAt,
    protocolSha256: QWEN37_PROMOTION_PROTOCOL_SHA256,
    datasetSha256: QWEN37_PROMOTION_DATASET_SHA256,
    sourceBundleSha256: QWEN37_PROMOTION_SOURCE_EVIDENCE.bundleSha256,
    gitCommit: repository.gitCommit,
    gitSourceCleanAtStart: repository.gitSourceCleanAtStart,
    gitWholeTreeCleanAtStart: repository.gitWholeTreeCleanAtStart,
  });
  return prepared;
}

export function classifyPromotionDirtyPaths(status: string): { allowedEvidence: string[]; disallowed: string[] } {
  const changes = status ? status.split(/\r?\n/).filter(Boolean) : [];
  const changedPaths = changes.map((line) => line.length >= 4 ? line.slice(3) : "");
  const allowedEvidence = changedPaths.filter((path) =>
    /^bench\/results\/[^/]*promotion[^/]*\.jsonl?$/i.test(path),
  );
  return {
    allowedEvidence: [...allowedEvidence].sort(),
    disallowed: changedPaths.filter((path) => !allowedEvidence.includes(path)),
  };
}

function captureCleanRepository(): RepositoryStartSnapshot {
  const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { version?: string };
  const lock = JSON.parse(readFileSync(resolve(REPO, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string }> };
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
  const oid = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]) || "(detached)";
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const changes = status ? status.split(/\r?\n/).filter(Boolean) : [];
  const { allowedEvidence, disallowed } = classifyPromotionDirtyPaths(status);
  if (!oid || oid === "(initial)") throw new Error("release-candidate run requires a committed Git HEAD");
  if (disallowed.length > 0) throw new Error("promotion run requires a clean source/config tree; only prior repo-local promotion evidence may be dirty");
  return {
    gitCommit: oid,
    gitBranch: branch,
    gitSourceCleanAtStart: true,
    gitWholeTreeCleanAtStart: changes.length === 0,
    allowedPriorEvidenceChanges: allowedEvidence.sort(),
    capturedAt: new Date().toISOString(),
    command: sanitizedCandidateCommand(process.argv.slice(2)),
    node: process.version,
    appVersion: pkg.version ?? "unknown",
    openaiSdkVersion: lock.packages?.["node_modules/openai"]?.version ?? "unknown",
  };
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

function defaultIo(): AttemptIo {
  return {
    artifactExists: existsSync,
    ledgerContainsAttempt(path, attemptId) {
      if (!existsSync(path)) return false;
      return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => {
          try {
            return (JSON.parse(line) as { attemptId?: unknown }).attemptId === attemptId;
          } catch {
            throw new Error(`attempt ledger is not valid JSONL: ${path}`);
          }
        });
    },
    captureRepository: captureCleanRepository,
    initializeArtifact(path, event) {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "wx", 0o644);
      try { writeSync(fd, jsonLine(event)); } finally { closeSync(fd); }
    },
    appendLedger(path, event) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, jsonLine(event), { encoding: "utf8", mode: 0o644 });
    },
  };
}

function appendArtifact(prepared: PreparedAttempt, event: unknown): void {
  appendFileSync(prepared.paths.artifact, jsonLine({ ...event as object, attemptId: prepared.attemptId, repository: prepared.repository }), "utf8");
}

function appendLedger(prepared: PreparedAttempt, event: unknown): void {
  appendFileSync(prepared.paths.ledger, jsonLine({ ...event as object, attemptId: prepared.attemptId, gitCommit: prepared.repository.gitCommit }), "utf8");
}

function round(n: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(n * scale) / scale;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]!, index);
    }
  }));
  return output;
}

export async function embedPair(
  c: HeldoutSemanticCase,
  embedder: Pick<QwenEmbedder, "embed">,
  timeoutMs: number = protocol.embeddingTimeoutMs,
): Promise<EmbeddingPair> {
  const started = performance.now();
  const controller = new AbortController();
  const calls = [
    embedder.embed(c.statementA, controller.signal),
    embedder.embed(c.statementB, controller.signal),
  ] as const;
  const operation = Promise.all(calls);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [a, b] = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("embedding_timeout"));
        }, timeoutMs);
      }),
    ]);
    return { a, b, error: null, latencyMs: round(performance.now() - started) };
  } catch {
    controller.abort();
    // Do not start either judge arm while an embedding request from the shared
    // pass remains in flight. allSettled drains both calls after abort, including
    // the sibling call that Promise.all would otherwise stop awaiting.
    await Promise.allSettled(calls);
    return { a: [], b: [], error: "embedding_unavailable_or_timed_out", latencyMs: round(performance.now() - started) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function memories(c: HeldoutSemanticCase, pair: EmbeddingPair): SemanticMemory[] {
  const base = { kind: "insight" as const, company: "Release Candidate Regression Co", period: "2026-06", metadata: {}, importance: 0.5 };
  return [
    { ...base, id: `${c.id}-a`, sourceRef: `${c.id}:session-a`, content: c.statementA, createdAt: "2026-06-01T09:00:00.000Z", embedding: pair.a },
    { ...base, id: `${c.id}-b`, sourceRef: `${c.id}:session-b`, content: c.statementB, createdAt: "2026-06-15T09:00:00.000Z", embedding: pair.b },
  ];
}

async function evaluateCase(c: HeldoutSemanticCase, pair: EmbeddingPair, judge: SemanticJudge): Promise<CandidateCaseResult> {
  const started = performance.now();
  if (pair.error) {
    return { id: c.id, category: c.category, expected: c.contradicts, predicted: false, status: "inconclusive", similarity: null, subjectGatePassed: false, judgeCalled: false, judgeVerdict: null, latencyMs: round(performance.now() - started), error: pair.error };
  }
  let captured: JudgeVerdict | null = null;
  const capturingJudge: SemanticJudge = {
    modelId: judge.modelId,
    async judge(a, b) { captured = await judge.judge(a, b); return captured; },
  };
  const report = await detectSemanticContradictions(memories(c, pair), capturingJudge, {
    similarityThreshold: protocol.similarityThreshold,
    maxPairs: protocol.maxPairsPerCase,
    concurrency: 1,
  });
  return {
    id: c.id,
    category: c.category,
    expected: c.contradicts,
    predicted: report.semanticContradictions.length > 0,
    status: report.status,
    similarity: round(cosineSimilarity(pair.a, pair.b), 4),
    subjectGatePassed: report.candidatePairs === 1,
    judgeCalled: report.modelCalls === 1,
    judgeVerdict: captured,
    latencyMs: round(performance.now() - started),
    error: report.errors[0]?.reason ?? null,
  };
}

function metrics(cases: CandidateCaseResult[]): CandidateMetrics {
  const complete = cases.filter((c) => c.status !== "inconclusive");
  const tp = complete.filter((c) => c.expected && c.predicted).length;
  const tn = complete.filter((c) => !c.expected && !c.predicted).length;
  const fp = cases.filter((c) => !c.expected && c.predicted).length;
  const fn = cases.filter((c) => c.expected && !c.predicted).length;
  const inconclusive = cases.filter((c) => c.status === "inconclusive").length;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const specificity = tn + fp ? tn / (tn + fp) : 1;
  const latencies = cases.map((c) => c.latencyMs).sort((a, b) => a - b);
  return {
    cases: cases.length,
    completedCases: complete.length,
    completionPct: round(100 * complete.length / Math.max(1, cases.length)),
    truePositives: tp,
    trueNegatives: tn,
    falsePositives: fp,
    falseNegatives: fn,
    inconclusive,
    accuracyPct: round(100 * complete.filter((c) => c.expected === c.predicted).length / Math.max(1, cases.length)),
    precisionPct: round(100 * precision),
    recallPct: round(100 * recall),
    specificityPct: round(100 * specificity),
    f1Pct: round(100 * (precision + recall ? 2 * precision * recall / (precision + recall) : 0)),
    detectorJudgeP50Ms: round(percentile(latencies, .5)),
    detectorJudgeP95Ms: round(percentile(latencies, .95)),
  };
}

async function runOne(
  arm: PromotionArmId,
  repetition: number,
  pairs: Map<string, EmbeddingPair>,
  judge: SemanticJudge,
): Promise<CandidateRun> {
  const startedAt = new Date().toISOString();
  const cases = await mapLimit(HELDOUT_SEMANTIC_CASES, protocol.judgeConcurrency, (c) => evaluateCase(c, pairs.get(c.id)!, judge));
  return { arm, model: judge.modelId, repetition, startedAt, completedAt: new Date().toISOString(), metrics: metrics(cases), cases };
}

function aggregate(runs: CandidateRun[]) {
  const unstableCases = HELDOUT_SEMANTIC_CASES
    .filter((c) => new Set(runs.map((run) => run.cases.find((result) => result.id === c.id)?.predicted)).size > 1)
    .map((c) => c.id);
  const summary = (key: keyof Pick<CandidateMetrics, "accuracyPct" | "precisionPct" | "recallPct" | "specificityPct" | "f1Pct" | "completionPct">) => {
    const values = runs.map((run) => run.metrics[key]);
    return { mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)), min: Math.min(...values), max: Math.max(...values) };
  };
  return {
    repetitions: runs.length,
    note: "Per-run mean/range only; repetitions are not independent samples.",
    meanRange: {
      accuracyPct: summary("accuracyPct"), precisionPct: summary("precisionPct"), recallPct: summary("recallPct"),
      specificityPct: summary("specificityPct"), f1Pct: summary("f1Pct"), completionPct: summary("completionPct"),
    },
    unstableCases,
    stablePredictionPct: round(100 * (HELDOUT_SEMANTIC_CASES.length - unstableCases.length) / HELDOUT_SEMANTIC_CASES.length),
  };
}

function absoluteGateResult(runs: CandidateRun[], aggregated: ReturnType<typeof aggregate>) {
  const g = protocol.absoluteGate;
  const promptInjectionFalsePositives = runs.flatMap((run) => run.cases).filter((c) => c.category === "prompt-injection-control" && c.predicted).length;
  const passed = runs.every((run) =>
    run.metrics.accuracyPct >= g.minimumAccuracyPctPerRun &&
    run.metrics.precisionPct >= g.minimumPrecisionPctPerRun &&
    run.metrics.recallPct >= g.minimumRecallPctPerRun &&
    run.metrics.completionPct >= g.minimumCompletionPctPerRun &&
    run.metrics.inconclusive <= g.maximumInconclusivePerRun,
  ) && aggregated.stablePredictionPct >= g.minimumStablePredictionPct && promptInjectionFalsePositives <= g.maximumPromptInjectionFalsePositivesAcrossRuns;
  return { passed, thresholds: g, promptInjectionFalsePositives };
}

function promotionGate(
  baselineRuns: CandidateRun[],
  candidateRuns: CandidateRun[],
  baselineAggregate: ReturnType<typeof aggregate>,
  candidateAggregate: ReturnType<typeof aggregate>,
) {
  const baselineAbsolute = absoluteGateResult(baselineRuns, baselineAggregate);
  const candidateAbsolute = absoluteGateResult(candidateRuns, candidateAggregate);
  const mean = (aggregateResult: ReturnType<typeof aggregate>, key: "accuracyPct" | "precisionPct" | "recallPct" | "completionPct") =>
    aggregateResult.meanRange[key].mean;
  const deltas = {
    accuracyPoints: round(mean(candidateAggregate, "accuracyPct") - mean(baselineAggregate, "accuracyPct")),
    precisionPoints: round(mean(candidateAggregate, "precisionPct") - mean(baselineAggregate, "precisionPct")),
    recallPoints: round(mean(candidateAggregate, "recallPct") - mean(baselineAggregate, "recallPct")),
    completionPoints: round(mean(candidateAggregate, "completionPct") - mean(baselineAggregate, "completionPct")),
    stabilityPoints: round(candidateAggregate.stablePredictionPct - baselineAggregate.stablePredictionPct),
    promptInjectionFalsePositiveIncrease:
      candidateAbsolute.promptInjectionFalsePositives - baselineAbsolute.promptInjectionFalsePositives,
  };
  const g = protocol.nonRegressionGate;
  const nonRegressionPassed =
    deltas.accuracyPoints >= g.minimumCandidateMinusBaselineAccuracyPoints &&
    deltas.precisionPoints >= g.minimumCandidateMinusBaselinePrecisionPoints &&
    deltas.recallPoints >= g.minimumCandidateMinusBaselineRecallPoints &&
    deltas.completionPoints >= g.minimumCandidateMinusBaselineCompletionPoints &&
    deltas.stabilityPoints >= g.minimumCandidateMinusBaselineStabilityPoints &&
    deltas.promptInjectionFalsePositiveIncrease <= g.maximumCandidatePromptInjectionFalsePositiveIncrease;
  const pairedRunDeltas = Array.from({ length: protocol.onlineRepetitionsPerArm }, (_, index) => {
    const repetition = index + 1;
    const baseline = baselineRuns.find((run) => run.repetition === repetition)!.metrics;
    const candidate = candidateRuns.find((run) => run.repetition === repetition)!.metrics;
    return {
      repetition,
      accuracyPoints: round(candidate.accuracyPct - baseline.accuracyPct),
      precisionPoints: round(candidate.precisionPct - baseline.precisionPct),
      recallPoints: round(candidate.recallPct - baseline.recallPct),
      completionPoints: round(candidate.completionPct - baseline.completionPct),
    };
  });
  return {
    passed: baselineAbsolute.passed && candidateAbsolute.passed && nonRegressionPassed,
    baselineAbsolute,
    candidateAbsolute,
    nonRegression: { passed: nonRegressionPassed, thresholds: g, deltas },
    pairedRunDeltas,
  };
}

function validateProtocol(): void {
  assertHeldoutDatasetInvariant();
  if (protocol.version !== "semantic-qwen37-ab-promotion-v1") throw new Error("unexpected promotion protocol version");
  if (protocol.dataset !== "semantic-heldout-v1" || protocol.datasetSha256 !== QWEN37_RC_DATASET_SHA256) throw new Error("dataset changed; create a new versioned candidate protocol");
  if (protocol.cases !== 48 || protocol.positives !== 24 || protocol.negatives !== 24) throw new Error("candidate dataset invariants failed");
  const expectedArms: Array<[PromotionArmId, string]> = [
    ["baseline", "qwen-plus"],
    ["candidate", "qwen3.7-plus-2026-05-26"],
  ];
  if (protocol.models.arms.length !== expectedArms.length) throw new Error("promotion protocol must define exactly two arms");
  expectedArms.forEach(([id, model], index) => {
    const arm = protocol.models.arms[index];
    if (
      arm?.id !== id || arm.judge !== model || arm.judgeTemperature !== 0 ||
      arm.judgeResponseFormat !== "json_object" || arm.judgeEnableThinking !== false ||
      !arm.judgeMaxTokens.startsWith("omitted")
    ) throw new Error("promotion arm structured-output invariant failed");
  });
  const expectedOrder: PromotionArmId[] = ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"];
  if (JSON.stringify(protocol.executionOrder) !== JSON.stringify(expectedOrder)) throw new Error("promotion execution order changed");
  if (protocol.onlineRepetitionsPerArm !== 3 || expectedArms.some(([id]) => protocol.executionOrder.filter((arm) => arm === id).length !== 3)) {
    throw new Error("promotion protocol must execute three repetitions per arm");
  }
  if (!protocol.embeddingReuseAcrossArmsAndRepetitions) throw new Error("promotion arms must share one frozen embedding pass");
  if (
    protocol.provider.service !== "Alibaba Cloud Model Studio / DashScope" ||
    protocol.provider.baseUrl !== PROMOTION_DASHSCOPE_BASE_URL ||
    protocol.provider.customEndpointsAllowed !== false
  ) throw new Error("promotion provider invariant failed");
  if (protocol.sourceFiles.length !== QWEN37_PROMOTION_SOURCE_EVIDENCE.files.length) throw new Error("promotion source manifest changed");
  if (protocol.sdk.applicationLevelRetries !== 0 || QWEN_MAX_RETRIES !== protocol.sdk.configuredMaxRetries) throw new Error(`QWEN_MAX_RETRIES must equal the protocol value ${protocol.sdk.configuredMaxRetries}`);
}

async function main(): Promise<void> {
  validateProtocol();
  const providerBaseUrl = assertPromotionBaseUrl();
  const attemptId = process.argv.slice(2).find((arg) => arg.startsWith("--attempt-id="))?.slice("--attempt-id=".length);
  if (!attemptId) throw new Error("online promotion run requires an explicit --attempt-id=<unique-id>");
  if (!hasQwenCreds()) throw new Error("promotion run requires provider credentials; no artifact was written");
  const paths = candidateAttemptPaths(attemptId);
  let prepared: PreparedAttempt | null = null;
  try {
    prepared = prepareCandidateAttempt(attemptId, paths, defaultIo(), undefined, providerBaseUrl);
    console.log(`Archon MemoryAgent — ${protocol.version}`);
    console.log("classification: observed developer-labelled synthetic A/B regression; NOT held-out or confirmatory evidence");
    console.log(`attempt=${attemptId} · commit=${prepared.repository.gitCommit} · source-clean-at-start=true`);
    console.log(`dataset sha256=${QWEN37_PROMOTION_DATASET_SHA256}`);
    console.log(`protocol sha256=${QWEN37_PROMOTION_PROTOCOL_SHA256}`);
    console.log(`source bundle sha256=${QWEN37_PROMOTION_SOURCE_EVIDENCE.bundleSha256}`);
    console.log(`provider base URL=${providerBaseUrl}`);
    console.log("arms=qwen-plus baseline + qwen3.7-plus-2026-05-26 candidate · temperature=0 · enable_thinking=false · max_tokens omitted");

    const embedder = new QwenEmbedder(undefined, protocol.models.embedder, protocol.models.embeddingDimensions);
    const armConfig = new Map(protocol.models.arms.map((arm) => [arm.id, arm]));
    const judges = new Map<PromotionArmId, QwenJudge>(protocol.models.arms.map((arm) => [
      arm.id,
      new QwenJudge(undefined, arm.judge, protocol.judgeTimeoutMs),
    ]));
    const embedded = await mapLimit(HELDOUT_SEMANTIC_CASES, protocol.embeddingConcurrency, (c) => embedPair(c, embedder));
    const pairs = new Map(HELDOUT_SEMANTIC_CASES.map((c, index) => [c.id, embedded[index]!]));
    appendArtifact(prepared, {
      event: "embedding_completed",
      completedAt: new Date().toISOString(),
      telemetry: {
        pairRequests: 48,
        vectorApplicationCalls: 96,
        pairFailures: embedded.filter((pair) => pair.error !== null).length,
        sdkInternalRetriesObserved: null,
      },
      cases: HELDOUT_SEMANTIC_CASES.map((c, index) => ({ id: c.id, latencyMs: embedded[index]!.latencyMs, error: embedded[index]!.error })),
    });

    const runs: CandidateRun[] = [];
    const repetitions: Record<PromotionArmId, number> = { baseline: 0, candidate: 0 };
    for (let sequence = 0; sequence < protocol.executionOrder.length; sequence++) {
      const arm = protocol.executionOrder[sequence]!;
      const repetition = ++repetitions[arm];
      const run = await runOne(arm, repetition, pairs, judges.get(arm)!);
      runs.push(run);
      appendArtifact(prepared, { event: "run_completed", sequence: sequence + 1, armConfig: armConfig.get(arm), run });
      const m = run.metrics;
      console.log(`${arm} run ${repetition}: accuracy ${m.accuracyPct}% · precision ${m.precisionPct}% · recall ${m.recallPct}% · completion ${m.completionPct}% · inconclusive ${m.inconclusive}`);
    }
    const baselineRuns = runs.filter((run) => run.arm === "baseline").sort((a, b) => a.repetition - b.repetition);
    const candidateRuns = runs.filter((run) => run.arm === "candidate").sort((a, b) => a.repetition - b.repetition);
    const aggregates = { baseline: aggregate(baselineRuns), candidate: aggregate(candidateRuns) };
    const gate = promotionGate(baselineRuns, candidateRuns, aggregates.baseline, aggregates.candidate);
    const completedAt = new Date().toISOString();
    appendArtifact(prepared, { event: "attempt_completed", completedAt, aggregates, gate });
    appendLedger(prepared, {
      event: "attempt_completed",
      completedAt,
      artifact: `bench/results/${paths.artifact.split(/[\\/]/).at(-1)}`,
      gatePassed: gate.passed,
      aggregates,
      deltas: gate.nonRegression.deltas,
    });
    console.log(`artifact: bench/results/${paths.artifact.split(/[\\/]/).at(-1)}`);
    console.log(`promotion gate: ${gate.passed ? "PASSED" : "FAILED"}`);
    if (!gate.passed) process.exitCode = 1;
  } catch (error) {
    if (prepared) {
      const failedAt = new Date().toISOString();
      appendArtifact(prepared, { event: "attempt_failed", failedAt, failure: "unexpected_promotion_runner_failure" });
      appendLedger(prepared, { event: "attempt_failed", failedAt, failure: "unexpected_promotion_runner_failure" });
    }
    throw error;
  }
}

const isDirect = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isDirect) {
  main().catch(() => {
    console.error("semantic promotion runner failed; inspect the repo-local attempt artifact when one was created");
    process.exitCode = 1;
  });
}

export const QWEN37_RC_RUNTIME = Object.freeze({
  baselineModel: protocol.models.arms.find((arm) => arm.id === "baseline")?.judge,
  candidateModel: protocol.models.arms.find((arm) => arm.id === "candidate")?.judge,
  embedderModel: protocol.models.embedder,
  enableThinking: false,
  nonThinking: protocol.models.arms.every((arm) => arm.judgeEnableThinking === false),
  maxTokensOmitted: protocol.models.arms.every((arm) => arm.judgeMaxTokens.startsWith("omitted")),
  providerBaseUrl: PROMOTION_DASHSCOPE_BASE_URL,
  executionOrder: [...protocol.executionOrder],
  requestTimeoutMs: QWEN_REQUEST_TIMEOUT_MS,
  sdkConfiguredMaxRetries: QWEN_MAX_RETRIES,
});
