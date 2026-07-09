// HTTP backend for the Archon MemoryAgent.
//
// This is the service that runs ON ALIBABA CLOUD (Function Compute custom
// container, or ECS/Container Service) and is the target of the deployment proof.
// It is a thin HTTP shell around the same MemoryAgent used everywhere else:
//
//   GET  /health         — liveness probe (no DB / no key needed)
//   GET  /memory/count   — how many memories the agent currently holds
//   POST /ingest         — { event: PayrollEvent }  → writes memories, returns ids
//   POST /recall         — { question, company?, kind?, limit? } → grounded, cited answer
//                          (+ a best-effort self-audit over the recalled memories)
//   POST /consistency    — { company?, period?, kind? } → cross-session memory audit
//                          (contradictions + dangling references; read-only)
//
// Embedder + Narrator auto-select real Qwen when DASHSCOPE_API_KEY is set, the
// deterministic Fakes otherwise. The store is pgvector (DATABASE_URL). Function
// Compute listens on the container's CAPort — default 9000, overridable via PORT.

import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cors from "@fastify/cors";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { defaultEmbedder, type Embedder } from "./memory/embeddings.js";
import { defaultNarrator, type Narrator } from "./agents/narrator.js";
import { PgVectorStore, type MemoryKind, type MemoryStore } from "./memory/store.js";
import { MemoryAgent } from "./agents/memory-agent.js";
import { UI_HTML } from "./ui.js";
import type { PayrollEvent } from "./types.js";
import { ingestPipeline } from "./pipeline/pipeline.js";
import { aggregatePnl } from "./pipeline/pnl.js";
import type { RawDocument } from "./pipeline/models.js";
import { Extractor } from "./pipeline/extractor.js";
import { FakeExtractionClient } from "./pipeline/vision.js";
import { DEMO_DOCUMENTS, DEMO_CONTRADICTION, DEMO_COMPANY, DEMO_INVOICE_RECORD, DEMO_SALES } from "./demo-data.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

// Documented (not enforced) memory-kind values — mirrors the store's MemoryKind
// union. Kept as a description hint rather than an ajv `enum` so the pass-through
// filter keeps its exact current behavior (no new pre-handler rejection).
const KIND_HINT = "Optional memory-kind pre-filter (document | payroll_event | validation | insight).";

// Response bodies for the DB-backed handlers are intentionally left permissive
// (`additionalProperties: true`, no declared property types). Fastify serializes
// responses against their schema and strips undeclared fields, so a tight schema
// would silently drop parts of a recall answer or an audit report. These stay
// open so nothing is stripped, while still documenting a 200 in /docs.
const looseObject = { type: "object", additionalProperties: true } as const;
const errorResponse = {
  type: "object",
  additionalProperties: true,
  properties: { error: { type: "string" } },
} as const;

// Per-UTC-day rate limit for the document-ingestion route. The live demo is
// intentionally OPEN (no login) so judges can test it end to end; the only path
// that spends Qwen vision-model calls is /ingest/documents, so it is metered to
// protect the API budget. Two tiers, both reset at 00:00 UTC:
//
//   INGEST_DAILY_LIMIT         PER-IP cap (default 100). Generous headroom so a
//                              judge never hits 429 on their first ingest, while
//                              a single abusive client is still bounded.
//   INGEST_DAILY_LIMIT_GLOBAL  hard TOTAL cap across all IPs (default 500). The
//                              real Qwen-spend ceiling — per-IP alone has none.
//
// A request must pass BOTH tiers. The default was raised from a global 10 to a
// per-IP 100 so the judging window is comfortable; the global backstop keeps
// total spend bounded even under many distinct IPs. Per-IP bucketing is real in
// production because the server trusts the fronting proxy's X-Forwarded-For
// (see `trustProxy` below); where no proxy forwards it, every request shares one
// bucket and the behavior degrades safely to exactly the old single-cap semantics.
// Exported + pure for unit tests.
export const INGEST_DAILY_LIMIT = Number(process.env.INGEST_DAILY_LIMIT ?? 100);
export const INGEST_DAILY_LIMIT_GLOBAL = Number(process.env.INGEST_DAILY_LIMIT_GLOBAL ?? 500);

// A keyed per-UTC-day counter. `take(key)` buckets independently per key (the
// caller passes the client IP for per-IP metering; the default key "global"
// gives a single shared counter). Pure + injectable clock for unit tests.
export function makeDailyLimiter(limit: number, now: () => Date = () => new Date()) {
  const buckets = new Map<string, { day: string; count: number }>();
  return function take(key: string = "global"): { ok: boolean; remaining: number; limit: number } {
    const today = now().toISOString().slice(0, 10); // UTC calendar day
    let state = buckets.get(key);
    if (!state || state.day !== today) {
      state = { day: today, count: 0 };
      buckets.set(key, state);
    }
    if (state.count >= limit) return { ok: false, remaining: 0, limit };
    state.count += 1;
    return { ok: true, remaining: limit - state.count, limit };
  };
}

// Injectable dependencies. Production passes nothing → the real pgvector store +
// auto-selected Qwen/Fake embedder + narrator. Tests inject an InMemoryStore +
// FakeEmbedder + FakeNarrator so the DB-backed routes (/demo/seed, /recall,
// /memory/list, /pnl) run end-to-end, offline, with no database and no key.
export interface ServerDeps {
  store?: MemoryStore;
  embedder?: Embedder;
  narrator?: Narrator;
}

export async function buildServer(deps: ServerDeps = {}) {
  // `trustProxy` — the live box terminates TLS at a fronting reverse proxy (the
  // public HTTPS URL fronts the container's plain :9000), so the client address
  // arrives in X-Forwarded-For. Trusting it makes `req.ip` the real client IP,
  // which is what the per-IP ingest limiter buckets on. With no proxy (local
  // dev), req.ip is just the socket address — the limiter still works, per host.
  const app = Fastify({ logger: true, trustProxy: true });

  // CORS — lets a browser dashboard (e.g. the OSS static site) call this API
  // cross-origin. Default reflects any origin (a demo memory service with no
  // per-user secrets); pin via CORS_ORIGIN="https://host" (comma-separated).
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
      : true,
  });

  // A single, typed error envelope for anything that throws past a route handler:
  // never leak a raw stack — always `{ error: <message> }`. Server-side faults
  // (e.g. the memory store or embedder being unreachable) become a structured
  // 503, so a caller gets a clear "temporarily unavailable" instead of a hang or
  // an opaque crash. Client errors keep their own 4xx status (Fastify's schema
  // validation and the explicit `reply.code(400)` guards below are unaffected —
  // those never throw). The narrator-outage path degrades gracefully in
  // recallAnswer() and never reaches here.
  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    req.log.error(err);
    const status =
      typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 503;
    reply.code(status).send({ error: err.message || "service temporarily unavailable" });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Archon MemoryAgent API",
        description:
          "HTTP API for the Archon MemoryAgent — an agent with persistent, queryable, " +
          "cross-session memory built on Qwen (Alibaba Cloud Model Studio / DashScope) " +
          "with a pgvector memory layer. Ingest fused financial events, recall grounded " +
          "and cited answers by meaning, and run the read-only self-audit that flags " +
          "cross-session contradictions and dangling references.",
        version: pkg.version,
      },
      tags: [
        { name: "health", description: "Liveness and memory-size probes" },
        { name: "memory", description: "Write memories and recall grounded answers" },
        { name: "audit", description: "Read-only self-audit of stored memories" },
        { name: "lifecycle", description: "Consolidate duplicates and forget stale memories" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });

  // Serve the raw OpenAPI 3 spec at a stable path (hidden from the rendered spec).
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // The memory explorer UI — a single static page served by this same backend.
  // A company filter + question box drive POST /recall from the browser, same-
  // origin, and render the grounded answer + citations + a /memory/count badge.
  // Hidden from the OpenAPI spec (it is a page, not an API route). Both `/` and
  // `/ui` serve it.
  const serveUi = async (_req: unknown, reply: import("fastify").FastifyReply) =>
    reply.type("text/html").send(UI_HTML);
  app.get("/", { schema: { hide: true } }, serveUi);
  app.get("/ui", { schema: { hide: true } }, serveUi);

  const embedder = deps.embedder ?? defaultEmbedder();
  const narrator = deps.narrator ?? defaultNarrator();
  const store = deps.store ?? new PgVectorStore();
  const agent = new MemoryAgent(embedder, store, narrator);
  // Per-IP tier (keyed by req.ip) + a global backstop tier (shared "global" key).
  const ingestBudget = makeDailyLimiter(INGEST_DAILY_LIMIT);
  const ingestBudgetGlobal = makeDailyLimiter(INGEST_DAILY_LIMIT_GLOBAL);

  app.get(
    "/health",
    {
      schema: {
        summary: "Liveness probe",
        description: "Reports service liveness and the live embedder/narrator model ids + embedding dimension. No DB, no key.",
        tags: ["health"],
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              status: { type: "string" },
              embedder: { type: "string" },
              narrator: { type: "string" },
              embedDim: { type: "integer" },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok",
      embedder: embedder.modelId,
      narrator: narrator.modelId,
      embedDim: embedder.dim,
    }),
  );

  app.get(
    "/memory/count",
    {
      schema: {
        summary: "Memory count",
        description: "How many memories the agent currently holds.",
        tags: ["health"],
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { count: { type: "integer" } },
          },
        },
      },
    },
    async () => ({ count: await store.count() }),
  );

  app.post<{ Body: { event: PayrollEvent } }>(
    "/ingest",
    {
      schema: {
        summary: "Ingest a fused financial event",
        description: "Writes recallable memories for a fused financial event and returns their ids.",
        tags: ["memory"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            event: {
              type: "object",
              additionalProperties: true,
              description: "A fused financial event. Must carry an event_id.",
              properties: { event_id: { type: "string" }, company: { type: "string" } },
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              written: { type: "integer" },
              ids: { type: "array", items: { type: "string" } },
            },
          },
          400: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const event = req.body?.event;
      if (!event || !event.event_id) {
        return reply.code(400).send({ error: "body.event (a PayrollEvent) is required" });
      }
      const ids = await agent.ingestEvent(event);
      return { written: ids.length, ids };
    },
  );

  // Document-ingestion pipeline — the productized upstream that FEEDS memory.
  // Takes a period's raw financial documents, extracts each with Qwen (vision /
  // text), fuses the payroll triplet into one accurate event, computes the P&L,
  // runs the R1–R4 cross-document validation, and WRITES the fused event +
  // findings into the SAME memory via the unchanged MemoryAgent. Returns the
  // events, per-event P&L, validation, and the ids of every memory written.
  app.post<{ Body: { documents: RawDocument[] } }>(
    "/ingest/documents",
    {
      schema: {
        summary: "Ingest raw documents through the extraction pipeline",
        description:
          "Runs the document-ingestion pipeline (Extractor → Classifier → EventLinker → " +
          "Validator → P&L) over a period's raw financial documents and writes the fused " +
          "events + validation findings into the agent's memory. The memories the " +
          "MemoryAgent then recalls are produced here.",
        tags: ["memory"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            documents: {
              type: "array",
              description: "Raw documents (image data-URL or text) to extract and fuse.",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  doc_id: { type: "string" },
                  filename: { type: "string" },
                  source_kind: { type: "string", description: "image | pdf | text" },
                  content: { type: "string" },
                  company: { type: "string" },
                  period: { type: "string", description: "YYYY-MM" },
                },
              },
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              events: { type: "integer" },
              written: { type: "integer" },
              results: { type: "array", items: looseObject },
              memoryIds: { type: "array", items: { type: "string" } },
            },
          },
          400: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const documents = req.body?.documents;
      if (!Array.isArray(documents) || documents.length === 0) {
        return reply.code(400).send({ error: "body.documents (a non-empty array) is required" });
      }
      // Budget guard — protects the shared Qwen API key on the open demo. The
      // per-IP tier bounds a single client; the global tier bounds total spend.
      // The request must pass both. Check per-IP first so a blocked client never
      // consumes a slot from the shared global backstop.
      const perIp = ingestBudget(req.ip);
      const budget = perIp.ok ? ingestBudgetGlobal() : perIp;
      if (!budget.ok) {
        return reply
          .code(429)
          .send({ error: `Daily ingest limit of ${budget.limit} reached. Resets at 00:00 UTC. Recall + self-audit remain open.` });
      }
      const out = await ingestPipeline(agent, documents);
      return {
        events: out.events.length,
        written: out.memoryIds.length,
        results: out.events,
        memoryIds: out.memoryIds,
      };
    },
  );

  // P&L view over the pipeline-generated memories the agent holds. Aggregates the
  // fused event-summary memories (employer cost, cash-out, off-bank cost gap,
  // per-company) — the supporting context for the memory headline. Read-only.
  app.get<{ Querystring: { company?: string; period?: string } }>(
    "/pnl",
    {
      schema: {
        summary: "P&L over stored memories",
        description:
          "Aggregates the fused payroll-event memories into a payroll-cost P&L: employer " +
          "cost (the accurate expense), cash-out (what left the bank), and the off-bank " +
          "gap between them, broken down by company. Computed over the memories the pipeline fed.",
        tags: ["memory"],
        querystring: {
          type: "object",
          additionalProperties: true,
          properties: {
            company: { type: "string", description: "Optional company filter." },
            period: { type: "string", description: "Optional period filter (YYYY-MM)." },
          },
        },
        response: { 200: looseObject },
      },
    },
    async (req) => {
      const { company, period } = req.query ?? {};
      const memories = await store.listForAudit({ company, period });
      return aggregatePnl(memories);
    },
  );

  // Browse the agent's memories — a small, recent slice for the dashboard's
  // records view (kind · company · snippet · timestamp). Read-only; reuses the
  // existing audit read (no core change).
  app.get<{ Querystring: { company?: string; kind?: MemoryKind; limit?: number } }>(
    "/memory/list",
    {
      schema: {
        summary: "List recent memories",
        description: "Returns a recent slice of the agent's memories (id, kind, company, period, snippet, createdAt) for a browse view.",
        tags: ["memory"],
        querystring: {
          type: "object",
          additionalProperties: true,
          properties: {
            company: { type: "string", description: "Optional company filter." },
            kind: { type: "string", description: KIND_HINT },
            limit: { type: "integer", description: "Max rows (default 20, capped at 100)." },
          },
        },
        response: { 200: looseObject },
      },
    },
    async (req) => {
      const { company, kind, limit } = req.query ?? {};
      const cap = Math.min(Math.max(Number(limit ?? 20) || 20, 1), 100);
      const rows = await store.listForAudit({ company, kind });
      const items = [...rows]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, cap)
        .map((m) => ({
          id: m.id,
          kind: m.kind,
          company: m.company,
          period: m.period,
          snippet: m.content.length > 160 ? m.content.slice(0, 157) + "…" : m.content,
          createdAt: m.createdAt,
        }));
      return { count: items.length, items };
    },
  );

  // One-click demo seed — feeds a realistic sample through the SAME pipeline
  // (with the deterministic Fake extractor: free, no Qwen call, not rate-limited),
  // plus one deliberate contradiction so the self-audit has something to find.
  // Universal financial terms only. Lets a first-time visitor see recall +
  // self-audit + P&L on an otherwise empty store.
  app.post(
    "/demo/seed",
    {
      schema: {
        summary: "Seed the demo memories",
        description: "Runs a built-in sample document set through the pipeline (Fake extractor — free, unmetered) and seeds one contradiction, so the memory explorer has data to recall and self-audit.",
        tags: ["memory"],
        response: { 200: looseObject },
      },
    },
    async () => {
      // Idempotent: if the demo company is already seeded, do NOT re-write (a
      // judge clicking "Run demo" twice must not double the P&L or pile up
      // duplicate contradictions). Return the already-seeded signal instead.
      const existing = await store.listForAudit({ company: DEMO_COMPANY, kind: "payroll_event" });
      if (existing.length > 0) {
        return { seeded: 0, alreadySeeded: true, company: DEMO_COMPANY, events: 0 };
      }
      const fakeExtractor = new Extractor(new FakeExtractionClient());
      const out = await ingestPipeline(agent, DEMO_DOCUMENTS, { extractor: fakeExtractor });
      // Seed the cross-session contradiction (two writes, same record, different amount).
      for (const c of DEMO_CONTRADICTION) {
        await agent.remember("document", c.content, {
          company: DEMO_COMPANY,
          period: "2026-05",
          sourceRef: DEMO_INVOICE_RECORD,
          metadata: { record: DEMO_INVOICE_RECORD, amount: c.amount },
        });
      }
      // Seed sales invoices (revenue)
      for (const s of DEMO_SALES) {
        await agent.remember("invoice", s.content, {
          company: DEMO_COMPANY,
          period: "2026-05",
          metadata: s.metadata,
        });
      }
      return {
        seeded: out.memoryIds.length + DEMO_CONTRADICTION.length + DEMO_SALES.length,
        company: DEMO_COMPANY,
        events: out.events.length,
      };
    },
  );

  app.post<{
    Body: { question: string; company?: string; kind?: MemoryKind; limit?: number; hybrid?: boolean };
  }>(
    "/recall",
    {
      schema: {
        summary: "Recall a grounded, cited answer",
        description:
          "Semantic recall over the agent's persistent memory (hybrid dense + lexical by default), " +
          "then a Qwen-narrated answer that cites the memories it used, plus a best-effort self-audit " +
          "over the recalled memories.",
        tags: ["memory"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            question: { type: "string", description: "The natural-language question to answer from memory." },
            company: { type: "string", description: "Optional company pre-filter." },
            kind: { type: "string", description: KIND_HINT },
            limit: { type: "integer", description: "Optional cap on recalled memories." },
            hybrid: { type: "boolean", description: "Hybrid dense+lexical retrieval (on by default)." },
          },
        },
        response: { 200: looseObject, 400: errorResponse },
      },
    },
    async (req, reply) => {
      const { question, company, kind, limit, hybrid } = req.body ?? {};
      if (!question) {
        return reply.code(400).send({ error: "body.question is required" });
      }
      const result = await agent.recallAnswer(question, { company, kind, limit, hybrid });
      return result;
    },
  );

  // Self-auditing memory: scan stored memories for cross-session CONTRADICTIONS
  // (two write events disagree on a record's value) and dangling references
  // (a memory points at a record the agent never stored). Read-only, no schema
  // change — the innovation headline: memory that audits itself.
  app.post<{
    Body: { company?: string; period?: string; kind?: MemoryKind };
  }>(
    "/consistency",
    {
      schema: {
        summary: "Self-audit stored memories",
        description:
          "Read-only cross-session audit: flags contradictions (same record + attribute, different value " +
          "across write events) — each with a resolution recommending which value to trust — and dangling " +
          "references (a memory points at a record no memory stores). Never mutates memory.",
        tags: ["audit"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            company: { type: "string", description: "Optional company scope." },
            period: { type: "string", description: "Optional period scope." },
            kind: { type: "string", description: KIND_HINT },
          },
        },
        response: { 200: looseObject },
      },
    },
    async (req) => {
      const { company, period, kind } = req.body ?? {};
      const report = await agent.auditConsistency({ company, period, kind });
      return report;
    },
  );

  // Memory lifecycle: collapse near-duplicate memories (consolidation).
  app.post<{ Body: { company?: string; threshold?: number } }>(
    "/consolidate",
    {
      schema: {
        summary: "Consolidate near-duplicate memories",
        description: "Collapses near-duplicate memories (re-ingested facts) into one canonical memory.",
        tags: ["lifecycle"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            company: { type: "string", description: "Optional company scope." },
            threshold: { type: "number", description: "Optional similarity threshold for collapsing." },
          },
        },
        response: { 200: looseObject },
      },
    },
    async (req) => {
      const { company, threshold } = req.body ?? {};
      return agent.consolidate({ company, threshold });
    },
  );

  // Memory lifecycle: forget superseded (and optionally stale, low-importance) memories.
  app.post<{
    Body: { company?: string; deleteSuperseded?: boolean; olderThanDays?: number; maxImportance?: number };
  }>(
    "/forget",
    {
      schema: {
        summary: "Forget superseded / stale memories",
        description:
          "Prunes superseded and (optionally) stale low-importance memories while protecting high-importance insights.",
        tags: ["lifecycle"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            company: { type: "string", description: "Optional company scope." },
            deleteSuperseded: { type: "boolean", description: "Drop memories marked superseded." },
            olderThanDays: { type: "integer", description: "Drop low-importance memories older than N days." },
            maxImportance: { type: "number", description: "Only prune memories at or below this importance." },
          },
        },
        response: { 200: looseObject },
      },
    },
    async (req) => {
      const { company, deleteSuperseded, olderThanDays, maxImportance } = req.body ?? {};
      return agent.forget({ deleteSuperseded, olderThanDays, maxImportance }, company);
    },
  );

  return app;
}

// Only listen when run directly (not when imported by a test). pathToFileURL
// normalizes the path→URL form correctly on every OS (Windows uses file:///C:/…).
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 9000);
  buildServer()
    .then((app) => app.listen({ host: "0.0.0.0", port }))
    .then((addr) => console.log(`archon-qwen-memoryagent listening on ${addr}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
