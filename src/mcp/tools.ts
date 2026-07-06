// MCP tool adapter — projects the shared skill catalogue onto the Model Context
// Protocol tool shape and executes a tool call through the SkillDispatcher.
//
// This module holds ALL the MCP request logic and is pure + transport-free, so
// it is unit-tested directly (no stdio, no network). src/mcp/server.ts is a thin
// wiring layer that registers these two functions as the MCP `tools/list` and
// `tools/call` handlers.

import type { SkillDispatcher } from "../skills/dispatcher.js";
import { SKILLS } from "../skills/schemas.js";

// The MCP `Tool` shape (name + description + JSON-Schema inputSchema). Declared
// locally so this adapter does not depend on the SDK's types — the shape is a
// structural match for the SDK's Tool, so it registers unchanged.
export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

// The MCP `CallToolResult` shape (text content blocks + optional error flag).
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // Open index signature so the result is structurally assignable to the SDK's
  // CallToolResult (which carries optional _meta / structuredContent fields).
  [key: string]: unknown;
}

// tools/list — the four memory tools, each reusing its skill's exact JSON Schema
// as the MCP inputSchema (so the MCP client sees the same contract qwen-plus does).
export function mcpTools(): McpTool[] {
  return SKILLS.map((s) => ({
    name: s.name,
    description: s.description,
    inputSchema: {
      type: "object",
      properties: s.parameters.properties,
      required: s.parameters.required,
    },
  }));
}

// tools/call — dispatch one tool through the shared SkillDispatcher and wrap the
// result as an MCP text content block. Errors (unknown tool, missing args) are
// returned as an MCP tool error rather than thrown, per the MCP contract, so the
// client sees a structured failure instead of a transport-level exception.
export async function callTool(
  dispatcher: SkillDispatcher,
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult> {
  try {
    const result = await dispatcher.dispatch(name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
