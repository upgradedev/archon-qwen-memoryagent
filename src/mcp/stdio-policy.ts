// Security and spend boundary for the trusted-local MCP stdio transport.
//
// Stdio has no HTTP principal to authenticate, so the operator-selected tenant is
// its subject. Provider-backed calls share the process admission pool and the
// PostgreSQL-backed `mcp:judge:*` daily quota used by authenticated remote MCP.
// Cheap database-only tools remain available without spending a model unit.

import { randomUUID } from "node:crypto";
import { validateSkillCall, type SkillDispatcher } from "../skills/dispatcher.js";
import { callTool, type McpToolResult } from "./tools.js";
import {
  consumeTwoTierQuota,
  InMemoryDailyQuotaBackend,
  PgDailyQuotaBackend,
  type DailyQuotaBackend,
} from "../server/quota.js";
import { PROCESS_QWEN_ADMISSION, type QwenAdmission } from "../server/admission.js";
import { hasQwenCreds } from "../qwen/client.js";
import { DEFAULT_MAX_PAIRS } from "../memory/semantic-consistency.js";
import { sanitizedOperationalFailure } from "../server/error-sanitization.js";

export type McpCallExecutor = (
  dispatcher: SkillDispatcher,
  name: string,
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

export interface StdioRuntime {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  qwenConfigured: boolean;
  explicitlyEnabled: boolean;
  serverless: boolean;
}

export interface StdioPolicyOptions {
  tenantId: string;
  quotaBackend?: DailyQuotaBackend;
  qwenAdmission?: QwenAdmission;
  perSubjectLimit?: number;
  globalLimit?: number;
  maxResultBytes?: number;
  runtime?: StdioRuntime;
  execute?: McpCallExecutor;
  operationalLogger?: (event: StdioOperationalEvent) => void;
}

export interface StdioOperationalEvent {
  errorId: string;
  operation: "quota" | "tool" | "result";
  errorName: string;
}

// Recall can perform four distinct logical provider operations: query embedding,
// listwise rerank, answer narration, and one bounded grounding-repair narration.
// Transport-level SDK retries are an upstream resilience detail, not quota units.
export const MCP_RECALL_WORK_UNITS = 4;

/**
 * Build the executor installed only on the stdio MCP server.
 *
 * Real-Qwen stdio is never allowed to fall back to a per-process quota: it needs
 * DATABASE_URL even outside production. Production additionally needs an explicit
 * opt-in, while serverless runtimes reject stdio entirely and must use authenticated
 * Streamable HTTP instead.
 */
export function createStdioCallExecutor(options: StdioPolicyOptions): McpCallExecutor {
  const runtime = options.runtime ?? currentStdioRuntime();
  assertStdioRuntime(runtime);

  const quota = options.quotaBackend ??
    (runtime.databaseUrl ? new PgDailyQuotaBackend() : new InMemoryDailyQuotaBackend());
  const admission = options.qwenAdmission ?? PROCESS_QWEN_ADMISSION;
  const perSubjectLimit = boundedNumber(
    options.perSubjectLimit ?? process.env.MCP_DAILY_LIMIT,
    500,
    1,
    1_000_000,
  );
  const globalLimit = boundedNumber(
    options.globalLimit ?? process.env.MCP_DAILY_LIMIT_GLOBAL,
    2_000,
    1,
    1_000_000,
  );
  const maxResultBytes = boundedNumber(
    options.maxResultBytes ?? process.env.MCP_STDIO_MAX_RESULT_BYTES,
    262_144,
    1_024,
    1_048_576,
  );
  const execute = options.execute ?? callTool;
  const logOperational = options.operationalLogger ?? defaultOperationalLogger;

  return async (dispatcher, name, args) => {
    const workUnits = mcpProviderWorkUnits(name, args);
    let release: (() => void) | null = null;
    try {
      if (workUnits > 0) {
        release = admission.tryAcquire("judge");
        if (!release) return toolError("model capacity temporarily unavailable; retry shortly");

        let budget;
        try {
          budget = await consumeTwoTierQuota(
            quota,
            "mcp",
            options.tenantId,
            perSubjectLimit,
            globalLimit,
            "judge",
            workUnits,
          );
        } catch (err) {
          return operationalError("quota", err, logOperational);
        }
        if (!budget.ok) {
          return toolError(`daily MCP model budget reached; retry after ${budget.resetAt}`);
        }
      }

      let result: McpToolResult;
      try {
        result = await execute(dispatcher, name, args);
      } catch (err) {
        return operationalError("tool", err, logOperational);
      }
      try {
        return boundedTextResult(result, maxResultBytes);
      } catch (err) {
        return operationalError("result", err, logOperational);
      }
    } finally {
      release?.();
    }
  };
}

/**
 * Validate once through the dispatcher's canonical contract, then classify work.
 * Invalid calls and database-only calls are zero so they cannot drain model quota.
 */
export function mcpProviderWorkUnits(name: string, args: Record<string, unknown> = {}): number {
  try {
    const call = validateSkillCall(name, args);
    switch (call.name) {
      case "recall_memory":
        return MCP_RECALL_WORK_UNITS;
      case "ingest_memory":
        return 1;
      case "audit_memory":
        return call.args.semantic === true ? DEFAULT_MAX_PAIRS : 0;
      case "memory_count":
        return 0;
    }
  } catch {
    return 0;
  }
}

/** Parse a JSON-RPC request through the same classifier used by stdio calls. */
export function mcpRequestWorkUnits(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  const rpc = body as { method?: unknown; params?: unknown };
  if (rpc.method !== "tools/call" || !rpc.params || typeof rpc.params !== "object" || Array.isArray(rpc.params)) {
    return 0;
  }
  const params = rpc.params as { name?: unknown; arguments?: unknown };
  if (typeof params.name !== "string") return 0;
  const args = params.arguments;
  return mcpProviderWorkUnits(
    params.name,
    args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {},
  );
}

export function currentStdioRuntime(): StdioRuntime {
  return {
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    qwenConfigured: hasQwenCreds(),
    explicitlyEnabled: truthy(process.env.MCP_STDIO_ENABLED),
    serverless: isServerlessRuntime(process.env),
  };
}

export function assertStdioRuntime(runtime: StdioRuntime): void {
  if (runtime.serverless) {
    throw new Error("MCP stdio is disabled in serverless runtimes; use authenticated Streamable HTTP");
  }
  const production = runtime.nodeEnv === "production";
  if (production && !runtime.explicitlyEnabled) {
    throw new Error("production MCP stdio requires the explicit MCP_STDIO_ENABLED=true opt-in");
  }
  if ((production || runtime.qwenConfigured) && !runtime.databaseUrl?.trim()) {
    throw new Error("DATABASE_URL is required for durable MCP stdio memory and quotas");
  }
  if (production && !runtime.qwenConfigured) {
    throw new Error("DASHSCOPE_API_KEY is required for production MCP stdio");
  }
}

function boundedTextResult(result: McpToolResult, maxBytes: number): McpToolResult {
  if (!result || !Array.isArray(result.content)) throw new Error("invalid MCP tool result");
  let bytes = 0;
  const content: Array<{ type: "text"; text: string }> = [];
  for (const block of result.content) {
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      throw new Error("non-text MCP tool result");
    }
    bytes += Buffer.byteLength(block.text, "utf8");
    if (bytes > maxBytes) {
      return toolError(
        `tool result exceeds the ${maxBytes}-byte stdio limit; narrow company, period, kind, or recall limit`,
      );
    }
    content.push({ type: "text", text: block.text });
  }
  return { content, ...(result.isError === true ? { isError: true } : {}) };
}

function operationalError(
  operation: StdioOperationalEvent["operation"],
  err: unknown,
  logger: (event: StdioOperationalEvent) => void,
): McpToolResult {
  const errorId = randomUUID();
  try {
    logger({
      errorId,
      operation,
      errorName: sanitizedOperationalFailure("mcp_stdio", err).errorName,
    });
  } catch {
    // Observability must never turn a sanitized tool failure into a transport
    // exception or prevent admission release.
  }
  return toolError(`tool execution failed (error id: ${errorId})`);
}

function toolError(message: string): McpToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function defaultOperationalLogger(event: StdioOperationalEvent): void {
  // stdout is the JSON-RPC protocol. stderr receives a correlation id and error
  // class only—never the exception message, stack, SQL, credentials, or payload.
  console.error("MCP stdio operation failed", event);
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function isServerlessRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.FC_FUNCTION_NAME ||
    env.FC_FUNC_CODE_PATH ||
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.K_SERVICE ||
    env.VERCEL ||
    env.FUNCTIONS_WORKER_RUNTIME,
  );
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
