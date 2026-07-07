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
import { PgVectorStore, type MemoryStore } from "../memory/store.js";
import type { Citation } from "../agents/narrator.js";
import type { ConsistencyReport } from "../memory/consistency.js";
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
export type AuditResult = ConsistencyReport;
export interface CountResult {
  count: number;
}
export type SkillResult = RecallResult | IngestResult | AuditResult | CountResult;

export class SkillDispatcher {
  constructor(
    private readonly agent: MemoryAgent,
    private readonly store: MemoryStore
  ) {}

  // The skill catalogue this dispatcher can execute (the shared definitions).
  get skills(): readonly SkillDefinition[] {
    return SKILLS;
  }

  // Dispatch one skill call. `args` is the untrusted, JSON-parsed argument bag
  // from an MCP client or a qwen-plus tool call; each branch reads only the
  // fields its typed contract declares.
  async dispatch(name: string, args: Record<string, unknown> = {}): Promise<SkillResult> {
    switch (name as SkillName) {
      case "recall_memory":
        return this.recall(args as unknown as RecallArgs);
      case "ingest_memory":
        return this.ingest(args as unknown as IngestArgs);
      case "audit_memory":
        return this.audit(args as unknown as AuditArgs);
      case "memory_count":
        return this.count(args as unknown as CountArgs);
      default:
        throw new Error(`Unknown skill: ${name}`);
    }
  }

  // recall_memory → the same grounded, cited recall the POST /recall route runs.
  private async recall(args: RecallArgs): Promise<RecallResult> {
    if (!args?.question) throw new Error("recall_memory requires a 'question'");
    const { answer, citations, modelId, consistency } = await this.agent.recallAnswer(
      args.question,
      { company: args.company, kind: args.kind, limit: args.limit }
    );
    return { answer, citations, modelId, consistency };
  }

  // ingest_memory → embed + persist a single fact (MemoryAgent.remember), the
  // injectable write path the extractor / validator agents already use.
  private async ingest(args: IngestArgs): Promise<IngestResult> {
    if (!args?.content) throw new Error("ingest_memory requires 'content'");
    if (!args?.kind) throw new Error("ingest_memory requires a 'kind'");
    const id = await this.agent.remember(args.kind, args.content, {
      company: args.company,
      period: args.period,
      sourceRef: args.sourceRef,
      metadata: args.metadata,
    });
    return { written: 1, id };
  }

  // audit_memory → the read-only self-audit (POST /consistency).
  private async audit(args: AuditArgs): Promise<AuditResult> {
    return this.agent.auditConsistency({
      company: args?.company,
      period: args?.period,
      kind: args?.kind,
    });
  }

  // memory_count → how many memories the agent holds (GET /memory/count).
  private async count(args: CountArgs): Promise<CountResult> {
    return { count: await this.store.count(args?.company) };
  }
}

// Build a dispatcher over the environment defaults: real Qwen + pgvector when a
// DASHSCOPE_API_KEY / DATABASE_URL are set, the deterministic offline Fakes
// otherwise — the same auto-selection as the HTTP backend. Used by the MCP
// server bootstrap; tests construct SkillDispatcher directly with InMemoryStore.
export function defaultSkillDispatcher(): SkillDispatcher {
  const store = new PgVectorStore();
  const agent = new MemoryAgent(defaultEmbedder(), store, defaultNarrator());
  return new SkillDispatcher(agent, store);
}
