// End-to-end MCP journeys — the agent's memory driven the way a real MCP client
// (Claude Desktop, an IDE, another agent) drives it: a `Client` talks to the
// wired `buildMcpServer()` over the SDK's linked in-memory transport pair, so
// every call round-trips through the actual Model Context Protocol (tools/list,
// tools/call), not a direct function call. Fully OFFLINE: FakeEmbedder +
// InMemoryStore + FakeNarrator, no DB, no DASHSCOPE_API_KEY.
//
// These are whole JOURNEYS (list → write → count → recall → self-audit), each
// asserting a real, populated result on the happy path, plus the unhappy MCP
// contract: an unknown tool or a bad argument bag comes back as a structured MCP
// tool error (isError:true), never a transport-level throw that would kill the
// client session.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { SkillDispatcher } from "../../src/skills/dispatcher.js";
import { buildMcpServer } from "../../src/mcp/server.js";

// Stand up a fresh Client↔Server pair over the real protocol, offline.
async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator());
  const server = buildMcpServer(new SkillDispatcher(agent, store));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => { await Promise.all([client.close(), server.close()]); },
  };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ type: string; text: string }> }).content[0]!.text;
}

beforeEach(() => {
  delete process.env.DASHSCOPE_API_KEY; // guarantee the offline Fakes
});

describe("MCP tool-call journeys", () => {
  test("HAPPY: list → ingest → count → recall round-trips over the protocol and returns a grounded answer", async () => {
    const { client, close } = await connectedClient();
    try {
      // 1. Discovery — the client sees the four memory tools.
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((t) => t.name).sort(),
        ["audit_memory", "ingest_memory", "memory_count", "recall_memory"],
      );

      // 2. Write a fact.
      const ingest = await client.callTool({
        name: "ingest_memory",
        arguments: {
          company: "ByteCraft Software",
          content: "Operating profit for ByteCraft Software 2026-05 was 41200 euros.",
          kind: "payroll_event",
        },
      });
      assert.notEqual(ingest.isError, true);
      assert.match(textOf(ingest), /"written": 1/);

      // 3. The count reflects the write.
      const count = await client.callTool({ name: "memory_count", arguments: { company: "ByteCraft Software" } });
      assert.match(textOf(count), /"count": 1/);

      // 4. Recall it — a grounded answer that quotes the stored figure.
      const recall = await client.callTool({
        name: "recall_memory",
        arguments: { company: "ByteCraft Software", question: "what was the operating profit?" },
      });
      assert.notEqual(recall.isError, true);
      const text = textOf(recall);
      assert.match(text, /41200/, "the recalled answer must quote the stored figure");
      assert.match(text, /"citations"/, "the answer must be grounded in cited memory");
    } finally {
      await close();
    }
  });

  test("HAPPY: audit_memory flags a cross-session contradiction written through the protocol", async () => {
    const { client, close } = await connectedClient();
    try {
      // Two write events for the SAME record (INV-77) disagree on the amount — a
      // classic cross-session contradiction the self-audit exists to catch.
      for (const amount of [8400, 8900]) {
        await client.callTool({
          name: "ingest_memory",
          arguments: {
            company: "Northwind Trading",
            content: `Invoice INV-77 recorded at ${amount}.`,
            kind: "document",
            metadata: { record: "INV-77", amount },
          },
        });
      }
      const audit = await client.callTool({ name: "audit_memory", arguments: { company: "Northwind Trading" } });
      assert.notEqual(audit.isError, true);
      const report = JSON.parse(textOf(audit));
      assert.equal(report.ok, false, "a contradiction must make the audit report NOT ok");
      assert.ok(report.contradictions.length >= 1, "the disagreeing amounts must be flagged");
      assert.equal(report.contradictions[0].subject, "INV-77");
      // The self-audit recommends which value to trust (recommender, not truth).
      assert.ok(report.contradictions[0].resolution.recommendedMemoryId, "a resolution must be recommended");
    } finally {
      await close();
    }
  });

  test("UNHAPPY: an unknown tool returns a structured MCP error, not a transport throw", async () => {
    const { client, close } = await connectedClient();
    try {
      const res = await client.callTool({ name: "does_not_exist", arguments: {} });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /Unknown skill/);
    } finally {
      await close();
    }
  });

  test("UNHAPPY: recall_memory with a missing required 'question' arg → MCP error result", async () => {
    const { client, close } = await connectedClient();
    try {
      const res = await client.callTool({ name: "recall_memory", arguments: {} });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /question/);
    } finally {
      await close();
    }
  });

  test("UNHAPPY: ingest_memory with missing/invalid args → MCP error result (content and kind are required)", async () => {
    const { client, close } = await connectedClient();
    try {
      // Missing content entirely.
      const noContent = await client.callTool({ name: "ingest_memory", arguments: { kind: "document" } });
      assert.equal(noContent.isError, true);
      assert.match(textOf(noContent), /content/);

      // Content present but no kind.
      const noKind = await client.callTool({ name: "ingest_memory", arguments: { content: "a fact with no kind" } });
      assert.equal(noKind.isError, true);
      assert.match(textOf(noKind), /kind/);

      // Nothing was written despite two malformed calls — the store stayed clean.
      const count = await client.callTool({ name: "memory_count", arguments: {} });
      assert.match(textOf(count), /"count": 0/);
    } finally {
      await close();
    }
  });
});
