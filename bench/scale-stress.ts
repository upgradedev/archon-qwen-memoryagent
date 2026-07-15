// Reproducible scale + bounded-context + lifecycle evidence.
//
//   npm run bench:scale -- --gate                  # deterministic in-memory path
//   npm run bench:scale -- --gate --write          # sanitized repo-local artifact
//   npm run bench:scale -- --pg --count=1000 --write  # optional real pgvector
//
// Unlike the old random 1,000-row microbenchmark, this runner uses a seeded
// corpus, reports p50/p95/p99 rather than a machine-sensitive average SLA, and
// gates behavioral invariants instead of pretending local latency predicts cloud
// production. The optional pgvector mode uses a unique tenant and deletes every
// inserted row in a finally block; it never clears or mutates another tenant.

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { cpus, platform } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { closePool } from "../src/db/client.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { InMemoryStore, PgVectorStore, type MemoryStore, type StoredMemory } from "../src/memory/store.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "protocol", "scale-lifecycle-v2.json");
const protocolBytes = readFileSync(PROTOCOL_PATH, "utf8");
const protocol = JSON.parse(protocolBytes) as {
  version: 2;
  name: string;
  corpus: { defaultMemories: number; minimumMemories: number; maximumMemories: number; embeddingDimensions: number; companies: number; synthetic: true; vectorGenerator: string };
  retrieval: { queries: number; targetIndexFormula: string; goldTarget: string; queryVector: string; queryText: string; hybrid: true; topK: number; qualityMetrics: string[] };
  boundedContext: { scope: string; returnedContext: string; tokenEstimator: string; interpretation: string };
  lifecycle: { duplicateRows: number; distinctRows: number; consolidationThreshold: number; feedbackScenario: string };
  gate: { minimumGoldTargetHitAt1Pct: number; minimumGoldTargetHitAt5Pct: number; minimumMeanReciprocalRank: number; minimumEstimatedContextReductionPctAtDefaultSize: number; requireEveryQueryReturnsTopK: boolean; requireLifecycleInvariants: boolean; latencyIsNeverAGate: boolean };
};
const PROTOCOL_SHA256 = createHash("sha256").update(protocolBytes).digest("hex");
const VECTOR_DIM = protocol.corpus.embeddingDimensions;
const DEFAULT_MEMORY_COUNT = protocol.corpus.defaultMemories;
const QUERY_COUNT = protocol.retrieval.queries;
const TOP_K = protocol.retrieval.topK;
const COMPANIES = [
  "Aster Works",
  "Blue Harbor",
  "Cedar Labs",
  "Delta Forge",
  "Evergreen Retail",
  "Fjord Systems",
  "Granite Foods",
  "Northstar Services",
] as const;
const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "results");

interface LatencySummary { minMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; meanMs: number }
interface RepositoryMetadata { gitCommit: string; gitDirty: boolean; command: string }
interface ScaleResult {
  schemaVersion: 2;
  mode: "in-memory-exact-cosine" | "postgres-pgvector";
  generatedAt: string;
  corpus: { memories: number; dimensions: number; companies: number; sha256: string; synthetic: true };
  ingest: { totalMs: number; meanPerMemoryMs: number };
  protocol: typeof protocol & { sha256: string; parameterDeviation: null | { corpusMemories: number; defaultMemories: number } };
  repository: RepositoryMetadata;
  retrieval: {
    queries: number;
    topK: number;
    returnedAllTopK: boolean;
    quality: { goldTargetHitAt1Pct: number; goldTargetHitAt5Pct: number; meanReciprocalRank: number; misses: string[] };
    latency: LatencySummary;
  };
  boundedContext: { scopedMemoriesMean: number; scopedEstimatedTokensMean: number; topKEstimatedTokensMean: number; estimatedTokenReductionPct: number; estimator: string; interpretation: string };
  lifecycle: Awaited<ReturnType<typeof lifecycleEvidence>>;
  environment: { node: string; platform: string; cpu: string };
  caveats: string[];
}

function round(n: number, places = 3): number { const s = 10 ** places; return Math.round(n * s) / s; }
function pct(sorted: number[], q: number): number { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0; }
function latencySummary(values: number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b);
  return { minMs: round(sorted[0] ?? 0), p50Ms: round(pct(sorted, .5)), p95Ms: round(pct(sorted, .95)), p99Ms: round(pct(sorted, .99)), maxMs: round(sorted.at(-1) ?? 0), meanMs: round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)) };
}

export function sanitizedScaleCommand(args: readonly string[]): string {
  const supported = args.filter((arg) => arg === "--pg" || arg === "--gate" || arg === "--write" || /^--count=\d+$/.test(arg));
  return ["node", "bench/scale-stress.ts", ...supported].join(" ");
}

function repositoryMetadata(commandArgs: readonly string[] = process.argv.slice(2)): RepositoryMetadata {
  const git = (args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return {
    gitCommit: git(["rev-parse", "HEAD"]),
    gitDirty: git(["status", "--porcelain"]).length > 0,
    command: sanitizedScaleCommand(commandArgs),
  };
}

export function assertWritableScaleRepository(repository: RepositoryMetadata): void {
  if (repository.gitDirty) {
    throw new Error("--write requires a clean whole repository before benchmark work starts");
  }
}

export function scaleArtifactPath(pg: boolean): string {
  return resolve(OUTPUT_DIR, pg ? "scale-lifecycle-pgvector-v2.json" : "scale-lifecycle-offline-v2.json");
}

export function assertScaleArtifactAvailable(
  path: string,
  exists: (candidate: string) => boolean = existsSync,
): void {
  if (exists(path)) {
    throw new Error(`scale evidence already exists at bench/results/${basename(path)}; create a new protocol/version instead of overwriting it`);
  }
}

/** Publish a complete evidence document atomically and refuse every overwrite. */
export function writeScaleArtifactExclusive(path: string, contents: string): void {
  assertScaleArtifactAvailable(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o644);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    // A hard link publishes the already-complete inode and fails with EEXIST if
    // another process won the target name. Unlike rename on POSIX it cannot
    // replace a prior evidence artifact.
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(`scale evidence already exists at bench/results/${basename(path)}; create a new protocol/version instead of overwriting it`);
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

// Mulberry32: tiny deterministic PRNG. Seed and algorithm are part of the corpus.
function prng(seed: number): () => number {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function vectorFor(index: number): number[] {
  const random = prng(0x51a7e + index * 997);
  const v = new Array<number>(VECTOR_DIM).fill(0);
  for (let j = 0; j < 16; j++) v[Math.floor(random() * VECTOR_DIM)]! += random() * 2 - 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function memoryFor(index: number, tenantId: string): StoredMemory {
  const company = COMPANIES[index % COMPANIES.length]!;
  const period = `2026-${String(index % 12 + 1).padStart(2, "0")}`;
  const invoice = `INV-${20_000 + index}`;
  return {
    tenantId,
    kind: index % 4 === 0 ? "invoice" : "insight",
    company,
    period,
    sourceRef: `scale:${index}`,
    idempotencyKey: `scale:${index}`,
    content: `${invoice} for ${company}, period ${period}: approved total ${100 + index * 7} EUR; purchase category ${index % 17}; batch ${Math.floor(index / 50)}.`,
    metadata: { record: invoice, synthetic: true, index },
    importance: round((index % 10) / 10, 1),
    embedding: vectorFor(index),
    embedModel: "deterministic-sparse-vector-v1",
  };
}

/** Hash every logical corpus byte, including vectors, while omitting only the run-isolation tenant id. */
export function logicalCorpusSha256(corpus: readonly StoredMemory[]): string {
  const hash = createHash("sha256");
  hash.update("[");
  corpus.forEach(({ tenantId: _tenantId, ...logicalMemory }, index) => {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify(logicalMemory));
  });
  hash.update("]");
  return hash.digest("hex");
}

function estimatedTokens(text: string): number { return Math.ceil(text.length / 4); }

export async function lifecycleEvidence() {
  const store = new InMemoryStore();
  const embedder = new FakeEmbedder();
  const agent = new MemoryAgent(embedder, store, new FakeNarrator());
  const duplicate = "Aster Works renewal policy is approved for the 2026 cycle.";
  for (let i = 0; i < 12; i++) await agent.remember("insight", duplicate, { company: "Aster Works", period: "2026-06", sourceRef: `session-${i}`, importance: i === 11 ? .95 : .4 });
  for (let i = 0; i < 18; i++) await agent.remember("document", `Distinct retained fact ${i} for Aster Works.`, { company: "Aster Works", period: "2026-06", importance: .6 });
  const q = await embedder.embed(duplicate);
  const before = await store.recall(q, { company: "Aster Works", hybrid: true, queryText: duplicate, limit: 20 });
  const duplicatesBefore = before.filter((h) => h.content === duplicate).length;
  const lifecycleActor = "benchmark:scale-lifecycle-v2";
  const preview = await agent.consolidate({
    company: "Aster Works", threshold: .99, dryRun: true,
    operationId: "scale-consolidate-preview-v2", actor: lifecycleActor,
    reason: "Preview deterministic duplicate consolidation evidence",
  });
  const applied = await agent.consolidate({
    company: "Aster Works", threshold: .99, dryRun: false,
    operationId: "scale-consolidate-apply-v2", actor: lifecycleActor,
    reason: "Apply deterministic duplicate consolidation evidence",
  });
  const after = await store.recall(q, { company: "Aster Works", hybrid: true, queryText: duplicate, limit: 20 });
  const duplicatesAfter = after.filter((h) => h.content === duplicate).length;
  const forgotten = await agent.forget(
    { deleteSuperseded: true }, "Aster Works", undefined, false,
    {
      operationId: "scale-forget-superseded-v2", actor: lifecycleActor,
      reason: "Remove only rows superseded by the benchmark consolidation",
    },
  );

  const wrong = "Aster Works warranty W-9 expires after 12 months.";
  const corrected = "Aster Works warranty W-9 expires after 24 months.";
  const wrongId = await agent.remember("insight", wrong, { company: "Aster Works", period: "2026-06", importance: .2 });
  const feedback = await agent.applyFeedback(wrongId, "incorrect", corrected, { feedbackId: "scale-lifecycle-feedback-v1" });
  const feedbackRows = await store.listForAudit({ company: "Aster Works" });
  const oldVisible = feedbackRows.some((m) => m.id === wrongId);
  const correctedVisible = feedbackRows.some((m) => m.id === feedback.correctedMemoryId && m.content === corrected);

  return {
    initialRows: 30,
    duplicateRecallBefore: duplicatesBefore,
    consolidationPreview: { clusters: preview.clusters, planned: preview.planned, dryRun: preview.dryRun },
    consolidationApplied: { clusters: applied.clusters, superseded: applied.superseded },
    duplicateRecallAfter: duplicatesAfter,
    forgetting: { candidates: forgotten.candidates, forgotten: forgotten.forgotten },
    feedback: { oldMemorySupersededAndHidden: !oldVisible, correctedMemoryVisible: correctedVisible, correctedMemoryCreated: Boolean(feedback.correctedMemoryId) },
  };
}

async function insertBatches(store: MemoryStore, corpus: StoredMemory[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < corpus.length; i += 100) ids.push(...await store.rememberMany(corpus.slice(i, i + 100)));
  return ids;
}

export async function runScale(
  mode: "in-memory-exact-cosine" | "postgres-pgvector",
  count: number,
  repository: RepositoryMetadata = repositoryMetadata(),
): Promise<ScaleResult> {
  const tenantId = `bench-scale-${process.pid}-${Date.now()}`;
  const store: MemoryStore = mode === "postgres-pgvector" ? new PgVectorStore() : new InMemoryStore();
  const corpus = Array.from({ length: count }, (_, i) => memoryFor(i, tenantId));
  // Tenant ids include the process/time solely for isolation and cleanup. Omit
  // only the tenant id from the logical-corpus hash so repeated runs over the
  // same frozen synthetic corpus produce the same SHA-256. Embeddings are part
  // of the evidence and therefore MUST be hashed.
  const corpusSha = logicalCorpusSha256(corpus);
  let ids: string[] = [];
  try {
    const ingestStarted = performance.now();
    ids = await insertBatches(store, corpus);
    const ingestMs = performance.now() - ingestStarted;
    const latencies: number[] = [];
    let allTopK = true;
    let topTokens = 0;
    let scopedRowsTotal = 0;
    let scopedTokensTotal = 0;
    let hitAt1 = 0;
    let hitAt5 = 0;
    let reciprocalRankTotal = 0;
    const misses: string[] = [];
    for (let i = 0; i < QUERY_COUNT; i++) {
      const index = (i * 31) % count;
      const target = corpus[index]!;
      const started = performance.now();
      let hits: Awaited<ReturnType<MemoryStore["recall"]>> = [];
      try {
        const invoice = String(target.metadata?.record ?? "");
        hits = await store.recall(target.embedding, { tenantId, company: target.company, queryText: `${invoice} approved total`, hybrid: true, limit: TOP_K });
      } catch {
        misses.push(`q${String(i + 1).padStart(2, "0")}:${target.sourceRef}:retrieval-error`);
      }
      latencies.push(performance.now() - started);
      allTopK &&= hits.length === TOP_K;
      const rank = hits.findIndex((hit) => hit.sourceRef === target.sourceRef);
      if (rank === 0) hitAt1 += 1;
      if (rank >= 0 && rank < TOP_K) {
        hitAt5 += 1;
        reciprocalRankTotal += 1 / (rank + 1);
      } else if (!misses.at(-1)?.includes(target.sourceRef ?? "")) {
        misses.push(`q${String(i + 1).padStart(2, "0")}:${target.sourceRef}:target-miss`);
      }
      topTokens += hits.reduce((n, h) => n + estimatedTokens(h.content), 0);
      const scoped = corpus.filter((memory) => memory.company === target.company);
      scopedRowsTotal += scoped.length;
      scopedTokensTotal += scoped.reduce((n, memory) => n + estimatedTokens(memory.content), 0);
    }
    const quality = {
      goldTargetHitAt1Pct: round(100 * hitAt1 / QUERY_COUNT),
      goldTargetHitAt5Pct: round(100 * hitAt5 / QUERY_COUNT),
      meanReciprocalRank: round(reciprocalRankTotal / QUERY_COUNT, 4),
      misses,
    };
    const scopedRowsMean = scopedRowsTotal / QUERY_COUNT;
    const scopedTokensMean = scopedTokensTotal / QUERY_COUNT;
    const topMean = topTokens / QUERY_COUNT;
    const lifecycle = await lifecycleEvidence();
    return {
      schemaVersion: 2,
      mode,
      generatedAt: new Date().toISOString(),
      corpus: { memories: count, dimensions: VECTOR_DIM, companies: COMPANIES.length, sha256: corpusSha, synthetic: true },
      ingest: { totalMs: round(ingestMs), meanPerMemoryMs: round(ingestMs / count, 6) },
      protocol: {
        ...protocol,
        sha256: PROTOCOL_SHA256,
        parameterDeviation: count === DEFAULT_MEMORY_COUNT ? null : { corpusMemories: count, defaultMemories: DEFAULT_MEMORY_COUNT },
      },
      repository,
      retrieval: { queries: QUERY_COUNT, topK: TOP_K, returnedAllTopK: allTopK, quality, latency: latencySummary(latencies) },
      boundedContext: {
        scopedMemoriesMean: round(scopedRowsMean, 2),
        scopedEstimatedTokensMean: round(scopedTokensMean, 2),
        topKEstimatedTokensMean: round(topMean),
        estimatedTokenReductionPct: round(100 * (1 - topMean / scopedTokensMean), 2),
        estimator: protocol.boundedContext.tokenEstimator,
        interpretation: protocol.boundedContext.interpretation,
      },
      lifecycle,
      environment: { node: process.version, platform: platform(), cpu: cpus()[0]?.model ?? "unknown" },
      caveats: [
        "Synthetic corpus; it measures this implementation, not production data prevalence or end-user latency.",
        mode === "postgres-pgvector" ? "Real PostgreSQL/pgvector query path; host and database topology still affect latency." : "In-memory exact-cosine/BM25 implementation; use --pg for the production SQL/pgvector path.",
        "Latency includes store retrieval and ranking only; it excludes network, embedding, reranking and narration.",
        "Gold-target quality is a controlled exact-vector plus unique-invoice lookup; it validates index/ranking correctness at corpus size, not semantic-query generalization.",
        "Context reduction uses a disclosed character heuristic, not a Qwen tokenizer; it does not establish answer quality, latency, token billing, cost, or savings.",
        "Latency is reported, never used as a cross-machine pass/fail SLA.",
      ],
    };
  } finally {
    if (mode === "postgres-pgvector" && ids.length) await store.deleteMemories(ids, tenantId);
    if (mode === "postgres-pgvector") await closePool();
  }
}

function print(result: ScaleResult): void {
  console.log(`Archon scale/lifecycle evidence — ${result.mode}`);
  console.log(`protocol ${result.protocol.name} · sha256 ${result.protocol.sha256}`);
  console.log(`corpus ${result.corpus.memories} × ${result.corpus.dimensions}d · ${result.retrieval.queries} hybrid queries · top-${result.retrieval.topK}`);
  console.log(`gold target: hit@1 ${result.retrieval.quality.goldTargetHitAt1Pct}% · hit@5 ${result.retrieval.quality.goldTargetHitAt5Pct}% · MRR ${result.retrieval.quality.meanReciprocalRank} · misses ${result.retrieval.quality.misses.length}`);
  console.log(`retrieval p50 ${result.retrieval.latency.p50Ms}ms · p95 ${result.retrieval.latency.p95Ms}ms · p99 ${result.retrieval.latency.p99Ms}ms`);
  console.log(`directional context-size estimate: ${result.boundedContext.estimatedTokenReductionPct}% fewer estimated tokens (${result.boundedContext.scopedMemoriesMean} mean scoped rows → top-${result.retrieval.topK})`);
  console.log(`lifecycle: duplicates ${result.lifecycle.duplicateRecallBefore} → ${result.lifecycle.duplicateRecallAfter}; superseded ${result.lifecycle.consolidationApplied.superseded}; forgotten ${result.lifecycle.forgetting.forgotten}; feedback corrected=${result.lifecycle.feedback.correctedMemoryVisible}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unsupported = args.filter((arg) => arg !== "--pg" && arg !== "--gate" && arg !== "--write" && !/^--count=\d+$/.test(arg));
  if (unsupported.length > 0) throw new Error(`unsupported argument(s): ${unsupported.join(", ")}`);
  const pg = args.includes("--pg");
  const gate = args.includes("--gate");
  const write = args.includes("--write");
  const rawCount = Number(args.find((a) => a.startsWith("--count="))?.split("=")[1] ?? DEFAULT_MEMORY_COUNT);
  const count = Math.max(protocol.corpus.minimumMemories, Math.min(protocol.corpus.maximumMemories, Number.isFinite(rawCount) ? Math.floor(rawCount) : DEFAULT_MEMORY_COUNT));
  if (pg && !process.env.DATABASE_URL) throw new Error("--pg requires DATABASE_URL");
  if (gate && count !== DEFAULT_MEMORY_COUNT) {
    throw new Error(`--gate requires the frozen default corpus size ${DEFAULT_MEMORY_COUNT}; run non-default sizes without --gate`);
  }
  const repository = repositoryMetadata(args);
  const outputPath = scaleArtifactPath(pg);
  if (write) {
    assertWritableScaleRepository(repository);
    assertScaleArtifactAvailable(outputPath);
  }
  const result = await runScale(pg ? "postgres-pgvector" : "in-memory-exact-cosine", count, repository);
  print(result);
  if (write) {
    const beforeWrite = repositoryMetadata(args);
    if (beforeWrite.gitDirty || beforeWrite.gitCommit !== repository.gitCommit) {
      throw new Error("repository changed during benchmark; refusing to write stale-provenance evidence");
    }
    writeScaleArtifactExclusive(outputPath, JSON.stringify(result, null, 2) + "\n");
    console.log(`artifact: bench/results/${basename(outputPath)}`);
  }
  if (gate) {
    const l = result.lifecycle;
    const g = result.protocol.gate;
    const ok = (!g.requireEveryQueryReturnsTopK || result.retrieval.returnedAllTopK) &&
      result.retrieval.quality.goldTargetHitAt1Pct >= g.minimumGoldTargetHitAt1Pct &&
      result.retrieval.quality.goldTargetHitAt5Pct >= g.minimumGoldTargetHitAt5Pct &&
      result.retrieval.quality.meanReciprocalRank >= g.minimumMeanReciprocalRank &&
      result.retrieval.quality.misses.length === 0 &&
      result.boundedContext.estimatedTokenReductionPct >= g.minimumEstimatedContextReductionPctAtDefaultSize &&
      l.duplicateRecallBefore > 1 && l.duplicateRecallAfter === 1 &&
      l.consolidationPreview.dryRun && l.consolidationApplied.superseded > 0 &&
      l.forgetting.forgotten === l.consolidationApplied.superseded &&
      l.feedback.oldMemorySupersededAndHidden && l.feedback.correctedMemoryVisible;
    if (!ok) throw new Error("scale/lifecycle behavioral gate failed");
    console.log("GATE PASSED — gold-target retrieval, directional context-size and lifecycle invariants hold; latency is not gated.");
  }
}

const isDirect = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isDirect) main().catch(() => {
  console.error("scale/lifecycle runner failed; no evidence artifact was overwritten");
  process.exit(1);
});
