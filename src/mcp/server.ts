#!/usr/bin/env tsx
// Archon MemoryAgent — Model Context Protocol (MCP) server.
//
// A real MCP server (official @modelcontextprotocol/sdk) that exposes the agent's
// persistent memory as MCP tools, so any MCP client — Claude Desktop, an IDE, or
// another agent — can recall, write, audit, and count memories over the standard
// protocol. It WRAPS the injectable domain logic (MemoryAgent → embedder + store
// + narrator) through the shared SkillDispatcher: the exact code the HTTP routes
// run. No memory logic lives here — this is protocol wiring only.
//
// Tools exposed (see src/skills/schemas.ts for the shared schemas):
//   recall_memory  — grounded, cited answer from persistent memory (+ self-audit)
//   ingest_memory  — embed & write a single fact
//   audit_memory   — read-only cross-session consistency self-audit
//   memory_count   — how many memories are held
//
// Transports:
//   stdio (default)            — the standard MCP client transport (Claude Desktop).
//   Streamable HTTP (MCP_TRANSPORT=http) — network transport for remote clients,
//                                intended for the redeployed Alibaba Cloud host.
//
// Runs fully offline with deterministic Fakes + an in-memory store outside
// production. Production requires both its configured Qwen provider and durable
// pgvector database and fails closed when either dependency is absent.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SkillDispatcher, defaultSkillDispatcher } from "../skills/dispatcher.js";
import { mcpTools, callTool } from "./tools.js";
import {
  DEFAULT_JUDGE_TENANT,
  DEFAULT_PUBLIC_TENANT,
  authenticateJudge,
  loadJudgeAuth,
  normalizeTenantId,
  type JudgeAuthOptions,
} from "../server/auth.js";
import {
  consumeTwoTierQuota,
  InMemoryDailyQuotaBackend,
  PgDailyQuotaBackend,
  type DailyQuotaBackend,
} from "../server/quota.js";
import { hasQwenCreds } from "../qwen/client.js";
import { PROCESS_QWEN_ADMISSION, type QwenAdmission } from "../server/admission.js";
import { sanitizedOperationalFailure } from "../server/error-sanitization.js";
import {
  createStdioCallExecutor,
  mcpRequestWorkUnits,
  type McpCallExecutor,
} from "./stdio-policy.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

// Build the MCP Server over a SkillDispatcher and register the tools/list and
// tools/call handlers. Returns the configured, UNCONNECTED server so a caller
// (or a test using InMemoryTransport) can connect any transport to it. All the
// request logic delegates to the pure adapter in ./tools.ts.
export function buildMcpServer(
  dispatcher: SkillDispatcher = defaultSkillDispatcher(),
  execute: McpCallExecutor = callTool,
): Server {
  const server = new Server(
    { name: "archon-memoryagent", version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    return execute(dispatcher, name, (args ?? {}) as Record<string, unknown>);
  });

  return server;
}

/* c8 ignore start — transport bootstrap glue (stdio / HTTP / process entry).
   The protocol behaviour is covered in tests via InMemoryTransport against
   buildMcpServer(); this block is pure I/O wiring exercised only by a live client. */

// Start the server on the stdio transport (the primary MCP client transport).
// NOTE: stdio speaks JSON-RPC on stdout — never write logs to stdout here.
export async function startStdio(): Promise<void> {
  const tenantId = mcpStdioTenantId();
  // Construct the policy before provider/store defaults. Production and
  // serverless misconfiguration therefore fail closed before opening a protocol
  // transport or accepting any tool request.
  const execute = createStdioCallExecutor({ tenantId });
  const server = buildMcpServer(defaultSkillDispatcher(tenantId), execute);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("archon-memoryagent MCP server running on stdio");
}

// Optional Streamable HTTP transport for remote MCP clients. Stateless: each POST
// gets a fresh Server + transport, so no session store is needed. Intended for
// the redeployed Alibaba Cloud host (MCP_TRANSPORT=http, MCP_HTTP_PORT).
export interface McpHttpOptions {
  auth?: JudgeAuthOptions;
  maxBodyBytes?: number;
  dispatcherFactory?: (tenantId: string) => SkillDispatcher;
  quotaBackend?: DailyQuotaBackend;
  qwenAdmission?: QwenAdmission;
}

export function createMcpHttpServer(options: McpHttpOptions = {}): HttpServer {
  // Real provider spend must never be guarded by a fresh per-process counter.
  // Production also requires the durable store even when a caller injects a
  // dispatcher: injectable test seams are not a production bypass.
  if (!process.env.DATABASE_URL && (process.env.NODE_ENV === "production" || hasQwenCreds())) {
    throw new Error("DATABASE_URL is required for durable remote MCP memory and quotas");
  }
  const envAuth: JudgeAuthOptions = process.env.MCP_API_KEY
    ? {
        apiKeys: { [process.env.MCP_TENANT_ID ?? process.env.JUDGE_TENANT_ID ?? DEFAULT_JUDGE_TENANT]: process.env.MCP_API_KEY },
      }
    : {};
  // Remote MCP is always fail-closed, even in local NODE_ENV. stdio remains the
  // trusted local transport and does not pass through this boundary.
  const auth = loadJudgeAuth({ ...envAuth, ...options.auth, required: true });
  const maxBodyBytes = boundedNumber(
    options.maxBodyBytes ?? process.env.MCP_MAX_BODY_BYTES,
    262_144,
    1_024,
    1_048_576,
  );
  const dispatcherFactory = options.dispatcherFactory ?? defaultSkillDispatcher;
  const quota = options.quotaBackend ??
    (process.env.DATABASE_URL ? new PgDailyQuotaBackend() : new InMemoryDailyQuotaBackend());
  const qwenAdmission = options.qwenAdmission ?? PROCESS_QWEN_ADMISSION;
  const tenantLimit = boundedEnv("MCP_DAILY_LIMIT", 500);
  const globalLimit = boundedEnv("MCP_DAILY_LIMIT_GLOBAL", 2_000);

  return createHttpServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    setMcpSecurityHeaders(res);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/mcp") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return json(res, 405, { error: "method not allowed" });
    }

    const result = authenticateJudge(req.headers, auth);
    if (!result.ok) {
      if (result.statusCode >= 500) {
        return mcpServiceUnavailable(res, requestId, new Error(result.error));
      }
      return json(res, result.statusCode, { error: result.error });
    }
    let releaseAdmission: (() => void) | null = null;
    try {
      const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (contentType !== "application/json") {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        return json(res, 413, { error: "MCP request body too large" });
      }
      // Reject malformed/oversized payloads before reserving a shared Qwen
      // budget unit; otherwise cheap invalid requests could drain judge quota.
      const body = await readJsonBody(req, maxBodyBytes);
      // One HTTP debit must never authorize an arbitrarily large JSON-RPC batch.
      // This endpoint is deliberately single-message; each tool call is sent and
      // atomically metered as its own request.
      if (Array.isArray(body)) {
        return json(res, 400, { error: "JSON-RPC batch requests are not supported" });
      }

      // Use exactly the same provider-work classifier as stdio. Protocol setup,
      // tools/list, count, and rule-only audit are cheap and must neither occupy
      // Qwen admission nor consume a model budget unit.
      const workUnits = mcpWorkUnits(body);
      if (workUnits > 0) {
        const allowFake = /^(1|true|yes|on)$/i.test(process.env.ALLOW_FAKE_QWEN ?? "");
        if (process.env.NODE_ENV === "production" && !hasQwenCreds() && !allowFake) {
          return mcpServiceUnavailable(res, requestId, new Error("Qwen provider is not configured"));
        }
        releaseAdmission = qwenAdmission.tryAcquire("judge");
        if (!releaseAdmission) {
          res.setHeader("retry-after", "2");
          return json(res, 503, { error: "model capacity temporarily unavailable", retryAfterSeconds: 2 });
        }

        const budget = await consumeTwoTierQuota(
          quota,
          "mcp",
          result.principal.tenantId,
          tenantLimit,
          globalLimit,
          "judge",
          workUnits,
        );
        res.setHeader("x-ratelimit-limit", budget.limit);
        res.setHeader("x-ratelimit-remaining", budget.remaining);
        res.setHeader("x-ratelimit-reset", budget.resetAt);
        if (!budget.ok) return json(res, 429, { error: "daily MCP model-work limit reached", resetAt: budget.resetAt });
      }
      const server = buildMcpServer(dispatcherFactory(result.principal.tenantId));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof McpHttpError) {
        return json(res, err.statusCode, { error: err.message });
      }
      return mcpServiceUnavailable(res, requestId, err);
    } finally {
      releaseAdmission?.();
    }
  });
}

export async function startHttp(port: number = mcpHttpPort(), host: string = mcpHttpHost()): Promise<void> {
  const httpServer = createMcpHttpServer();
  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  console.error(`archon-memoryagent MCP server running on Streamable HTTP ${host}:${port}/mcp`);
}

export function mcpWorkUnits(body: unknown): number {
  return mcpRequestWorkUnits(body);
}

class McpHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

async function readJsonBody(req: import("node:http").IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) throw new McpHttpError(413, "MCP request body too large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) throw new McpHttpError(400, "MCP request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new McpHttpError(400, "invalid MCP JSON request");
  }
}

function setMcpSecurityHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("cache-control", "no-store");
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function mcpServiceUnavailable(
  res: import("node:http").ServerResponse,
  requestId: string,
  err: unknown,
): void {
  const errorId = randomUUID();
  // Keep both the client envelope and operator log free of exception messages,
  // stacks, SQL, credentials, and payload data. The correlation id is sufficient
  // to join this event to provider/database observability at the source.
  console.error("MCP request failed", {
    requestId,
    errorId,
    errorName: sanitizedOperationalFailure("mcp_request", err).errorName,
  });
  json(res, 503, { error: "service temporarily unavailable", requestId, errorId });
}

function boundedEnv(name: string, fallback: number): number {
  return boundedNumber(process.env[name], fallback, 1, 1_000_000);
}

export function mcpHttpPort(raw: string | number | undefined = process.env.MCP_HTTP_PORT): number {
  return boundedNumber(raw, 9_100, 1, 65_535);
}

export function mcpHttpHost(raw: string | undefined = process.env.MCP_HTTP_HOST): string {
  const host = (raw ?? "127.0.0.1").trim();
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) {
    throw new Error("MCP_HTTP_HOST must be a plain hostname or IP address");
  }
  return host;
}

export function mcpStdioTenantId(
  raw: string | undefined = process.env.MCP_STDIO_TENANT_ID ?? process.env.JUDGE_TENANT_ID,
  publicTenant: string = process.env.PUBLIC_TENANT_ID ?? DEFAULT_PUBLIC_TENANT,
  production: boolean = process.env.NODE_ENV === "production",
): string {
  if (production && !raw?.trim()) {
    throw new Error("production MCP stdio requires MCP_STDIO_TENANT_ID or JUDGE_TENANT_ID");
  }
  const fallback = production ? DEFAULT_JUDGE_TENANT : "_local_mcp";
  const tenant = normalizeTenantId(raw ?? fallback);
  if (tenant === normalizeTenantId(publicTenant)) {
    throw new Error("writable MCP stdio tenant must differ from the public tenant");
  }
  return tenant;
}

function boundedNumber(
  raw: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

// Process entry — pick the transport from MCP_TRANSPORT (default stdio).
async function main(): Promise<void> {
  if ((process.env.MCP_TRANSPORT ?? "stdio").toLowerCase() === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    console.error("MemoryAgent MCP startup failed", sanitizedOperationalFailure("mcp_startup", err));
    process.exit(1);
  });
}
/* c8 ignore stop */
