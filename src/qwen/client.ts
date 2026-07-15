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

export interface OfficialEvidenceEndpoint {
  baseUrl: string;
  region: "international" | "china-beijing";
}

export interface OfficialRuntimeEndpoint {
  baseUrl: string;
  region:
    | "cn-beijing"
    | "ap-southeast-1"
    | "ap-northeast-1"
    | "eu-central-1"
    | "cn-hongkong"
    | "us-east-1";
  access: "dashscope" | "workspace-dedicated";
}

function normalizedEndpoint(value: string, context: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${context} requires a valid official Model Studio base URL`);
  }
  if (
    value !== value.trim() ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(
      `${context} requires a credential-free HTTPS Model Studio base URL on the default port without query or fragment`,
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

// Production accepts only the documented pay-as-you-go Model Studio surfaces:
// four shared DashScope domains or a workspace-dedicated `llm-*` host in a
// documented region. Trial, Token Plan, Coding Plan and arbitrary compatible
// proxies are deliberately excluded from this backend runtime.
export function officialRuntimeEndpoint(
  value: string = DEFAULT_BASE_URL,
): OfficialRuntimeEndpoint {
  const url = normalizedEndpoint(value, "production runtime");
  const shared = new Map<string, OfficialRuntimeEndpoint["region"]>([
    ["dashscope.aliyuncs.com", "cn-beijing"],
    ["dashscope-intl.aliyuncs.com", "ap-southeast-1"],
    ["cn-hongkong.dashscope.aliyuncs.com", "cn-hongkong"],
    ["dashscope-us.aliyuncs.com", "us-east-1"],
  ]);
  const sharedRegion = shared.get(url.hostname);
  if (sharedRegion && url.pathname === "/compatible-mode/v1") {
    return {
      baseUrl: `${url.origin}${url.pathname}`,
      region: sharedRegion,
      access: "dashscope",
    };
  }

  // `llm-` plus a 3-59 character DNS-safe identifier yields a complete label
  // no longer than 63 characters and forbids leading/trailing hyphens.
  const workspace = /^(llm-[a-z0-9](?:[a-z0-9-]{1,57}[a-z0-9]))\.(cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|cn-hongkong)\.maas\.aliyuncs\.com$/.exec(
    url.hostname,
  );
  if (workspace && url.pathname === "/compatible-mode/v1") {
    return {
      baseUrl: `${url.origin}${url.pathname}`,
      region: workspace[2] as OfficialRuntimeEndpoint["region"],
      access: "workspace-dedicated",
    };
  }
  throw new Error(
    "production runtime permits only official pay-as-you-go Alibaba Model Studio endpoints",
  );
}

// Keyed benchmark evidence is intentionally stricter than runtime: only shared
// official endpoints are persisted, so an artifact never discloses a workspace
// identifier. Individual versioned protocols may narrow this set further.
export function officialEvidenceEndpoint(
  value: string = DEFAULT_BASE_URL,
): OfficialEvidenceEndpoint {
  const url = normalizedEndpoint(value, "online evidence");
  const normalized = `${url.origin}${url.pathname}`;
  if (normalized === "https://dashscope-intl.aliyuncs.com/compatible-mode/v1") {
    return { baseUrl: normalized, region: "international" };
  }
  if (normalized === "https://dashscope.aliyuncs.com/compatible-mode/v1") {
    return { baseUrl: normalized, region: "china-beijing" };
  }
  throw new Error(
    "online evidence permits only official shared Alibaba Model Studio endpoints",
  );
}

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
export const QWEN_REQUEST_TIMEOUT_MS = boundedIntegerConfig(
  process.env.QWEN_TIMEOUT_MS,
  20_000,
  1_000,
  120_000,
);
export const QWEN_MAX_RETRIES = boundedIntegerConfig(
  process.env.QWEN_MAX_RETRIES,
  2,
  0,
  5,
);

export function boundedIntegerConfig(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
}

export function createQwenClient(
  apiKey: string = process.env.DASHSCOPE_API_KEY ?? "",
  baseURL: string = DEFAULT_BASE_URL
): OpenAI {
  const effectiveBaseUrl = process.env.NODE_ENV === "production"
    ? officialRuntimeEndpoint(baseURL).baseUrl
    : baseURL;
  return new OpenAI({
    apiKey,
    baseURL: effectiveBaseUrl,
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
export interface EmbeddingsRequestOptions {
  signal?: AbortSignal;
}
export interface QwenEmbeddingsClient {
  embeddings: {
    create(args: EmbeddingsCreateArgs, options?: EmbeddingsRequestOptions): Promise<EmbeddingsResponse>;
  };
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
  response_format?: { type: "json_object" };
  // Qwen 3.7 JSON/tool calls must be non-thinking. Kept optional so plain
  // narration can use the model default while structured paths opt out.
  enable_thinking?: boolean;
}
export interface ChatRequestOptions {
  signal?: AbortSignal;
}
export interface ChatResponse {
  choices: Array<{ message: { content: string | null } }>;
}
export interface QwenChatClient {
  chat: {
    completions: {
      create(args: ChatCreateArgs, options?: ChatRequestOptions): Promise<ChatResponse>;
    };
  };
}
