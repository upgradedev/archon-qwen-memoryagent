// Custom-skills function-calling loop — lets qwen-plus invoke the memory skills.
//
// This is the "custom skills" surface: the shared skill catalogue (schemas.ts) is
// handed to qwen-plus as OpenAI-compatible function tools, and this loop runs the
// standard tool-calling cycle — model proposes a tool call → we dispatch it
// through the SkillDispatcher → we feed the result back → the model continues
// until it produces a final answer. It is the agentic counterpart to the raw HTTP
// API: instead of a caller choosing an endpoint, qwen-plus chooses a skill.
//
// The client seam mirrors qwen/client.ts: a minimal tool-calling interface that
// the real OpenAI SDK satisfies structurally, so the loop runs against real Qwen
// when a key is present and against a canned fake client in unit tests — no
// network, no key.

import { createQwenClient, hasQwenCreds } from "../qwen/client.js";
import { DEFAULT_NARRATOR_MODEL } from "../agents/narrator.js";
import { SkillDispatcher, publicSkillError, skillInputError } from "./dispatcher.js";

// ── Minimal tool-calling chat shapes (the seam tests inject a fake into) ──────
export interface SkillToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface SkillToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface LoopMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: SkillToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface ToolChatArgs {
  model: string;
  messages: LoopMessage[];
  tools?: SkillToolDef[];
  tool_choice?: "auto" | "none";
  temperature?: number;
}
export interface ToolChatResponse {
  choices: Array<{ message: { content: string | null; tool_calls?: SkillToolCall[] } }>;
}
export interface ToolCallingChatClient {
  chat: { completions: { create(args: ToolChatArgs): Promise<ToolChatResponse> } };
}

const SYSTEM_PROMPT =
  "You are Archon, a financial-intelligence agent with a persistent, self-auditing " +
  "memory. You have custom skills that read and write that memory: recall_memory " +
  "(grounded, cited recall), ingest_memory (remember a new fact), audit_memory " +
  "(check the memory for cross-session contradictions), and memory_count. Use the " +
  "skills to ground every answer in remembered facts — never invent figures. When a " +
  "recall or audit surfaces a contradiction or a missing counterpart, flag it.";

// Project the shared skill catalogue as OpenAI-compatible function tools.
export function skillTools(dispatcher: SkillDispatcher): SkillToolDef[] {
  return dispatcher.skills.map((s) => ({
    type: "function",
    function: {
      name: s.name,
      description: s.description,
      parameters: s.parameters as unknown as Record<string, unknown>,
    },
  }));
}

// One recorded skill invocation during a loop run (for transparency / tests).
export interface SkillInvocation {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}
export interface SkillLoopResult {
  answer: string;
  invocations: SkillInvocation[];
  turns: number;
  modelId: string;
}

// Run the qwen-plus function-calling loop for one user message. The model may
// call any number of skills across up to `maxTurns` round-trips before it
// returns a final text answer; every skill call is dispatched through the shared
// SkillDispatcher (same code the MCP tools and HTTP routes run).
export async function runSkillLoop(
  client: ToolCallingChatClient,
  dispatcher: SkillDispatcher,
  userMessage: string,
  opts: { model?: string; maxTurns?: number } = {}
): Promise<SkillLoopResult> {
  const model = opts.model ?? DEFAULT_NARRATOR_MODEL;
  const maxTurns = Math.max(1, opts.maxTurns ?? 5);
  const tools = skillTools(dispatcher);
  const messages: LoopMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];
  const invocations: SkillInvocation[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const res = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    });
    const message = res.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];

    // No tool calls → the model produced its final answer.
    if (toolCalls.length === 0) {
      return { answer: message?.content ?? "", invocations, turns: turn, modelId: model };
    }

    // Record the assistant's tool-call turn, then dispatch each call and feed the
    // result back as a `tool` message the model reads on the next turn.
    messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      let result: unknown;
      try {
        args = parseArgs(call.function.arguments);
        result = await dispatcher.dispatch(call.function.name, args);
      } catch (err) {
        // Tool arguments are model-produced, untrusted input. Keep malformed
        // calls inside the function-calling protocol as a structured result so
        // Qwen can repair the call on its next turn; never crash the whole loop.
        result = { error: publicSkillError(err) };
      }
      invocations.push({ name: call.function.name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result),
      });
    }
  }

  // Exhausted the turn budget without a final answer — surface what we have.
  return {
    answer: "Reached the maximum number of skill-calling turns without a final answer.",
    invocations,
    turns: maxTurns,
    modelId: model,
  };
}

// Strict parse of the model's stringified tool arguments. An empty string is the
// normal representation of an argument-less call; any non-empty malformed or
// non-object value is rejected and fed back to the model as a structured error.
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw skillInputError("tool arguments must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw skillInputError("tool arguments must be a JSON object");
  }
  const proto = Object.getPrototypeOf(parsed);
  if (proto !== Object.prototype && proto !== null) {
    throw skillInputError("tool arguments must be a plain JSON object");
  }
  return parsed as Record<string, unknown>;
}

// Build a tool-calling client over the environment: the real OpenAI-compatible
// Qwen client when a DASHSCOPE_API_KEY is set. Structural cast — the OpenAI SDK's
// chat.completions.create is a superset of ToolCallingChatClient. Returns null
// offline so callers fall back (tests inject their own fake client).
export function defaultSkillLoopClient(): ToolCallingChatClient | null {
  if (!hasQwenCreds()) return null;
  return createQwenClient() as unknown as ToolCallingChatClient;
}
