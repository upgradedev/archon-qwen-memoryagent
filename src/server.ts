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

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { defaultEmbedder, type Embedder } from "./memory/embeddings.js";
import { defaultNarrator, type Narrator } from "./agents/narrator.js";
import { defaultSemanticJudge, type SemanticJudge } from "./memory/semantic-consistency.js";
import { PgVectorStore, type MemoryKind, type MemoryStore } from "./memory/store.js";
import { defaultReranker, type Reranker } from "./memory/rerank.js";
import { MemoryAgent } from "./agents/memory-agent.js";
import { UI_HTML } from "./ui.js";
import type { PayrollEvent } from "./types.js";
import { ingestPipeline } from "./pipeline/pipeline.js";
import { aggregatePnl } from "./pipeline/pnl.js";
import type { RawDocument } from "./pipeline/models.js";
import { Extractor } from "./pipeline/extractor.js";
import { FakeExtractionClient } from "./pipeline/vision.js";
import { DEMO_DOCUMENTS, DEMO_CONTRADICTION, DEMO_COMPANY, DEMO_INVOICE_RECORD, DEMO_SALES, DEMO_SEMANTIC } from "./demo-data.js";
import {
  authenticateJudge,
  loadJudgeAuth,
  type JudgeAuthOptions,
  type JudgePrincipal,
} from "./server/auth.js";
import {
  consumeTwoTierQuota,
  InMemoryDailyQuotaBackend,
  PgDailyQuotaBackend,
  loadQwenQuotaPolicy,
  type DailyQuotaBackend,
} from "./server/quota.js";
import {
  companySchema,
  invoiceSchema,
  kindSchema,
  payrollEventSchema,
  periodSchema,
  questionSchema,
  rawDocumentSchema,
} from "./server/validation.js";

interface InvoiceIngest {
  type: "purchase" | "sales";
  company: string;
  period: string;
  date: string;
  currency: string;
  total: number;
  invoice_ref: string;
  vendor?: string;
  customer?: string;
  paid_amount?: number;
  status?: "paid" | "partial" | "unpaid" | "unknown";
  payment_date?: string;
}

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
  properties: {
    error: { type: "string" },
    requestId: { type: "string" },
    errorId: { type: "string" },
  },
} as const;

// Legacy standalone limiter retained for focused unit coverage. Runtime routes
// use the durable, atomic request-quota backend below. One accepted request is
// one unit (not an estimate of internal model-call fan-out). Two tiers reset at
// 00:00 UTC:
//
//   INGEST_DAILY_LIMIT         PER-IP cap (default 100). Generous headroom so a
//                              judge never hits 429 on their first ingest, while
//                              a single abusive client is still bounded.
//   INGEST_DAILY_LIMIT_GLOBAL  hard TOTAL cap across all IPs (default 500). The
//                              hard request ceiling — per-IP alone has none.
//
// A request must pass BOTH tiers. The default was raised from a global 10 to a
// per-IP 100 so the judging window is comfortable; the global backstop keeps
// total request volume bounded even under many distinct IPs. Per-IP bucketing is real in
// production because the server trusts the fronting proxy's X-Forwarded-For
// (see `trustProxy` below); where no proxy forwards it, every request shares one
// bucket and the behavior degrades safely to exactly the old single-cap semantics.
// Exported + pure for unit tests.
export const INGEST_DAILY_LIMIT = Number(process.env.INGEST_DAILY_LIMIT ?? 100);
export const INGEST_DAILY_LIMIT_GLOBAL = Number(process.env.INGEST_DAILY_LIMIT_GLOBAL ?? 500);

// Fastify defaults JSON bodies to ~1 MiB, while the documented vision route
// accepts one base64 image data URL up to 8,000,000 characters. Keep the
// aggregate request ceiling deliberately above that single-document contract,
// but bounded so a caller cannot make the process buffer an arbitrary payload.
// The extraction layer applies the stricter decoded-image/text limits after
// JSON parsing. Operators may tune this only inside a conservative range.
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const MAX_JSON_BODY_LIMIT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_HTTP_RATE_LIMIT_MAX = 300;
export const HTTP_RATE_LIMIT_WINDOW_MS = 60_000;

export function configuredJsonBodyLimit(raw = process.env.MAX_JSON_BODY_BYTES): number {
  if (raw == null || raw.trim() === "") return DEFAULT_JSON_BODY_LIMIT_BYTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 * 1024 || value > MAX_JSON_BODY_LIMIT_BYTES) {
    throw new Error("MAX_JSON_BODY_BYTES must be an integer from 1048576 to 20971520");
  }
  return value;
}

export function configuredHttpRateLimitMax(raw = process.env.HTTP_RATE_LIMIT_MAX): number {
  if (raw == null || raw.trim() === "") return DEFAULT_HTTP_RATE_LIMIT_MAX;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error("HTTP_RATE_LIMIT_MAX must be an integer from 1 to 100000");
  }
  return value;
}

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
  judge?: SemanticJudge;
  reranker?: Reranker;
  auth?: JudgeAuthOptions;
  quotaBackend?: DailyQuotaBackend;
  corsOrigins?: string[];
  trustProxy?: boolean | number | string | string[];
  bodyLimitBytes?: number;
  requestRateLimitMax?: number;
}

export async function buildServer(deps: ServerDeps = {}) {
  // `trustProxy` — the live box terminates TLS at a fronting reverse proxy (the
  // public HTTPS URL fronts the container's plain :9000), so the client address
  // arrives in X-Forwarded-For. Trusting it makes `req.ip` the real client IP,
  // which is what the per-IP ingest limiter buckets on. With no proxy (local
  // dev), req.ip is just the socket address — the limiter still works, per host.
  const app = Fastify({
    logger: true,
    trustProxy: deps.trustProxy ?? configuredTrustProxy(),
    bodyLimit: deps.bodyLimitBytes ?? configuredJsonBodyLimit(),
    // Every mutation schema is a contract, not a sanitizing suggestion. Reject
    // unknown tenant/reviewer/control fields instead of Ajv silently deleting
    // them before authorization and domain validation see the request.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // Coarse per-client abuse protection for the complete HTTP surface, including
  // readiness/authenticated read routes that touch PostgreSQL. Expensive Qwen-backed
  // operations additionally retain the durable two-tier daily quota below. The live
  // deployment is a single application replica; multi-replica operators can provide
  // a shared @fastify/rate-limit store without weakening the durable Qwen quota.
  await app.register(rateLimit, {
    global: true,
    max: deps.requestRateLimitMax ?? configuredHttpRateLimitMax(),
    timeWindow: HTTP_RATE_LIMIT_WINDOW_MS,
    cache: 10_000,
    skipOnError: false,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: "request rate limit exceeded",
      retryAfter: context.after,
    }),
  });

  // CORS — lets a browser dashboard (e.g. the OSS static site) call this API
  // cross-origin. Default reflects any origin (a demo memory service with no
  // per-user secrets); pin via CORS_ORIGIN="https://host" (comma-separated).
  const allowedOrigins = deps.corsOrigins ?? parseCsv(process.env.CORS_ORIGIN);
  await app.register(cors, {
    origin(origin, callback) {
      // Requests without Origin are same-origin/non-browser clients. Cross-origin
      // browser access is opt-in and exact; an empty allow-list emits no ACAO.
      callback(null, !origin || allowedOrigins.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-api-key"],
    maxAge: 600,
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; " +
        "img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    );
    if (process.env.NODE_ENV === "production") {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
  });

  // A single, typed error envelope for anything that throws past a route handler.
  // Server-side failures are deliberately opaque: the public response contains a
  // stable generic message plus correlation ids, while the actual exception is
  // emitted only to the structured server log. Client errors keep their useful
  // 4xx validation message. The ids let operators find the detailed log event
  // without exposing DB URLs, provider payloads, file paths, or stack frames.
  const sendServiceUnavailable = (
    req: FastifyRequest,
    reply: FastifyReply,
    err: unknown,
  ) => {
    const requestId = String(req.id);
    const errorId = randomUUID();
    req.log.error({ err, requestId, errorId }, "request failed");
    return reply.code(503).send({
      error: "service temporarily unavailable",
      requestId,
      errorId,
    });
  };

  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message || "invalid request" });
    }
    return sendServiceUnavailable(req, reply, err);
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
      components: {
        securitySchemes: {
          JudgeBearer: { type: "http", scheme: "bearer", bearerFormat: "API key" },
          JudgeApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
        },
      },
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
  const judge = deps.judge ?? defaultSemanticJudge();
  const reranker = deps.reranker ?? defaultReranker();
  const store = deps.store ?? new PgVectorStore();
  const agent = new MemoryAgent(embedder, store, narrator, judge, reranker);
  const auth = loadJudgeAuth(deps.auth);
  const quota = deps.quotaBackend ??
    (process.env.DATABASE_URL && !deps.store ? new PgDailyQuotaBackend() : new InMemoryDailyQuotaBackend());
  const quotaPolicy = loadQwenQuotaPolicy();
  const principals = new WeakMap<object, JudgePrincipal>();
  const fakeQwen =
    embedder.modelId.startsWith("fake-") ||
    narrator.modelId.startsWith("fake-") ||
    reranker.modelId.startsWith("fake-");
  const allowFakeQwen = /^(1|true|yes|on)$/i.test(process.env.ALLOW_FAKE_QWEN ?? "");

  const providerGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (process.env.NODE_ENV === "production" && fakeQwen && !allowFakeQwen) {
      return sendServiceUnavailable(
        req,
        reply,
        new Error("Qwen provider is not configured; fake models are disabled in production"),
      );
    }
  };

  const judgeGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const result = authenticateJudge(req.headers, auth);
    if (!result.ok) {
      if (result.statusCode >= 500) {
        return sendServiceUnavailable(req, reply, new Error(result.error));
      }
      return reply.code(result.statusCode).send({ error: result.error });
    }
    principals.set(req, result.principal);
  };
  const protectedSecurity: readonly Record<string, readonly string[]>[] = [
    { JudgeBearer: [] },
    { JudgeApiKey: [] },
  ];
  const protectedPrincipal = (req: FastifyRequest): JudgePrincipal => {
    const principal = principals.get(req);
    if (!principal) throw Object.assign(new Error("judge authentication required"), { statusCode: 401 });
    return principal;
  };
  const readPrincipal = (req: FastifyRequest): JudgePrincipal => {
    const hasCredential = Boolean(req.headers.authorization || req.headers["x-api-key"]);
    if (!hasCredential) return { tenantId: auth.publicTenantId, role: "judge" };
    const result = authenticateJudge(req.headers, auth);
    if (!result.ok) throw Object.assign(new Error(result.error), { statusCode: result.statusCode });
    return result.principal;
  };
  const scopedAgent = (tenantId: string) =>
    new MemoryAgent(embedder, store, narrator, judge, reranker, tenantId);
  const quotaSubject = (req: FastifyRequest, principal: JudgePrincipal) =>
    auth.required ? principal.tenantId : req.ip;
  const enforceQuota = async (
    req: FastifyRequest,
    reply: FastifyReply,
    bucket: "recall" | "ingest" | "semantic",
    subject: string,
  ): Promise<boolean> => {
    const limits =
      bucket === "recall"
        ? [quotaPolicy.recallPerSubject, quotaPolicy.recallGlobal]
        : bucket === "semantic"
          ? [quotaPolicy.semanticPerSubject, quotaPolicy.semanticGlobal]
          : [quotaPolicy.ingestPerSubject, quotaPolicy.ingestGlobal];
    const result = await consumeTwoTierQuota(quota, bucket, subject || req.ip, limits[0]!, limits[1]!);
    reply.header("x-ratelimit-limit", result.limit);
    reply.header("x-ratelimit-remaining", result.remaining);
    reply.header("x-ratelimit-reset", result.resetAt);
    if (result.ok) return true;
    reply.code(429).send({ error: `Daily ${bucket} limit of ${result.limit} reached`, resetAt: result.resetAt });
    return false;
  };

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
    "/ready",
    {
      schema: {
        summary: "Dependency readiness probe",
        description: "Checks the memory database and required production authentication configuration.",
        tags: ["health"],
        response: { 200: looseObject, 503: errorResponse },
      },
    },
    async () => {
      await store.ready();
      if (auth.required && auth.apiKeys.length === 0) {
        throw new Error("judge authentication is not configured");
      }
      if (fakeQwen) throw new Error("Qwen provider is not configured");
      return {
        status: "ready",
        checks: {
          database: "ok",
          qwen: embedder.modelId.startsWith("fake-") ? "offline" : "configured",
          judgeAuth: auth.required ? "configured" : "disabled-local-only",
        },
      };
    },
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
          401: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (req) => {
      const principal = readPrincipal(req);
      return { count: await store.count(undefined, principal.tenantId) };
    },
  );

  app.post<{ Body: { event: PayrollEvent } }>(
    "/ingest",
    {
      schema: {
        summary: "Ingest a fused financial event",
        description: "Writes recallable memories for a fused financial event and returns their ids.",
        tags: ["memory"],
        security: protectedSecurity,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["event"],
          properties: {
            event: payrollEventSchema,
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
          401: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
      preHandler: [judgeGuard, providerGuard],
    },
    async (req, reply) => {
      const event = req.body?.event;
      if (!event || !event.event_id) {
        return reply.code(400).send({ error: "body.event (a PayrollEvent) is required" });
      }
      const principal = protectedPrincipal(req);
      if (!(await enforceQuota(req, reply, "ingest", quotaSubject(req, principal)))) return;
      const ids = await agent.ingestEvent(event, { tenantId: principal.tenantId });
      return { written: ids.length, ids };
    },
  );

  // Strict first-class invoice ingestion. Unlike demo seeding, this is an
  // authenticated producer contract with a stable logical idempotency key:
  // exact retries return the original memory id, while a changed payload for
  // the same invoice identity is rejected by the store with 409.
  app.post<{ Body: { invoice: InvoiceIngest } }>(
    "/ingest/invoice",
    {
      schema: {
        summary: "Ingest a purchase or sales invoice",
        description:
          "Writes one currency-explicit invoice memory. Exact retries are idempotent; " +
          "a different payload for the same tenant/type/period/counterparty/reference conflicts.",
        tags: ["memory"],
        security: protectedSecurity,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["invoice"],
          properties: { invoice: invoiceSchema },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["written", "id"],
            properties: { written: { type: "integer" }, id: { type: "string" } },
          },
          400: errorResponse,
          401: errorResponse,
          409: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
      preHandler: [judgeGuard, providerGuard],
    },
    async (req, reply) => {
      const invoice = req.body?.invoice;
      if (!invoice) return reply.code(400).send({ error: "body.invoice is required" });
      const validationError = validateInvoice(invoice);
      if (validationError) return reply.code(400).send({ error: validationError });

      const principal = protectedPrincipal(req);
      if (!(await enforceQuota(req, reply, "ingest", quotaSubject(req, principal)))) return;

      const company = normalizedInvoiceText(invoice.company);
      const reference = normalizedInvoiceText(invoice.invoice_ref);
      const party = normalizedInvoiceText(invoice.type === "purchase" ? invoice.vendor! : invoice.customer!);
      const role = invoice.type === "purchase" ? "vendor" : "customer";
      const metadata: Record<string, unknown> = {
        type: invoice.type,
        record: `invoice:${invoice.type}:${normalizedInvoiceKey(party)}:${normalizedInvoiceKey(reference)}`,
        currency: invoice.currency,
        total: invoice.total,
        invoice_date: invoice.date,
        invoice_number: reference,
        [role]: party,
        ...(invoice.type === "purchase" ? { vendor_ref: reference } : {}),
        ...(invoice.paid_amount === undefined ? {} : { paid_amount: invoice.paid_amount }),
        ...(invoice.status === undefined ? {} : { payment_status: invoice.status }),
        ...(invoice.payment_date === undefined ? {} : { payment_date: invoice.payment_date }),
      };
      const content =
        `${invoice.type === "purchase" ? "Purchase" : "Sales"} invoice ${reference} ` +
        `${invoice.type === "purchase" ? "from" : "to"} ${party} for ${invoice.currency} ` +
        `${invoice.total.toFixed(2)}, dated ${invoice.date}, recorded by ${company}.`;
      const logicalIdentity = JSON.stringify([
        invoice.type,
        normalizedInvoiceKey(company),
        invoice.period,
        normalizedInvoiceKey(party),
        normalizedInvoiceKey(reference),
      ]);
      const idempotencyKey = `invoice:${createHash("sha256").update(logicalIdentity).digest("hex")}`;
      const id = await agent.remember("invoice", content, {
        tenantId: principal.tenantId,
        company,
        period: invoice.period,
        sourceRef: reference,
        metadata,
        idempotencyKey,
        importance: 0.7,
      });
      return { written: 1, id };
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
        security: protectedSecurity,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["documents"],
          properties: {
            documents: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              description:
                "Raw documents (image data-URL or text) to extract and fuse. The whole JSON request " +
                "is also bounded by MAX_JSON_BODY_BYTES (10 MiB by default).",
              items: rawDocumentSchema,
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
          401: errorResponse,
          503: errorResponse,
        },
      },
      preHandler: [judgeGuard, providerGuard],
    },
    async (req, reply) => {
      const documents = req.body?.documents;
      if (!Array.isArray(documents) || documents.length === 0) {
        return reply.code(400).send({ error: "body.documents (a non-empty array) is required" });
      }
      const principal = protectedPrincipal(req);
      if (!(await enforceQuota(req, reply, "ingest", quotaSubject(req, principal)))) return;
      const out = await ingestPipeline(scopedAgent(principal.tenantId), documents);
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
          additionalProperties: false,
          properties: {
            company: companySchema,
            period: periodSchema,
          },
        },
        response: { 200: looseObject, 401: errorResponse, 503: errorResponse },
      },
    },
    async (req) => {
      const { company, period } = req.query ?? {};
      const principal = readPrincipal(req);
      const memories = await store.listForAudit({ tenantId: principal.tenantId, company, period });
      return aggregatePnl(memories);
    },
  );

  // Browse the agent's memories — a small, recent slice for the dashboard's
  // records view (kind · company · snippet · timestamp). Read-only; reuses the
  // existing audit read (no core change).
  app.get<{ Querystring: { company?: string; kind?: MemoryKind; limit?: string } }>(
    "/memory/list",
    {
      schema: {
        summary: "List recent memories",
        description: "Returns a recent slice of the agent's memories (id, kind, company, period, snippet, createdAt) for a browse view.",
        tags: ["memory"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            company: companySchema,
            kind: kindSchema,
            // Query-string values are strings on the wire. Body coercion is
            // disabled globally so a JSON string can never become confirm=true;
            // validate this one numeric query explicitly, then parse below.
            limit: {
              type: "string",
              pattern: "^(?:[1-9]|[1-9][0-9]|100)$",
              description: "Max rows as an integer string (default 20, range 1-100).",
            },
          },
        },
        response: { 200: looseObject, 401: errorResponse, 503: errorResponse },
      },
    },
    async (req) => {
      const { company, kind, limit } = req.query ?? {};
      const principal = readPrincipal(req);
      const cap = Math.min(Math.max(Number(limit ?? 20) || 20, 1), 100);
      const rows = await store.listForAudit({ tenantId: principal.tenantId, company, kind });
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

  // One-click demo seed — feeds a fixed sample through the SAME pipeline
  // (with the deterministic Fake extractor; embeddings are still quota-bounded),
  // plus one deliberate contradiction so the self-audit has something to find.
  // Universal financial terms only. Lets a first-time visitor see recall +
  // self-audit + P&L on an otherwise empty store.
  app.post(
    "/demo/seed",
    {
      schema: {
        summary: "Seed the demo memories",
        description: "Idempotently seeds only the fixed built-in public demo dataset. It accepts no caller-controlled memory content.",
        tags: ["memory"],
        response: { 200: looseObject, 429: errorResponse, 503: errorResponse },
      },
      preHandler: providerGuard,
    },
    async (req, reply) => {
      // Idempotent: if the demo company is already seeded, do NOT re-write (a
      // judge clicking "Run demo" twice must not double the P&L or pile up
      // duplicate contradictions). Return the already-seeded signal instead.
      const existing = await store.listForAudit({
        tenantId: auth.publicTenantId,
        company: DEMO_COMPANY,
        kind: "payroll_event",
      });
      if (existing.length > 0) {
        return { seeded: 0, alreadySeeded: true, company: DEMO_COMPANY, events: 0 };
      }
      if (!(await enforceQuota(req, reply, "ingest", `public:${req.ip}`))) return;
      const demoAgent = scopedAgent(auth.publicTenantId);
      const fakeExtractor = new Extractor(new FakeExtractionClient());
      const out = await ingestPipeline(demoAgent, DEMO_DOCUMENTS, { extractor: fakeExtractor });
      // Seed the cross-session contradiction (two writes, same record, different amount).
      for (const [index, c] of DEMO_CONTRADICTION.entries()) {
        await demoAgent.remember("document", c.content, {
          company: DEMO_COMPANY,
          period: "2026-05",
          sourceRef: DEMO_INVOICE_RECORD,
          metadata: { record: DEMO_INVOICE_RECORD, amount: c.amount },
          idempotencyKey: `demo:contradiction:${index}`,
        });
      }
      // Seed sales invoices (revenue)
      for (const [index, s] of DEMO_SALES.entries()) {
        await demoAgent.remember("invoice", s.content, {
          company: DEMO_COMPANY,
          period: "2026-05",
          metadata: s.metadata,
          idempotencyKey: `demo:sale:${index}`,
        });
      }
      // Seed the MEANING-level contradiction (opposite prose, no shared attribute)
      // so POST /consistency/semantic has a real finding to surface.
      for (const [index, s] of DEMO_SEMANTIC.entries()) {
        await demoAgent.remember("insight", s.content, {
          company: DEMO_COMPANY,
          period: "2026-05",
          idempotencyKey: `demo:semantic:${index}`,
        });
      }
      return {
        seeded:
          out.memoryIds.length +
          DEMO_CONTRADICTION.length +
          DEMO_SALES.length +
          DEMO_SEMANTIC.length,
        company: DEMO_COMPANY,
        events: out.events.length,
      };
    },
  );

  app.post<{
    Body: { question: string; company?: string; kind?: MemoryKind; limit?: number; hybrid?: boolean; rerank?: boolean };
  }>(
    "/recall",
    {
      schema: {
        summary: "Recall a grounded, cited answer",
        description:
          "Hybrid dense + lexical candidate recall, production Qwen re-ranking with bounded timeout/fallback, " +
          "then a grounded Qwen-narrated answer. The response identifies the retrieval/reranker provenance.",
        tags: ["memory"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["question"],
          properties: {
            question: questionSchema,
            company: companySchema,
            kind: kindSchema,
            limit: { type: "integer", minimum: 1, maximum: 20, description: "Optional cap on recalled memories." },
            hybrid: { type: "boolean", description: "Hybrid dense+lexical retrieval (on by default)." },
            rerank: { type: "boolean", description: "Qwen cross-encoder re-ranking (on by default)." },
          },
        },
        response: { 200: looseObject, 400: errorResponse, 401: errorResponse, 429: errorResponse, 503: errorResponse },
      },
      preHandler: providerGuard,
    },
    async (req, reply) => {
      const { question, company, kind, limit, hybrid, rerank } = req.body ?? {};
      if (!question?.trim()) {
        return reply.code(400).send({ error: "body.question is required" });
      }
      const principal = readPrincipal(req);
      const subject = req.headers.authorization || req.headers["x-api-key"] ? principal.tenantId : req.ip;
      if (!(await enforceQuota(req, reply, "recall", String(subject)))) return;
      const result = await agent.recallAnswer(question.trim(), {
        tenantId: principal.tenantId,
        company,
        kind,
        limit,
        hybrid,
        rerank,
      });
      return result;
    },
  );

  app.post<{
    Body: {
      memoryId: string;
      outcome: "correct" | "incorrect";
      correctedFact?: string;
      feedbackId?: string;
    };
  }>(
    "/feedback",
    {
      schema: {
        summary: "Apply human feedback to a recalled memory",
        description:
          "Authenticated learning loop: protects a correct memory or atomically supersedes an incorrect " +
          "memory with a high-importance corrected fact. Returns idempotent before/after provenance.",
        tags: ["memory"],
        security: protectedSecurity,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["memoryId", "outcome"],
          properties: {
            memoryId: { type: "string", format: "uuid" },
            outcome: { type: "string", enum: ["correct", "incorrect"] },
            correctedFact: { type: "string", minLength: 1, maxLength: 8_000 },
            feedbackId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]+$" },
          },
        },
        response: {
          200: looseObject,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
      preHandler: judgeGuard,
    },
    async (req, reply) => {
      const principal = protectedPrincipal(req);
      const { memoryId, outcome, correctedFact, feedbackId } = req.body;
      if (outcome === "incorrect" && !correctedFact?.trim()) {
        return reply.code(400).send({ error: "incorrect feedback requires correctedFact" });
      }
      if (outcome === "incorrect") {
        const unavailable = await providerGuard(req, reply);
        if (unavailable) return;
        if (!(await enforceQuota(req, reply, "ingest", quotaSubject(req, principal)))) return;
      }
      return scopedAgent(principal.tenantId).applyFeedback(memoryId, outcome, correctedFact, {
        tenantId: principal.tenantId,
        feedbackId,
      });
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
          additionalProperties: false,
          properties: {
            company: companySchema,
            period: periodSchema,
            kind: kindSchema,
          },
        },
        response: { 200: looseObject, 401: errorResponse, 503: errorResponse },
      },
    },
    async (req) => {
      const { company, period, kind } = req.body ?? {};
      const principal = readPrincipal(req);
      const report = await agent.auditConsistency({ tenantId: principal.tenantId, company, period, kind });
      return report;
    },
  );

  // Semantic self-audit: catch memories that OPPOSE each other in MEANING while
  // sharing no comparable metadata key (e.g. "vendor always pays on time" vs
  // "vendor is chronically late") — the class the rule-based /consistency audit is
  // blind to. Embeds each memory (same recall path), keeps same-subject pairs by
  // cosine, and asks the judge (qwen-plus online, a deterministic polarity
  // heuristic offline) whether they contradict. Read-only; each finding carries a
  // resolution recommending which side to trust.
  app.post<{
    Body: {
      company?: string;
      period?: string;
      kind?: MemoryKind;
      similarityThreshold?: number;
    };
  }>(
    "/consistency/semantic",
    {
      schema: {
        summary: "Semantic self-audit of stored memories",
        description:
          "Read-only meaning-aware audit: flags memories that directly contradict each other in meaning " +
          "(opposite facts about the same subject) without sharing a comparable metadata field — each with a " +
          "resolution recommending which side to trust. Complements POST /consistency. Never mutates memory.",
        tags: ["audit"],
        security: protectedSecurity,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            company: companySchema,
            period: periodSchema,
            kind: kindSchema,
            similarityThreshold: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Override the subject-similarity gate (0..1).",
            },
          },
        },
        response: { 200: looseObject, 401: errorResponse, 429: errorResponse, 503: errorResponse },
      },
      preHandler: [judgeGuard, providerGuard],
    },
    async (req, reply) => {
      const { company, period, kind, similarityThreshold } = req.body ?? {};
      const principal = protectedPrincipal(req);
      if (!(await enforceQuota(req, reply, "semantic", quotaSubject(req, principal)))) return;
      const report = await agent.auditSemanticConsistency(
        { tenantId: principal.tenantId, company, period, kind },
        similarityThreshold != null ? { similarityThreshold } : {},
      );
      return report;
    },
  );

  // Memory lifecycle: collapse near-duplicate memories (consolidation).
  app.post<{ Body: { company?: string; threshold?: number; confirm?: boolean } }>(
    "/consolidate",
    {
      schema: {
        summary: "Consolidate near-duplicate memories",
        description: "Authenticated tenant-scoped consolidation. Defaults to a dry-run; confirm=true is required to mutate memory.",
        tags: ["lifecycle"],
        security: protectedSecurity,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            company: companySchema,
            threshold: { type: "number", minimum: 0.8, maximum: 1, description: "Similarity threshold for collapsing." },
            confirm: { type: "boolean", description: "Must be true to apply the previewed consolidation plan." },
          },
        },
        response: { 200: looseObject, 401: errorResponse, 503: errorResponse },
      },
      preHandler: judgeGuard,
    },
    async (req) => {
      const { company, threshold, confirm } = req.body ?? {};
      const principal = protectedPrincipal(req);
      return agent.consolidate({
        tenantId: principal.tenantId,
        company,
        threshold,
        dryRun: confirm !== true,
      });
    },
  );

  // Memory lifecycle: forget superseded (and optionally stale, low-importance) memories.
  app.post<{
    Body: { company?: string; deleteSuperseded?: boolean; olderThanDays?: number; maxImportance?: number; confirm?: boolean };
  }>(
    "/forget",
    {
      schema: {
        summary: "Forget superseded / stale memories",
        description:
          "Authenticated tenant-scoped retention operation. Defaults to a dry-run; confirm=true is required to delete.",
        tags: ["lifecycle"],
        security: protectedSecurity,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            company: companySchema,
            deleteSuperseded: { type: "boolean", description: "Drop memories marked superseded." },
            olderThanDays: { type: "integer", minimum: 1, maximum: 3650, description: "Drop low-importance memories older than N days." },
            maxImportance: { type: "number", minimum: 0, maximum: 1, description: "Only prune memories at or below this importance." },
            confirm: { type: "boolean", description: "Must be true to apply the previewed deletion plan." },
          },
        },
        response: { 200: looseObject, 401: errorResponse, 503: errorResponse },
      },
      preHandler: judgeGuard,
    },
    async (req) => {
      const { company, deleteSuperseded, olderThanDays, maxImportance, confirm } = req.body ?? {};
      const principal = protectedPrincipal(req);
      return agent.forget(
        { deleteSuperseded, olderThanDays, maxImportance },
        company,
        principal.tenantId,
        confirm !== true,
      );
    },
  );

  return app;
}

function parseCsv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function configuredTrustProxy(): boolean | number | string | string[] {
  const addresses = parseCsv(process.env.TRUST_PROXY_ADDRESSES);
  if (addresses.length > 0) return addresses;
  if (process.env.TRUST_PROXY_HOPS) {
    const hops = Number(process.env.TRUST_PROXY_HOPS);
    if (Number.isInteger(hops) && hops >= 1 && hops <= 3) return hops;
    throw new Error("TRUST_PROXY_HOPS must be an integer from 1 to 3");
  }
  // Never trust X-Forwarded-For directly by default. The reverse-proxy deployment
  // must explicitly configure the known proxy CIDR or bounded hop count.
  return false;
}

function validateInvoice(invoice: InvoiceIngest): string | null {
  const company = normalizedInvoiceText(invoice.company);
  const reference = normalizedInvoiceText(invoice.invoice_ref);
  const vendor = invoice.vendor == null ? "" : normalizedInvoiceText(invoice.vendor);
  const customer = invoice.customer == null ? "" : normalizedInvoiceText(invoice.customer);
  if (!company) return "invoice.company must not be blank";
  if (!reference) return "invoice.invoice_ref must not be blank";
  if (invoice.type === "purchase") {
    if (!vendor) return "purchase invoices require vendor";
    if (invoice.customer !== undefined) return "purchase invoices must not include customer";
  } else {
    if (!customer) return "sales invoices require customer";
    if (invoice.vendor !== undefined) return "sales invoices must not include vendor";
  }
  if (!validIsoDate(invoice.date)) return "invoice.date must be a real YYYY-MM-DD date";
  if (invoice.period !== invoice.date.slice(0, 7)) return "invoice.period must match invoice.date";
  if (invoice.payment_date != null && !validIsoDate(invoice.payment_date)) {
    return "invoice.payment_date must be a real YYYY-MM-DD date";
  }
  if (invoice.payment_date != null && invoice.payment_date < invoice.date) {
    return "invoice.payment_date cannot be before invoice.date";
  }
  if (!Number.isFinite(invoice.total) || invoice.total <= 0) return "invoice.total must be greater than zero";
  if (invoice.paid_amount != null) {
    if (!Number.isFinite(invoice.paid_amount) || invoice.paid_amount < 0 || invoice.paid_amount > invoice.total) {
      return "invoice.paid_amount must be between zero and invoice.total";
    }
  }
  if (invoice.status === "paid" && invoice.paid_amount != null && invoice.paid_amount + 0.01 < invoice.total) {
    return "paid invoices cannot have a partial paid_amount";
  }
  if (invoice.status === "partial" &&
      (invoice.paid_amount == null || invoice.paid_amount <= 0 || invoice.paid_amount + 0.01 >= invoice.total)) {
    return "partial invoices require paid_amount between zero and invoice.total";
  }
  if (invoice.status === "unpaid" && (invoice.paid_amount != null && invoice.paid_amount !== 0)) {
    return "unpaid invoices cannot have a positive paid_amount";
  }
  if (invoice.status === "unpaid" && invoice.payment_date != null) {
    return "unpaid invoices cannot have payment_date";
  }
  return null;
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizedInvoiceText(value: string): string {
  return value.normalize("NFKC").trim();
}

function normalizedInvoiceKey(value: string): string {
  return normalizedInvoiceText(value).toLocaleLowerCase("en-US");
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
