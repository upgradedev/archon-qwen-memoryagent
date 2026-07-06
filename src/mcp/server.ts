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
// Runs offline with the deterministic Fakes when no DASHSCOPE_API_KEY is set, and
// against real Qwen + pgvector when the environment is configured — same seam as
// the rest of the service.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { SkillDispatcher, defaultSkillDispatcher } from "../skills/dispatcher.js";
import { mcpTools, callTool } from "./tools.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

// Build the MCP Server over a SkillDispatcher and register the tools/list and
// tools/call handlers. Returns the configured, UNCONNECTED server so a caller
// (or a test using InMemoryTransport) can connect any transport to it. All the
// request logic delegates to the pure adapter in ./tools.ts.
export function buildMcpServer(dispatcher: SkillDispatcher = defaultSkillDispatcher()): Server {
  const server = new Server(
    { name: "archon-memoryagent", version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    return callTool(dispatcher, name, (args ?? {}) as Record<string, unknown>);
  });

  return server;
}

/* c8 ignore start — transport bootstrap glue (stdio / HTTP / process entry).
   The protocol behaviour is covered in tests via InMemoryTransport against
   buildMcpServer(); this block is pure I/O wiring exercised only by a live client. */

// Start the server on the stdio transport (the primary MCP client transport).
// NOTE: stdio speaks JSON-RPC on stdout — never write logs to stdout here.
export async function startStdio(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("archon-memoryagent MCP server running on stdio");
}

// Optional Streamable HTTP transport for remote MCP clients. Stateless: each POST
// gets a fresh Server + transport, so no session store is needed. Intended for
// the redeployed Alibaba Cloud host (MCP_TRANSPORT=http, MCP_HTTP_PORT).
export async function startHttp(port = Number(process.env.MCP_HTTP_PORT ?? 9100)): Promise<void> {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;

    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.error(`archon-memoryagent MCP server running on Streamable HTTP :${port}/mcp`);
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
    console.error(err);
    process.exit(1);
  });
}
/* c8 ignore stop */
