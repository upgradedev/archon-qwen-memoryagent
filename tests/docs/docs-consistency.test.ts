// Docs-consistency fitness functions — three executable guards against
// documentation drift. They keep README.md honest against the code, the
// architecture diagram honest against src/, and the quoted benchmark numbers
// honest against a committed golden SSOT. All fully offline (no key, no DB):
// the Fastify app boots with the deterministic Fakes and route introspection
// via `hasRoute` never opens the pg pool.
//
//   CHECK 1 — README claims  ↔ code   (doc-drift / doc-code consistency)
//   CHECK 2 — Mermaid diagram ↔ src/  (architecture conformance)
//   CHECK 3 — README metrics ↔ bench/golden.json (golden snapshot)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { DEMO_PRIMARY_RECALL_QUESTION, DEMO_TEMPLATES } from "../../src/demo-data.js";
import { MEMORY_KINDS, SKILLS } from "../../src/skills/schemas.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const readText = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const README = readText("README.md");

function pythonConcatenatedString(source: string, name: string): string {
  const assignment = source.match(new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)^\\)`, "m"));
  assert.ok(assignment?.[1], `${name} must be a parenthesized Python string assignment`);
  const literals = assignment[1].match(/"(?:\\.|[^"\\])*"/g) ?? [];
  assert.ok(literals.length > 0, `${name} must contain at least one Python string literal`);
  return literals.map((literal) => JSON.parse(literal) as string).join("");
}

// Tokens that MATCH the model-id regex but are NOT models (package/repo slugs or
// protocol/header names). Excluded from both the code set and the README set.
const NON_MODEL_TOKENS = new Set(["qwen-memoryagent", "qwen-work-units"]);
// Matches Qwen/DashScope model ids: `text-embedding-vN`, `qwen-plus`,
// `qwen-vl-max`, etc. Deliberately broad so a *phantom* model in the README
// (e.g. `qwen-turbo` the code never uses) is still caught.
const MODEL_RE = /\b(?:text-embedding-v\d+|qwen-[a-z]+(?:-[a-z]+)*)\b/g;

function modelsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(MODEL_RE)) {
    if (!NON_MODEL_TOKENS.has(m[0])) out.add(m[0]);
  }
  return out;
}

// Recursively collect model-id string literals actually referenced in src/.
function codeModelSet(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".ts")) {
        for (const model of modelsIn(readFileSync(p, "utf8"))) out.add(model);
      }
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

let app: FastifyInstance;

before(async () => {
  delete process.env.DASHSCOPE_API_KEY; // guarantee offline Fakes, never a real call
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
});

// ─── CHECK 1 — README claims ↔ code ──────────────────────────────────────────

test("CHECK 1a — every model id in README is one the code actually uses (no phantom models)", () => {
  const code = codeModelSet();
  const readme = modelsIn(README);

  assert.ok(code.size >= 3, `expected the code to reference model ids, found ${[...code]}`);
  assert.ok(!code.has("qwen-work-units"), "HTTP quota headers must not be classified as Qwen model ids");

  // HARD: no phantom — a model the README advertises but the code never uses.
  const phantom = [...readme].filter((m) => !code.has(m));
  assert.deepEqual(
    phantom,
    [],
    `README mentions model id(s) the code never references: ${phantom.join(", ")} (code uses: ${[...code].join(", ")})`,
  );

  // SOFT (warn): a primary code model that is undocumented in the README. Kept
  // a warning so a legit internal-only model can't block CI — but surfaced.
  const undocumented = [...code].filter((m) => !readme.has(m));
  if (undocumented.length) {
    console.warn(`[docs-drift] code models not documented in README: ${undocumented.join(", ")}`);
  }
});

// The README HTTP-API table lists endpoints as `METHOD /path` in backticks.
function readmeEndpoints(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const re = /`(GET|POST|PUT|DELETE|PATCH)\s+(\/[a-zA-Z0-9/_.-]*)`/g;
  for (const m of README.matchAll(re)) out.push({ method: m[1]!, path: m[2]! });
  return out;
}

test("CHECK 1b — every endpoint documented in the README is a real Fastify route (no phantom endpoints)", () => {
  const documented = readmeEndpoints();
  assert.ok(documented.length >= 8, `expected the README API table to list endpoints, found ${documented.length}`);

  const phantom = documented.filter((e) => !app.hasRoute({ method: e.method as any, url: e.path }));
  assert.deepEqual(
    phantom.map((e) => `${e.method} ${e.path}`),
    [],
    `README documents endpoint(s) that are not registered routes: ${phantom.map((e) => `${e.method} ${e.path}`).join(", ")}`,
  );
});

test("CHECK 1b (warn) — undocumented real business routes are surfaced, not failed", async () => {
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  const businessPaths: string[] = Object.keys(res.json().paths);
  const documented = new Set(readmeEndpoints().map((e) => e.path));
  const undocumented = businessPaths.filter((p) => !documented.has(p));
  if (undocumented.length) {
    console.warn(`[docs-drift] real business routes not in the README API table: ${undocumented.join(", ")}`);
  }
  assert.ok(true); // warn-only direction — never fails the build
});

test("CHECK 1c — Alibaba runtime proof uses the canonical gallery/10 path everywhere", () => {
  const canonical = "demo/gallery/10-alibaba-runtime-proof.png";
  const stale = "demo/gallery/08-alibaba-runtime-proof.png";
  const manifest = readText("demo/SCREENSHOT_MANIFEST.md");
  const captureScript = readText("scripts/capture_submission_gallery.py");
  const videoBuilder = readText("demo/tools/build_caption_video.py");

  assert.ok(README.includes(canonical), `README must link the canonical Alibaba proof at ${canonical}`);
  assert.ok(manifest.includes(`\`${canonical}\``), "screenshot manifest must name the same canonical Alibaba proof");
  assert.match(captureScript, /"10-alibaba-runtime-proof\.png"/);
  assert.match(videoBuilder, /"10-alibaba-runtime-proof"/);
  assert.ok(!README.includes(stale), "README must not mislabel the Qwen-VL gallery/08 slot as Alibaba runtime proof");
  assert.ok(!manifest.includes(`\`${stale}\``), "screenshot manifest must not contain the stale Alibaba proof path");
  assert.doesNotMatch(captureScript, /"08-alibaba-runtime-proof\.png"/);
  assert.doesNotMatch(videoBuilder, /"08-alibaba-runtime-proof"/);
});

test("CHECK 1d — release-evidence docs match the executable strict/fallback contract", () => {
  const runbook = readText("demo/MEDIA_CAPTURE_RUNBOOK.md");
  const buildGuide = readText("demo/CAPTION_VIDEO_BUILD.md");
  const captureScript = readText("scripts/capture_submission_gallery.py");
  const videoBuilder = readText("demo/tools/build_caption_video.py");

  for (const doc of [runbook, buildGuide]) {
    assert.match(doc, /provider-truncation fallback/);
    assert.match(doc, /terminal/);
    assert.doesNotMatch(doc, /all three exact(?:-deploy| deploy)? markers/i);
  }
  assert.match(buildGuide, /MEMORYAGENT_DEPLOY_STATE_V1 status=LIVE_VERIFIED_READY runtime_sha=<FINAL_RUNTIME_SHA>/);
  assert.match(captureScript, /"exactDeploymentEvidenceMode"/);
  for (const field of ["invocationId", "commandId", "outputSha256", "outputBytes"]) {
    assert.ok(runbook.includes(`\`${field}\``), `capture runbook must document producer field ${field}`);
    assert.ok(captureScript.includes(`"${field}"`), `capture manifest must retain producer field ${field}`);
  }
  assert.match(runbook, /EXACT_APP_REUSE_OK app=memoryagent sha=<SHA> health=ok/);
  assert.match(runbook, /EXACT_DEPLOY_SUCCESS memory=<SHA> autopilot=<SHA>/);
  assert.match(captureScript, /service_workers="block"/);
  assert.match(captureScript, /route_web_socket/);
  assert.match(videoBuilder, /"exactDeployEvidenceMode"/);
});

test("CHECK 1e — canonical live-recall evidence stays bounded and wording-identical", () => {
  const captureScript = readText("scripts/capture_submission_gallery.py");
  const browserCapture = readText("scripts/capture_web.py");
  const judgeGuide = readText("docs/JUDGE-GUIDE.md");

  assert.equal(
    DEMO_TEMPLATES[0]?.q,
    DEMO_PRIMARY_RECALL_QUESTION,
    "the first Explorer chip must be the canonical recall question",
  );
  assert.equal(
    pythonConcatenatedString(captureScript, "CANONICAL_RECALL_QUESTION"),
    DEMO_PRIMARY_RECALL_QUESTION,
    "submission capture question drifted from the first Explorer chip",
  );
  assert.equal(
    pythonConcatenatedString(browserCapture, "CANONICAL_RECALL_QUESTION"),
    DEMO_PRIMARY_RECALL_QUESTION,
    "browser capture question drifted from the first Explorer chip",
  );
  assert.ok(
    judgeGuide.replace(/\s+/g, " ").includes(DEMO_PRIMARY_RECALL_QUESTION),
    "judge guide must show the canonical question verbatim",
  );
  const curlQuestion = [...judgeGuide.matchAll(/^QUESTION\+?='([^']*)'$/gm)].map((match) => match[1]).join("");
  assert.equal(curlQuestion, DEMO_PRIMARY_RECALL_QUESTION, "judge guide curl question drifted from the Explorer chip");
  assert.match(judgeGuide, /printf '[^']+"question"[^']+' "\$QUESTION"/);
  assert.match(judgeGuide, /"limit"\s*:\s*3/, "judge guide curl must reproduce the Explorer's bounded limit");
  assert.match(captureScript, /page\.locator\("#question"\)\.fill\(CANONICAL_RECALL_QUESTION\)/);
  assert.match(captureScript, /recall_request_body\.get\("limit"\) == 3/);
  assert.match(captureScript, /VALID_GROUNDING_RESULTS = frozenset\(\{\("passed", 1\), \("repaired", 2\)\}\)/);
  assert.match(captureScript, /type\(grounding\.get\("attempts"\)\) is int/);
  assert.match(captureScript, /grounding_result in VALID_GROUNDING_RESULTS/);

  const stalePhrase = "What did it really cost to employ the team?";
  const staleFiles: string[] = [];
  const walk = (directory: string, relativeDirectory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) walk(absolute, relative);
      else if (
        /\.(?:md|py|sh|ts|txt|json|ya?ml)$/i.test(entry.name)
        && readFileSync(absolute, "utf8").includes(stalePhrase)
      ) {
        staleFiles.push(relative);
      }
    }
  };
  for (const directory of ["docs", "scripts"]) walk(join(ROOT, directory), directory);
  assert.deepEqual(staleFiles, [], `old canonical recall wording remains in: ${staleFiles.join(", ")}`);
});

// ─── CHECK 2 — Mermaid diagram ↔ src/ modules (architecture conformance) ──────

function mermaidBlock(): string {
  const m = README.match(/```mermaid\r?\n([\s\S]*?)```/);
  assert.ok(m && m[1], "README must contain a ```mermaid architecture diagram");
  return m[1]!;
}

// Explicit, readable map: diagram node id → the code artifact it must denote.
// A node token like `EX["` uniquely anchors the declaration inside the mermaid
// fence (the plain-text pipeline block earlier in the README uses no such ids).
const DIAGRAM_MAP: Array<{ node: string; file: string; what: string }> = [
  { node: 'H["',   file: "src/server.ts",               what: "HTTP API routes" },
  { node: 'EX["',  file: "src/pipeline/extractor.ts",   what: "Extractor" },
  { node: 'CL["',  file: "src/pipeline/classifier.ts",  what: "Classifier" },
  { node: 'EL["',  file: "src/pipeline/event-linker.ts", what: "EventLinker" },
  { node: 'VA["',  file: "src/pipeline/validator.ts",   what: "Validator" },
  { node: 'PN["',  file: "src/pipeline/pnl.ts",         what: "P&L math" },
  { node: 'MT["',  file: "src/mcp/server.ts",           what: "MCP tools surface" },
  { node: 'SK["',  file: "src/skills/dispatcher.ts",    what: "SkillDispatcher" },
  { node: 'MA["',  file: "src/agents/memory-agent.ts",  what: "MemoryAgent (core)" },
  { node: 'DB["',  file: "src/memory/store.ts",         what: "pgvector store" },
  { node: 'VL["',  file: "src/pipeline/vision.ts",      what: "qwen-vl-max vision" },
  { node: 'EMB["', file: "src/memory/embeddings.ts",    what: "text-embedding-v4 embedder" },
  { node: 'LLM["', file: "src/agents/narrator.ts",      what: "qwen-plus narrator" },
];

test("CHECK 2 — every diagrammed component maps to a real src/ artifact (no orphan nodes)", () => {
  const diagram = mermaidBlock();
  for (const { node, file, what } of DIAGRAM_MAP) {
    assert.ok(diagram.includes(node), `diagram is missing the expected node ${node} (${what})`);
    let exists = true;
    try {
      readFileSync(join(ROOT, file));
    } catch {
      exists = false;
    }
    assert.ok(exists, `diagram node ${node} (${what}) has no code counterpart at ${file} (orphan)`);
  }
});

test("CHECK 2 (warn) — every agent in src/agents is represented in the diagram (missing)", () => {
  const diagram = mermaidBlock();
  const mappedFiles = new Set(DIAGRAM_MAP.filter((e) => diagram.includes(e.node)).map((e) => e.file));
  const agents = readdirSync(join(ROOT, "src", "agents"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/agents/${f}`);
  const missing = agents.filter((a) => !mappedFiles.has(a));
  if (missing.length) {
    console.warn(`[arch-drift] src/agents modules absent from the diagram: ${missing.join(", ")}`);
  }
  assert.ok(true); // warn-only direction
});

// ─── CHECK 3 — README metrics ↔ bench/golden.json (golden snapshot) ───────────

interface Golden {
  tolerance: { ratio: number; percent: number };
  metrics: {
    mrr_reranked_hybrid: number;
    ndcg5_reranked_hybrid: number;
    recall3_reranked_hybrid_pct: number;
    gold_figure_hit_pct: number;
    complete_euro_figure_traceability_pct: number;
  };
}

// Read (not import) the JSON so we sidestep resolveJsonModule/tsconfig.
const golden: Golden = JSON.parse(readText("bench/golden.json"));

// Parse MRR, nDCG@5 and Recall@3 from the SINGLE reranked-hybrid headline
// clause so all three share one source line — Recall@3 also appears earlier
// (hybrid-vs-dense, 93.3%); pinning to this clause guarantees we read 96.7%.
function parseHeadlineRetrieval(): { mrr: number; ndcg5: number; recall3: number } {
  const m = README.match(
    /MRR \*\*[\d.]+ → ([\d.]+)\*\*, nDCG@5 \*\*[\d.]+ → ([\d.]+)\*\*, Recall@3 \*\*[\d.]+% → ([\d.]+)%\*\*/,
  );
  assert.ok(m, "README must state the reranked-hybrid headline (MRR/nDCG@5/Recall@3) in one clause");
  return { mrr: Number(m![1]), ndcg5: Number(m![2]), recall3: Number(m![3]) };
}

function parseFigureMetrics(): { goldFigureHit: number; completeEuroTraceability: number } {
  const m = README.match(/gold EUR-token hit: ([\d.]+)% · complete EUR-labelled traceability: ([\d.]+)%/);
  assert.ok(m, "README must state both narrow objective EUR-token metrics");
  return { goldFigureHit: Number(m![1]), completeEuroTraceability: Number(m![2]) };
}

test("CHECK 3 — README headline metrics equal the pinned golden.json values (within tolerance)", () => {
  const { ratio, percent } = golden.tolerance;
  const g = golden.metrics;
  const rt = parseHeadlineRetrieval();
  const figures = parseFigureMetrics();

  const near = (a: number, b: number, tol: number, label: string) =>
    assert.ok(Math.abs(a - b) <= tol, `${label}: README ${a} drifted from golden ${b} (tol ±${tol})`);

  near(rt.mrr, g.mrr_reranked_hybrid, ratio, "MRR");
  near(rt.ndcg5, g.ndcg5_reranked_hybrid, ratio, "nDCG@5");
  near(rt.recall3, g.recall3_reranked_hybrid_pct, percent, "Recall@3");
  near(figures.goldFigureHit, g.gold_figure_hit_pct, percent, "gold-figure hit");
  near(figures.completeEuroTraceability, g.complete_euro_figure_traceability_pct, percent, "complete euro-figure traceability");
});

test("CHECK 1e — skill kind descriptions are generated from the complete enum", () => {
  const expected = `Memory kind: ${MEMORY_KINDS.join(" | ")}.`;
  for (const skill of SKILLS) {
    const kind = skill.parameters.properties.kind as { description?: string } | undefined;
    if (kind) assert.equal(kind.description, expected, `${skill.name} kind description drifted from MEMORY_KINDS`);
  }
});
