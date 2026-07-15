// 48-pair held-out semantic-audit evaluation.
//
// Offline (deterministic CI):
//   npm run bench:semantic:heldout -- --gate
//
// Online v1.1 (real persisted-vector equivalent: text-embedding-v4 + qwen-plus):
//   npm run bench:semantic:heldout -- --online --repetitions=3 --write
//
// The dataset and protocol SHA-256 values are computed before any model call and
// written into the artifact. Every case, miss, provider failure, latency and
// repetition is preserved; there is no best-run selection. The online path embeds
// each statement once, then replays the same persisted vectors through the exact
// pure detector used by production while repeating the non-deterministic judge.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { FakeJudge, QwenJudge, detectSemanticContradictions, type JudgeVerdict, type SemanticJudge, type SemanticMemory } from "../src/memory/semantic-consistency.js";
import { QwenEmbedder } from "../src/memory/embeddings.js";
import { hasQwenCreds } from "../src/qwen/client.js";
import { cosineSimilarity } from "../src/memory/retrieval.js";
import { HELDOUT_SEMANTIC_CASES, assertHeldoutDatasetInvariant, type HeldoutSemanticCase } from "./semantic-heldout-dataset.js";

const DATASET_NAME = "semantic-heldout-v1";
const PROTOCOL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "protocol", "semantic-heldout-v1.1.json");
const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), "results", "semantic-heldout-qwen-v1.1.json");
const PREREGISTERED_PATHS = [
  "bench/semantic-heldout-dataset.ts",
  "bench/semantic-heldout-run.ts",
  "bench/protocol/semantic-heldout-v1.1.json",
] as const;

interface Protocol {
  version: string;
  dataset: string;
  datasetSha256: string;
  developerLabelledBeforeOnlineEvaluation: boolean;
  cases: number;
  positives: number;
  negatives: number;
  similarityThreshold: number;
  maxPairsPerCase: number;
  caseIsolation: boolean;
  onlineRepetitions: number;
  embeddingConcurrency: number;
  judgeConcurrency: number;
  judgeTimeoutMs: number;
  embeddingTimeoutMs: number;
  embeddingReuseAcrossRepetitions: boolean;
  models: { embedder: string; judge: string; embeddingDimensions: number; judgeTemperature: number; judgeMaxTokens: number; judgeResponseFormat: string };
  failureScoring: string;
  primaryReporting: string;
  selection: string;
  offlineGate: { minimumAccuracyPct: number; minimumPrecisionPct: number; minimumRecallPct: number; maximumInconclusive: number; maximumPromptInjectionFalsePositives: number };
  changeControl: {
    supersedesProtocol: string;
    evaluationBehaviorChanged: boolean;
    datasetOrLabelsChanged: boolean;
    modelOrThresholdChanged: boolean;
    reportingOnlyFix: string;
    preservedPriorArtifact: string;
  };
}

const protocolBytes = readFileSync(PROTOCOL_PATH, "utf8");
const protocol = JSON.parse(protocolBytes) as Protocol;
const THRESHOLD = protocol.similarityThreshold;
const MAX_PAIRS_PER_CASE = protocol.maxPairsPerCase;

export interface HeldoutCaseResult {
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

export interface HeldoutMetrics {
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

export interface HeldoutRun {
  repetition: number;
  startedAt: string;
  completedAt: string;
  metrics: HeldoutMetrics;
  cases: HeldoutCaseResult[];
}

export interface EmbeddingPair {
  a: number[];
  b: number[];
  error: string | null;
  latencyMs: number;
}

const stableDatasetJson = JSON.stringify(HELDOUT_SEMANTIC_CASES);
export const HELDOUT_DATASET_SHA256 = createHash("sha256").update(stableDatasetJson).digest("hex");
export const HELDOUT_PROTOCOL_SHA256 = createHash("sha256").update(protocolBytes).digest("hex");

function round(n: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(n * scale) / scale;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

function metrics(cases: HeldoutCaseResult[]): HeldoutMetrics {
  const complete = cases.filter((c) => c.status !== "inconclusive");
  const tp = complete.filter((c) => c.expected && c.predicted).length;
  const tn = complete.filter((c) => !c.expected && !c.predicted).length;
  const fp = cases.filter((c) => !c.expected && c.predicted).length;
  const fn = cases.filter((c) => c.expected && !c.predicted).length;
  const inconclusive = cases.filter((c) => c.status === "inconclusive").length;
  const correct = complete.filter((c) => c.expected === c.predicted).length;
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
    accuracyPct: round(100 * correct / Math.max(1, cases.length)),
    precisionPct: round(100 * precision),
    recallPct: round(100 * recall),
    specificityPct: round(100 * specificity),
    f1Pct: round(100 * (precision + recall ? 2 * precision * recall / (precision + recall) : 0)),
    detectorJudgeP50Ms: round(percentile(latencies, 0.5)),
    detectorJudgeP95Ms: round(percentile(latencies, 0.95)),
  };
}

function offlinePair(c: HeldoutSemanticCase): EmbeddingPair {
  return c.sameSubject
    ? { a: [1, 0, 0], b: [0.995, Math.sqrt(1 - 0.995 ** 2), 0], error: null, latencyMs: 0 }
    : { a: [1, 0, 0], b: [0, 1, 0], error: null, latencyMs: 0 };
}

async function embedOnline(c: HeldoutSemanticCase, embedder: QwenEmbedder): Promise<EmbeddingPair> {
  const started = performance.now();
  try {
    const [a, b] = await withTimeout(
      Promise.all([embedder.embed(c.statementA), embedder.embed(c.statementB)]),
      protocol.embeddingTimeoutMs,
      "embedding timed out",
    );
    return { a, b, error: null, latencyMs: round(performance.now() - started) };
  } catch {
    return { a: [], b: [], error: "embedding unavailable or timed out", latencyMs: round(performance.now() - started) };
  }
}

function memories(c: HeldoutSemanticCase, pair: EmbeddingPair): SemanticMemory[] {
  const base = {
    kind: "insight" as const,
    company: "Heldout Evaluation Co",
    period: "2026-06",
    metadata: {},
    importance: 0.5,
  };
  return [
    { ...base, id: `${c.id}-a`, sourceRef: `${c.id}:session-a`, content: c.statementA, createdAt: "2026-06-01T09:00:00.000Z", embedding: pair.a },
    { ...base, id: `${c.id}-b`, sourceRef: `${c.id}:session-b`, content: c.statementB, createdAt: "2026-06-15T09:00:00.000Z", embedding: pair.b },
  ];
}

async function evaluateCase(c: HeldoutSemanticCase, pair: EmbeddingPair, judge: SemanticJudge): Promise<HeldoutCaseResult> {
  const started = performance.now();
  if (pair.error) {
    return {
      id: c.id, category: c.category, expected: c.contradicts, predicted: false,
      status: "inconclusive", similarity: null, subjectGatePassed: false,
      judgeCalled: false, judgeVerdict: null, latencyMs: round(performance.now() - started), error: pair.error,
    };
  }
  let captured: JudgeVerdict | null = null;
  const capturingJudge: SemanticJudge = {
    modelId: judge.modelId,
    async judge(a, b) {
      captured = await judge.judge(a, b);
      return captured;
    },
  };
  const similarity = cosineSimilarity(pair.a, pair.b);
  const report = await detectSemanticContradictions(memories(c, pair), capturingJudge, {
    similarityThreshold: THRESHOLD,
    maxPairs: MAX_PAIRS_PER_CASE,
    concurrency: 1,
  });
  return {
    id: c.id,
    category: c.category,
    expected: c.contradicts,
    predicted: report.semanticContradictions.length > 0,
    status: report.status,
    similarity: round(similarity, 4),
    subjectGatePassed: report.candidatePairs === 1,
    judgeCalled: report.modelCalls === 1,
    judgeVerdict: captured,
    latencyMs: round(performance.now() - started),
    error: report.errors[0]?.reason ?? null,
  };
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function runOne(repetition: number, pairs: Map<string, EmbeddingPair>, judge: SemanticJudge): Promise<HeldoutRun> {
  const startedAt = new Date().toISOString();
  const cases = await mapLimit(HELDOUT_SEMANTIC_CASES, judge instanceof QwenJudge ? protocol.judgeConcurrency : 1, async (c) =>
    evaluateCase(c, pairs.get(c.id)!, judge),
  );
  return { repetition, startedAt, completedAt: new Date().toISOString(), metrics: metrics(cases), cases };
}

function aggregateRuns(runs: HeldoutRun[]) {
  const unstableCases = HELDOUT_SEMANTIC_CASES
    .filter((c) => new Set(runs.map((r) => r.cases.find((x) => x.id === c.id)?.predicted)).size > 1)
    .map((c) => c.id);
  const summarize = (key: keyof Pick<HeldoutMetrics, "accuracyPct" | "precisionPct" | "recallPct" | "specificityPct" | "f1Pct" | "completionPct">) => {
    const values = runs.map((r) => r.metrics[key]);
    return {
      mean: round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)),
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
    };
  };
  return {
    repetitions: runs.length,
    note: "Per-run mean/range only; repeated runs are not treated as independent samples.",
    meanRange: {
      accuracyPct: summarize("accuracyPct"),
      precisionPct: summarize("precisionPct"),
      recallPct: summarize("recallPct"),
      specificityPct: summarize("specificityPct"),
      f1Pct: summarize("f1Pct"),
      completionPct: summarize("completionPct"),
    },
    unstableCases,
    stablePredictionPct: round(100 * (HELDOUT_SEMANTIC_CASES.length - unstableCases.length) / HELDOUT_SEMANTIC_CASES.length),
  };
}

export function embeddingEvidence(pairs: Map<string, EmbeddingPair>) {
  // v1 reporting bug: `pair?.error ?? "missing"` converted the intentional
  // success sentinel `null` into a false "missing" error for every embedded
  // case. v1.1 distinguishes an absent map entry from a present successful pair.
  const cases = HELDOUT_SEMANTIC_CASES.map((c) => {
    const pair = pairs.get(c.id);
    return {
      id: c.id,
      latencyMs: pair?.latencyMs ?? 0,
      error: pair ? pair.error : "missing",
    };
  });
  const latencies = cases.map((c) => c.latencyMs).sort((a, b) => a - b);
  return {
    pairs: cases.length,
    failures: cases.filter((c) => c.error !== null).length,
    pairLatencyMs: { p50: round(percentile(latencies, .5)), p95: round(percentile(latencies, .95)), max: round(latencies.at(-1) ?? 0) },
    cases,
  };
}

function repositoryMetadata() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const lock = JSON.parse(readFileSync(resolve(repo, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string }> };
  const pkg = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8")) as { version?: string };
  return {
    gitCommit: git(["rev-parse", "HEAD"]),
    gitDirty: git(["status", "--porcelain"]).length > 0,
    command: [process.execPath, ...process.argv.slice(1)].join(" "),
    node: process.version,
    appVersion: pkg.version ?? "unknown",
    openaiSdkVersion: lock.packages?.["node_modules/openai"]?.version ?? "unknown",
  };
}

function snapshot(mode: "offline" | "online", startedAt: string, runs: HeldoutRun[], pairs: Map<string, EmbeddingPair>, models: { embedder: string; judge: string }, completed = false) {
  return {
    schemaVersion: "1.1",
    mode,
    dataset: { name: DATASET_NAME, sha256: HELDOUT_DATASET_SHA256, cases: 48, positives: 24, negatives: 24 },
    protocol: { ...protocol, sha256: HELDOUT_PROTOCOL_SHA256 },
    models,
    repository: repositoryMetadata(),
    embedding: embeddingEvidence(pairs),
    startedAt,
    completedAt: completed ? new Date().toISOString() : null,
    completed,
    runs,
    aggregate: aggregateRuns(runs),
    caveats: [
      "Synthetic, hand-authored business-memory pairs are not a production prevalence sample.",
      "Confidence is an ordinal model output, not a calibrated probability.",
      "Offline vectors isolate judge behavior; online vectors exercise text-embedding-v4 subject gating.",
      "Online embeddings are frozen once and reused across repetitions, matching production persisted-vector reuse.",
      "All cases, misses, errors and repetitions are retained; no run is selected or discarded.",
      "Each pair is evaluated in isolation. This measures subject gating plus opposition judgement, not full-corpus O(n²) candidate ranking or maxPairs truncation.",
      "The 48 labels are synthetic and developer-authored before the online run; they are not independent expert annotations.",
      "Detector/judge p50 and p95 exclude the one-time embedding step; embedding latency is reported separately.",
      "Three repetitions measure output stability on one frozen set; they are not 144 independent samples.",
      "Protocol v1.1 changes reporting only: it preserves null for successful embedding pairs. Dataset, labels, model, thresholds, calls, scoring and selection are unchanged from v1.",
      "The contradictory v1 artifact is retained verbatim at bench/results/semantic-heldout-qwen-v1-reporting-bug.json; v1.1 never overwrites it.",
    ],
  };
}

function persist(value: unknown): void {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
}

function printRun(run: HeldoutRun): void {
  const m = run.metrics;
  console.log(`run ${run.repetition}: accuracy ${m.accuracyPct}% · precision ${m.precisionPct}% · recall ${m.recallPct}% · specificity ${m.specificityPct}% · F1 ${m.f1Pct}%`);
  console.log(`  TP ${m.truePositives} · TN ${m.trueNegatives} · FP ${m.falsePositives} · FN ${m.falseNegatives} · inconclusive ${m.inconclusive} · completion ${m.completionPct}%`);
  console.log(`  detector+judge latency (embedding excluded): p50 ${m.detectorJudgeP50Ms}ms · p95 ${m.detectorJudgeP95Ms}ms`);
  const misses = run.cases.filter((c) => c.expected !== c.predicted || c.status === "inconclusive").map((c) => `${c.id}:${c.status === "inconclusive" ? "error" : c.predicted ? "FP" : "FN"}`);
  console.log(`  misses/errors: ${misses.length ? misses.join(", ") : "none"}`);
}

export async function runHeldoutOffline(): Promise<HeldoutRun> {
  assertHeldoutDatasetInvariant();
  const pairs = new Map(HELDOUT_SEMANTIC_CASES.map((c) => [c.id, offlinePair(c)]));
  return runOne(1, pairs, new FakeJudge());
}

async function main(): Promise<void> {
  assertHeldoutDatasetInvariant();
  const args = process.argv.slice(2);
  const online = args.includes("--online");
  const write = args.includes("--write");
  const gate = args.includes("--gate");
  const rawRepetitions = args.find((a) => a.startsWith("--repetitions="))?.split("=")[1];
  const repetitions = online ? Number(rawRepetitions ?? protocol.onlineRepetitions) : 1;
  const startedAt = new Date().toISOString();

  if (protocol.dataset !== DATASET_NAME || protocol.datasetSha256 !== HELDOUT_DATASET_SHA256 || protocol.cases !== 48 || protocol.positives !== 24 || protocol.negatives !== 24) {
    throw new Error("dataset no longer matches the pre-registered v1.1 protocol; create v2 instead of editing v1.1");
  }
  if (protocol.version !== "1.1" || protocol.changeControl.evaluationBehaviorChanged || protocol.changeControl.datasetOrLabelsChanged || protocol.changeControl.modelOrThresholdChanged) {
    throw new Error("v1.1 is a reporting-only revision; protocol change-control invariant failed");
  }
  if (online && repetitions !== protocol.onlineRepetitions) throw new Error(`v1.1 online protocol requires exactly ${protocol.onlineRepetitions} repetitions`);
  if (online && !write) throw new Error("v1.1 online protocol requires --write so partial runs and every failure are preserved");

  console.log(`Archon MemoryAgent — ${DATASET_NAME}`);
  console.log(`protocol version: ${protocol.version} (reporting-only revision of v1)`);
  console.log(`dataset sha256 : ${HELDOUT_DATASET_SHA256}`);
  console.log(`protocol sha256: ${HELDOUT_PROTOCOL_SHA256}`);
  console.log(`mode=${online ? "online" : "offline"} · cases=48 (24 positive / 24 hard control) · repetitions=${repetitions}`);

  if (online) {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of PREREGISTERED_PATHS) {
      execFileSync("git", ["ls-files", "--error-unmatch", file], { cwd: repo, stdio: "ignore" });
      try {
        execFileSync("git", ["diff", "--quiet", "HEAD", "--", file], { cwd: repo, stdio: "ignore" });
        execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--", file], { cwd: repo, stdio: "ignore" });
      } catch {
        throw new Error(`online v1.1 refuses an uncommitted preregistration file: ${file}`);
      }
    }
  }
  if (online && !hasQwenCreds()) throw new Error("--online requires DASHSCOPE_API_KEY; no artifact was written");
  const embedder = online ? new QwenEmbedder(undefined, protocol.models.embedder, protocol.models.embeddingDimensions) : null;
  const judge: SemanticJudge = online ? new QwenJudge(undefined, protocol.models.judge, protocol.judgeTimeoutMs) : new FakeJudge();
  const pairs = new Map<string, EmbeddingPair>();
  if (online) {
    console.log("freezing text-embedding-v4 vectors before repeated judge runs...");
    const embedded = await mapLimit(HELDOUT_SEMANTIC_CASES, protocol.embeddingConcurrency, (c) => embedOnline(c, embedder!));
    HELDOUT_SEMANTIC_CASES.forEach((c, i) => pairs.set(c.id, embedded[i]!));
  } else {
    HELDOUT_SEMANTIC_CASES.forEach((c) => pairs.set(c.id, offlinePair(c)));
  }

  const runs: HeldoutRun[] = [];
  const models = { embedder: embedder?.modelId ?? "orthogonal-fixture-v1", judge: judge.modelId };
  if (write) persist(snapshot(online ? "online" : "offline", startedAt, runs, pairs, models, false));
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    runs.push(await runOne(repetition, pairs, judge));
    printRun(runs.at(-1)!);
    if (write) persist(snapshot(online ? "online" : "offline", startedAt, runs, pairs, models, false));
  }
  const artifact = snapshot(online ? "online" : "offline", startedAt, runs, pairs, models, true);
  if (write) {
    persist(artifact);
    console.log(`artifact: ${OUTPUT}`);
  }

  if (gate) {
    const injectionFp = runs.flatMap((r) => r.cases).filter((c) => c.category === "prompt-injection-control" && c.predicted).length;
    const g = protocol.offlineGate;
    const ok = runs.every((r) => r.metrics.accuracyPct >= g.minimumAccuracyPct && r.metrics.precisionPct >= g.minimumPrecisionPct && r.metrics.recallPct >= g.minimumRecallPct && r.metrics.inconclusive <= g.maximumInconclusive) && injectionFp <= g.maximumPromptInjectionFalsePositives;
    if (!ok) throw new Error(`held-out gate failed; see complete per-run metrics and retained misses above`);
    console.log("GATE PASSED — honest broad-set floors met; every case and hard control included.");
  }
}

const isDirect = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirect) main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
