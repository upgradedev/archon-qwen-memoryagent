// Custom-skills schemas — the SINGLE source of truth for the agent-callable
// memory operations, shared verbatim by two surfaces:
//
//   • the Model Context Protocol server (src/mcp/*) — exposes them as MCP tools,
//   • the Qwen function-calling loop (src/skills/loop.ts) — exposes them as
//     qwen-plus "custom skills" (OpenAI-compatible function tools).
//
// Both surfaces dispatch through the same SkillDispatcher (src/skills/dispatcher.ts)
// into the same injectable MemoryAgent, so there is ONE implementation of each
// operation and ONE typed contract — no duplicated logic, no drift.
//
// Each skill carries a clean JSON-Schema `parameters` object (the same object is
// reused as the MCP tool `inputSchema` and the OpenAI function `parameters`), so
// the schema a Claude Desktop MCP client sees is byte-identical to the schema
// qwen-plus sees when it decides which skill to call.

import type { MemoryKind } from "../memory/store.js";

// The four memory operations exposed as skills / MCP tools.
export type SkillName =
  | "recall_memory"
  | "ingest_memory"
  | "audit_memory"
  | "memory_count";

// The documented memory-kind enum, mirrored from the store's MemoryKind union.
// Surfaced as a JSON-Schema `enum` so both an MCP client and qwen-plus get a
// sharp, validated choice rather than a free-text string.
export const MEMORY_KINDS: readonly MemoryKind[] = [
  "document",
  "payroll_event",
  "validation",
  "insight",
  "invoice",
  "action",
] as const;

// ── Typed argument contracts (what a caller passes) ──────────────────────────
export interface RecallArgs {
  company?: string;
  question: string;
  kind?: MemoryKind;
  limit?: number;
}
export interface IngestArgs {
  company?: string;
  content: string;
  kind: MemoryKind;
  period?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}
export interface AuditArgs {
  company?: string;
  period?: string;
  kind?: MemoryKind;
}
// memory_count takes an optional company scope.
export interface CountArgs {
  company?: string;
}

// A minimal JSON-Schema object type (draft-07 subset) — enough to type the
// `parameters` / `inputSchema` we hand to both the MCP SDK and the OpenAI SDK.
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

// A single skill definition: name + human description + typed JSON-Schema params.
// This is the neutral shape; adapters below project it onto the MCP tool shape
// and the OpenAI function-tool shape without restating the schema.
export interface SkillDefinition {
  name: SkillName;
  description: string;
  parameters: JsonSchema;
}

const kindProperty = {
  type: "string",
  enum: MEMORY_KINDS,
  description:
    "Memory kind: document | payroll_event | validation | insight.",
} as const;

// The canonical skill catalogue. recall / ingest / audit are the three
// agent-facing memory skills; memory_count is a lightweight utility skill.
export const SKILLS: readonly SkillDefinition[] = [
  {
    name: "recall_memory",
    description:
      "Recall a grounded, cited answer from the agent's persistent cross-session " +
      "memory. Runs hybrid (dense + lexical) semantic retrieval, then a Qwen-narrated " +
      "answer that cites the exact memories it used, plus a best-effort self-audit " +
      "over the recalled memories. Use this to answer any question from remembered facts.",
    parameters: {
      type: "object",
      properties: {
        company: {
          type: "string",
          description: "Optional company scope to pre-filter the memory recall.",
        },
        question: {
          type: "string",
          description: "The natural-language question to answer from memory.",
        },
        kind: kindProperty,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Optional cap on the number of memories recalled (default 5).",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "ingest_memory",
    description:
      "Write a single natural-language fact into the agent's persistent memory. " +
      "The content is embedded with Qwen text-embedding-v4 and stored in the pgvector " +
      "memory so future sessions can recall it by meaning. Use this to remember a new fact.",
    parameters: {
      type: "object",
      properties: {
        company: {
          type: "string",
          description: "Company the fact belongs to (defaults to a global scope if omitted).",
        },
        content: {
          type: "string",
          description: "The recallable natural-language fact to remember.",
        },
        kind: kindProperty,
        period: {
          type: "string",
          description: "Optional reporting period the fact belongs to, e.g. 2026-05.",
        },
        sourceRef: {
          type: "string",
          description: "Optional id of the originating record this fact came from.",
        },
        metadata: {
          type: "object",
          additionalProperties: true,
          description: "Optional structured metadata to store alongside the fact.",
        },
      },
      required: ["content", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "audit_memory",
    description:
      "Run the read-only self-audit over the agent's stored memory. Detects " +
      "cross-session contradictions (two write events disagree on a record's value) — " +
      "each with a resolution recommending which value to trust — and dangling " +
      "references (a memory points at a record no memory stores). Never mutates memory.",
    parameters: {
      type: "object",
      properties: {
        company: { type: "string", description: "Optional company scope for the audit." },
        period: { type: "string", description: "Optional reporting-period scope for the audit." },
        kind: kindProperty,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "memory_count",
    description:
      "Return how many memories the agent currently holds, optionally scoped to a company.",
    parameters: {
      type: "object",
      properties: {
        company: { type: "string", description: "Optional company scope for the count." },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

// Look up one skill definition by name (used by both adapters and tests).
export function getSkill(name: SkillName): SkillDefinition {
  const skill = SKILLS.find((s) => s.name === name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  return skill;
}
