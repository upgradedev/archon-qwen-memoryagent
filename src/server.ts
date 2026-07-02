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
//
// Embedder + Narrator auto-select real Qwen when DASHSCOPE_API_KEY is set, the
// deterministic Fakes otherwise. The store is pgvector (DATABASE_URL). Function
// Compute listens on the container's CAPort — default 9000, overridable via PORT.

import Fastify from "fastify";
import { pathToFileURL } from "node:url";
import { defaultEmbedder } from "./memory/embeddings.js";
import { defaultNarrator } from "./agents/narrator.js";
import { PgVectorStore, type MemoryKind } from "./memory/store.js";
import { MemoryAgent } from "./agents/memory-agent.js";
import type { PayrollEvent } from "./types.js";

export function buildServer() {
  const app = Fastify({ logger: true });

  const embedder = defaultEmbedder();
  const narrator = defaultNarrator();
  const store = new PgVectorStore();
  const agent = new MemoryAgent(embedder, store, narrator);

  app.get("/health", async () => ({
    status: "ok",
    embedder: embedder.modelId,
    narrator: narrator.modelId,
    embedDim: embedder.dim,
  }));

  app.get("/memory/count", async () => ({ count: await store.count() }));

  app.post<{ Body: { event: PayrollEvent } }>("/ingest", async (req, reply) => {
    const event = req.body?.event;
    if (!event || !event.event_id) {
      return reply.code(400).send({ error: "body.event (a PayrollEvent) is required" });
    }
    const ids = await agent.ingestEvent(event);
    return { written: ids.length, ids };
  });

  app.post<{
    Body: { question: string; company?: string; kind?: MemoryKind; limit?: number; hybrid?: boolean };
  }>("/recall", async (req, reply) => {
    const { question, company, kind, limit, hybrid } = req.body ?? {};
    if (!question) {
      return reply.code(400).send({ error: "body.question is required" });
    }
    const result = await agent.recallAnswer(question, { company, kind, limit, hybrid });
    return result;
  });

  // Memory lifecycle: collapse near-duplicate memories (consolidation).
  app.post<{ Body: { company?: string; threshold?: number } }>("/consolidate", async (req) => {
    const { company, threshold } = req.body ?? {};
    return agent.consolidate({ company, threshold });
  });

  // Memory lifecycle: forget superseded (and optionally stale, low-importance) memories.
  app.post<{
    Body: { company?: string; deleteSuperseded?: boolean; olderThanDays?: number; maxImportance?: number };
  }>("/forget", async (req) => {
    const { company, deleteSuperseded, olderThanDays, maxImportance } = req.body ?? {};
    return agent.forget({ deleteSuperseded, olderThanDays, maxImportance }, company);
  });

  return app;
}

// Only listen when run directly (not when imported by a test). pathToFileURL
// normalizes the path→URL form correctly on every OS (Windows uses file:///C:/…).
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 9000);
  buildServer()
    .listen({ host: "0.0.0.0", port })
    .then((addr) => console.log(`archon-qwen-memoryagent listening on ${addr}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
