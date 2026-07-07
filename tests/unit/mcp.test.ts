// Unit test — the MCP server, exercised over the REAL Model Context Protocol via
// the SDK's in-memory linked transport pair (no stdio, no network) plus the
// pure tool adapter. Fully offline: FakeEmbedder + InMemoryStore + FakeNarrator,
// no DB, no DASHSCOPE_API_KEY.
//
// Two layers are covered:
//   1. src/mcp/tools.ts — mcpTools() list shape + callTool() dispatch + error path.
//   2. src/mcp/server.ts — buildMcpServer() wired to a Client through
//      InMemoryTransport, so tools/list and tools/call round-trip over the actual
//      protocol the way Claude Desktop would call them.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { SkillDispatcher } from "../../src/skills/dispatcher.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { mcpTools, callTool } from "../../src/mcp/tools.js";

function buildDispatcher(): SkillDispatcher {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator());
  return new SkillDispatcher(agent, store);
}

beforeEach(() => {
  delete process.env.DASHSCOPE_API_KEY; // guarantee the offline Fakes
});

test("mcpTools(): exposes the four memory tools with JSON-Schema inputSchema", () => {
  const tools = mcpTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["audit_memory", "ingest_memory", "memory_count", "recall_memory"]);
  for (const t of tools) {
    assert.ok(t.description.length > 0);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.inputSchema.properties);
  }
});

test("callTool(): dispatches through the SkillDispatcher and wraps the result as text", async () => {
  const dispatcher = buildDispatcher();
  const ingest = await callTool(dispatcher, "ingest_memory", {
    company: "Helios Retail",
    content: "Revenue for Helios Retail 2026-02 was 120000 euros.",
    kind: "document",
  });
  assert.equal(ingest.isError, undefined);
  assert.equal(ingest.content[0]!.type, "text");
  assert.match(ingest.content[0]!.text, /"written": 1/);

  const count = await callTool(dispatcher, "memory_count", {});
  assert.match(count.content[0]!.text, /"count": 1/);
});

test("callTool(): an unknown tool returns an MCP error result (not a throw)", async () => {
  const res = await callTool(buildDispatcher(), "does_not_exist", {});
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /Unknown skill/);
});

test("callTool(): a missing required arg returns an MCP error result", async () => {
  const res = await callTool(buildDispatcher(), "recall_memory", {});
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /question/);
});

// End-to-end over the actual MCP protocol: a Client talks to buildMcpServer()
// through a linked in-memory transport pair — the same request/response path a
// real MCP client (Claude Desktop) uses, with zero infra.
test("MCP protocol: a Client lists tools and calls them over InMemoryTransport", async () => {
  const dispatcher = buildDispatcher();
  const server = buildMcpServer(dispatcher);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // tools/list over the wire.
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((t) => t.name).sort(),
    ["audit_memory", "ingest_memory", "memory_count", "recall_memory"]
  );

  // tools/call: write a memory, then recall it — grounded answer comes back.
  await client.callTool({
    name: "ingest_memory",
    arguments: {
      company: "ByteCraft Software",
      content: "Operating profit for ByteCraft Software 2026-05 was 41200 euros.",
      kind: "payroll_event",
    },
  });
  const recall = await client.callTool({
    name: "recall_memory",
    arguments: { company: "ByteCraft Software", question: "operating profit?" },
  });
  const text = (recall.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.match(text, /41200/);

  // tools/call error surfaces as an MCP error result, not a transport failure.
  const bad = await client.callTool({ name: "recall_memory", arguments: {} });
  assert.equal(bad.isError, true);

  await Promise.all([client.close(), server.close()]);
});
