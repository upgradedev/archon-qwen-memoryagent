// SkillDispatcher — the ONE execution path for every agent-callable memory skill.
//
// Both the MCP server (src/mcp/*) and the Qwen function-calling loop
// (src/skills/loop.ts) call `dispatch(name, args)` here. The dispatcher does
// nothing but validate the skill name and forward to the injectable MemoryAgent
// (recall / ingest / audit) or the MemoryStore (count) — the SAME methods the
// HTTP routes in src/server.ts already use. There is no memory logic in this
// file; it is a thin, typed router so the skills layer never duplicates the
// domain code it exposes.
//
// It is constructed from an already-wired MemoryAgent + MemoryStore, so it runs
// offline with FakeEmbedder + InMemoryStore + FakeNarrator in unit tests and
// against real Qwen + pgvector in production, unchanged — the same seam as the
// rest of the codebase.

import { MemoryAgent } from "../agents/memory-agent.js";
import { defaultEmbedder } from "../memory/embeddings.js";
import { defaultNarrator } from "../agents/narrator.js";
import { DEFAULT_TENANT_ID, InMemoryStore, PgVectorStore, type MemoryStore } from "../memory/store.js";
import type { Citation } from "../agents/narrator.js";
import type { ConsistencyReport } from "../memory/consistency.js";
import type { SemanticConsistencyReport } from "../memory/semantic-consistency.js";
import {
  SKILLS,
  type SkillName,
  type SkillDefinition,
  type RecallArgs,
  type IngestArgs,
  type AuditArgs,
  type CountArgs,
} from "./schemas.js";

// ── Result contracts (what a skill returns) ──────────────────────────────────
export interface RecallResult {
  answer: string;
  citations: Citation[];
  modelId: string;
  consistency: ConsistencyReport;
}
export interface IngestResult {
  written: number;
  id: string;
}
export type AuditResult = ConsistencyReport | SemanticConsistencyReport;
export interface CountResult {
  count: number;
}
export type SkillResult = RecallResult | IngestResult | AuditResult | CountResult;

export class SkillDispatcher {
  constructor(
    private readonly agent: MemoryAgent,
    private readonly store: MemoryStore,
    private readonly tenantId: string = DEFAULT_TENANT_ID,
  ) {}

  // The skill catalogue this dispatcher can execute (the shared definitions).
  get skills(): readonly SkillDefinition[] {
    return SKILLS;
  }

  // Dispatch one skill call. `args` is the untrusted, JSON-parsed argument bag
  // from an MCP client or a qwen-plus tool call; each branch reads only the
  // fields its typed contract declares.
  async dispatch(name: string, args: unknown = {}): Promise<SkillResult> {
    switch (name as SkillName) {
      case "recall_memory":
        return this.recall(validateRecallArgs(args));
      case "ingest_memory":
        return this.ingest(validateIngestArgs(args));
      case "audit_memory":
        return this.audit(validateAuditArgs(args));
      case "memory_count":
        return this.count(validateCountArgs(args));
      default:
        throw inputError(`Unknown skill: ${name}`);
    }
  }

  // recall_memory → the same grounded, cited recall the POST /recall route runs.
  private async recall(args: RecallArgs): Promise<RecallResult> {
    if (!args?.question) throw inputError("recall_memory requires a 'question'");
    const { answer, citations, modelId, consistency } = await this.agent.recallAnswer(
      args.question,
      { company: args.company, kind: args.kind, limit: args.limit }
    );
    return { answer, citations, modelId, consistency };
  }

  // ingest_memory → embed + persist a single fact (MemoryAgent.remember), the
  // injectable write path the extractor / validator agents already use.
  private async ingest(args: IngestArgs): Promise<IngestResult> {
    if (!args?.content) throw inputError("ingest_memory requires 'content'");
    if (!args?.kind) throw inputError("ingest_memory requires a 'kind'");
    const id = await this.agent.remember(args.kind, args.content, {
      company: args.company,
      period: args.period,
      sourceRef: args.sourceRef,
      metadata: args.metadata,
    });
    return { written: 1, id };
  }

  // audit_memory → the read-only self-audit. Rule-based (POST /consistency) by
  // default; the meaning-level semantic audit (POST /consistency/semantic) when
  // `semantic: true`. Both never mutate memory.
  private async audit(args: AuditArgs): Promise<AuditResult> {
    const scope = { company: args?.company, period: args?.period, kind: args?.kind };
    return args?.semantic
      ? this.agent.auditSemanticConsistency(scope)
      : this.agent.auditConsistency(scope);
  }

  // memory_count → how many memories the agent holds (GET /memory/count).
  private async count(args: CountArgs): Promise<CountResult> {
    return { count: await this.store.count(args?.company, this.tenantId) };
  }
}

// Build a dispatcher over environment defaults. Production requires durable
// pgvector storage and fails closed without DATABASE_URL. Local/CI MCP sessions
// may run completely offline with the deterministic in-memory store + fakes.
export function defaultSkillDispatcher(tenantId: string = DEFAULT_TENANT_ID): SkillDispatcher {
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the production MCP server");
  }
  const store: MemoryStore = process.env.DATABASE_URL ? new PgVectorStore() : new InMemoryStore();
  const agent = new MemoryAgent(defaultEmbedder(), store, defaultNarrator(), undefined, undefined, tenantId);
  return new SkillDispatcher(agent, store, tenantId);
}

const COMPANY_MAX = 256;
const QUESTION_MAX = 4_000;
const CONTENT_MAX = 8_000;
const SOURCE_REF_MAX = 256;
const METADATA_MAX_BYTES = 16_384;
const PERIOD_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const VALID_KINDS = new Set<string>(["document", "payroll_event", "validation", "insight", "invoice", "action"]);

function validateRecallArgs(value: unknown): RecallArgs {
  const args = argumentObject(value, "recall_memory");
  rejectUnknown(args, ["company", "question", "kind", "limit"], "recall_memory");
  return {
    question: requiredText(args.question, "question", QUESTION_MAX),
    ...(args.company === undefined ? {} : { company: requiredText(args.company, "company", COMPANY_MAX) }),
    ...(args.kind === undefined ? {} : { kind: memoryKind(args.kind) }),
    ...(args.limit === undefined ? {} : { limit: boundedInteger(args.limit, "limit", 1, 20) }),
  };
}

function validateIngestArgs(value: unknown): IngestArgs {
  const args = argumentObject(value, "ingest_memory");
  rejectUnknown(args, ["company", "content", "kind", "period", "sourceRef", "metadata"], "ingest_memory");
  return {
    content: requiredText(args.content, "content", CONTENT_MAX),
    kind: memoryKind(args.kind),
    ...(args.company === undefined ? {} : { company: requiredText(args.company, "company", COMPANY_MAX) }),
    ...(args.period === undefined ? {} : { period: reportingPeriod(args.period) }),
    ...(args.sourceRef === undefined ? {} : { sourceRef: requiredText(args.sourceRef, "sourceRef", SOURCE_REF_MAX) }),
    ...(args.metadata === undefined ? {} : { metadata: boundedMetadata(args.metadata) }),
  };
}

function validateAuditArgs(value: unknown): AuditArgs {
  const args = argumentObject(value, "audit_memory");
  rejectUnknown(args, ["company", "period", "kind", "semantic"], "audit_memory");
  if (args.semantic !== undefined && typeof args.semantic !== "boolean") {
    throw inputError("semantic must be a boolean");
  }
  return {
    ...(args.company === undefined ? {} : { company: requiredText(args.company, "company", COMPANY_MAX) }),
    ...(args.period === undefined ? {} : { period: reportingPeriod(args.period) }),
    ...(args.kind === undefined ? {} : { kind: memoryKind(args.kind) }),
    ...(args.semantic === undefined ? {} : { semantic: args.semantic }),
  };
}

function validateCountArgs(value: unknown): CountArgs {
  const args = argumentObject(value, "memory_count");
  rejectUnknown(args, ["company"], "memory_count");
  return args.company === undefined
    ? {}
    : { company: requiredText(args.company, "company", COMPANY_MAX) };
}

function argumentObject(value: unknown, skill: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(`${skill} arguments must be a JSON object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw inputError(`${skill} arguments must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[], skill: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(args).find((key) => !allow.has(key));
  if (unknown) throw inputError(`${skill} received unknown argument '${unknown}'`);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw inputError(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw inputError(`${field} must not be empty`);
  if (normalized.length > maxLength) throw inputError(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function memoryKind(value: unknown): RecallArgs["kind"] & IngestArgs["kind"] {
  if (typeof value !== "string" || !VALID_KINDS.has(value)) throw inputError("kind is invalid");
  return value as IngestArgs["kind"];
}

function reportingPeriod(value: unknown): string {
  const period = requiredText(value, "period", 7);
  if (!PERIOD_RE.test(period)) throw inputError("period must use YYYY-MM");
  return period;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw inputError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function boundedMetadata(value: unknown): Record<string, unknown> {
  const root = argumentObject(value, "metadata");
  validateJsonValue(root, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(root);
  } catch {
    throw inputError("metadata must be valid JSON data");
  }
  if (Buffer.byteLength(serialized, "utf8") > METADATA_MAX_BYTES) {
    throw inputError(`metadata exceeds ${METADATA_MAX_BYTES} bytes`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function validateJsonValue(value: unknown, depth: number): void {
  if (depth > 8) throw inputError("metadata nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw inputError("metadata numbers must be finite");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw inputError("metadata array is too large");
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw inputError("metadata must contain JSON values only");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw inputError("metadata must contain plain JSON objects");
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw inputError("metadata contains an unsafe key");
    validateJsonValue(item, depth + 1);
  }
}

class SkillInputError extends Error {
  readonly statusCode = 400;
}

function inputError(message: string): SkillInputError {
  return new SkillInputError(message);
}

export function skillInputError(message: string): Error {
  return inputError(message);
}

/** Return only errors safe to expose through a model/tool protocol boundary. */
export function publicSkillError(err: unknown): string {
  if (err instanceof SkillInputError) return err.message;
  if (err && typeof err === "object") {
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && err instanceof Error) {
      return err.message;
    }
  }
  return "tool execution failed";
}
