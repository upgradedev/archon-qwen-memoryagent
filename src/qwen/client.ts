// Qwen client — one OpenAI-compatible entry point to Alibaba Cloud Model Studio
// (DashScope). Both the embedder and the narrator talk to Qwen through the same
// OpenAI-compatible surface, so the standard `openai` SDK connects unchanged —
// exactly as the hackathon getting-started guide prescribes.
//
// Auth + endpoint come from the environment:
//   DASHSCOPE_API_KEY  — Model Studio API key (absent → offline Fakes are used)
//   DASHSCOPE_BASE_URL — OpenAI-compatible base URL; defaults to the hackathon
//                        international endpoint.
//
// The two minimal interfaces below are the ONLY surface the embedder/narrator
// need. The real OpenAI client satisfies them, and a one-object fake satisfies
// them in unit tests — so every code path is testable with no network + no key.

import OpenAI from "openai";

export const DEFAULT_BASE_URL =
  process.env.DASHSCOPE_BASE_URL ||
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

// True when a real Model Studio key is configured. Drives the auto-selection of
// real Qwen vs. the deterministic offline Fakes (same pattern in embeddings.ts
// and narrator.ts), so dev + CI run with zero credentials.
export function hasQwenCreds(): boolean {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

// Robustness defaults for every live call to DashScope: a per-request timeout so
// a hung upstream cannot stall a recall (or ingest) indefinitely, and a small
// automatic retry budget for transient network / 5xx blips. Both overridable via
// env for tuning. Without these, a single DashScope stall would hang /recall on
// the live box until the client gave up — a real judging-window failure mode.
export const QWEN_REQUEST_TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS || 20_000);
export const QWEN_MAX_RETRIES = Number(process.env.QWEN_MAX_RETRIES || 2);

export function createQwenClient(
  apiKey: string = process.env.DASHSCOPE_API_KEY ?? "",
  baseURL: string = DEFAULT_BASE_URL
): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL,
    timeout: QWEN_REQUEST_TIMEOUT_MS,
    maxRetries: QWEN_MAX_RETRIES,
  });
}

// ── Minimal client shapes (the seams unit tests inject fakes into) ────────────

export interface EmbeddingsCreateArgs {
  model: string;
  input: string;
  dimensions?: number;
}
export interface EmbeddingsResponse {
  data: Array<{ embedding: number[] }>;
}
export interface QwenEmbeddingsClient {
  embeddings: { create(args: EmbeddingsCreateArgs): Promise<EmbeddingsResponse> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface ChatCreateArgs {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}
export interface ChatResponse {
  choices: Array<{ message: { content: string | null } }>;
}
export interface QwenChatClient {
  chat: { completions: { create(args: ChatCreateArgs): Promise<ChatResponse> } };
}
