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
import { defaultEmbedder } from "./memory/embeddings.js";
import { defaultNarrator } from "./agents/narrator.js";
import { PgVectorStore, type MemoryKind } from "./memory/store.js";
import { MemoryAgent } from "./agents/memory-agent.js";
import { UI_HTML } from "./ui.js";
import type { PayrollEvent } from "./types.js";

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

export async function buildServer() {
  const app = Fastify({ logger: true });

  // CORS — lets a browser dashboard (e.g. the OSS static site) call this API
  // cross-origin. Default reflects any origin (a demo memory service with no
  // per-user secrets); pin via CORS_ORIGIN="https://host" (comma-separated).
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
      : true,
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

  const embedder = defaultEmbedder();
  const narrator = defaultNarrator();
  const store = new PgVectorStore();
  const agent = new MemoryAgent(embedder, store, narrator);

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
