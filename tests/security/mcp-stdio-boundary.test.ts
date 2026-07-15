// PEN-TEST — stdio MCP spend/isolation boundary.
//
// The local transport has no HTTP identity, so its configured tenant is the
// durable quota subject. These tests prove provider-backed calls cannot bypass
// admission/quota, cheap DB-only calls do not consume Qwen budget, runtime
// misconfiguration fails closed, and errors/results do not leak internals.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeJudge, DEFAULT_MAX_PAIRS } from "../../src/memory/semantic-consistency.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { SkillDispatcher } from "../../src/skills/dispatcher.js";
import { InMemoryDailyQuotaBackend } from "../../src/server/quota.js";
import { TieredQwenAdmission } from "../../src/server/admission.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import {
  assertStdioRuntime,
  createStdioCallExecutor,
  MCP_RECALL_WORK_UNITS,
  mcpProviderWorkUnits,
  type McpCallExecutor,
  type StdioRuntime,
} from "../../src/mcp/stdio-policy.js";

const LOCAL_FAKE: StdioRuntime = {
  nodeEnv: "test",
  databaseUrl: undefined,
  qwenConfigured: false,
  explicitlyEnabled: false,
  serverless: false,
};

function dispatcher(): SkillDispatcher {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator(), new FakeJudge());
  return new SkillDispatcher(agent, store, "tenant-stdio");
}

function textOf(result: Awaited<ReturnType<McpCallExecutor>>): string {
  return result.content.map((block) => block.text).join("\n");
}

function okExecutor(onCall?: (name: string) => void): McpCallExecutor {
  return async (_dispatcher, name) => {
    onCall?.(name);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, name }) }] };
  };
}

describe("MCP stdio runtime gate", () => {
  test("production requires explicit opt-in, durable DB, real Qwen, and an ordinary process", () => {
    assert.throws(
      () => assertStdioRuntime({ ...LOCAL_FAKE, nodeEnv: "production" }),
      /MCP_STDIO_ENABLED=true/,
    );
    assert.throws(
      () => assertStdioRuntime({ ...LOCAL_FAKE, nodeEnv: "production", explicitlyEnabled: true }),
      /DATABASE_URL/,
    );
    assert.throws(
      () => assertStdioRuntime({
        ...LOCAL_FAKE,
        nodeEnv: "production",
        explicitlyEnabled: true,
        databaseUrl: "postgres://configured",
      }),
      /DASHSCOPE_API_KEY/,
    );
    assert.doesNotThrow(() => assertStdioRuntime({
      ...LOCAL_FAKE,
      nodeEnv: "production",
      explicitlyEnabled: true,
      databaseUrl: "postgres://configured",
      qwenConfigured: true,
    }));
    assert.throws(
      () => assertStdioRuntime({ ...LOCAL_FAKE, serverless: true }),
      /disabled in serverless runtimes/i,
    );
  });

  test("real-Qwen stdio never falls back to a per-process in-memory quota", () => {
    assert.throws(
      () => assertStdioRuntime({ ...LOCAL_FAKE, qwenConfigured: true }),
      /DATABASE_URL.*durable/i,
    );
    assert.doesNotThrow(() => assertStdioRuntime(LOCAL_FAKE), "offline local Fakes remain usable");
  });
});

describe("MCP stdio provider admission and durable quota policy", () => {
  test("classifies only Qwen-backed tools and reserves semantic fan-out", () => {
    assert.equal(mcpProviderWorkUnits("recall_memory", { question: "q" }), MCP_RECALL_WORK_UNITS);
    assert.equal(mcpProviderWorkUnits("ingest_memory", { content: "x", kind: "insight" }), 1);
    assert.equal(mcpProviderWorkUnits("audit_memory", {}), 0);
    assert.equal(mcpProviderWorkUnits("audit_memory", { semantic: true }), DEFAULT_MAX_PAIRS);
    assert.equal(mcpProviderWorkUnits("memory_count", {}), 0);
    assert.equal(mcpProviderWorkUnits("unknown", {}), 0);
    assert.equal(mcpProviderWorkUnits("recall_memory", {}), 0, "invalid calls never consume provider budget");
    assert.equal(mcpProviderWorkUnits("ingest_memory", { content: "x" }), 0);
  });

  test("provider calls stop at the shared quota while DB-only calls remain available", async () => {
    const calls: string[] = [];
    const execute = createStdioCallExecutor({
      tenantId: "tenant-stdio",
      runtime: LOCAL_FAKE,
      quotaBackend: new InMemoryDailyQuotaBackend(() => new Date("2026-07-15T12:00:00Z")),
      qwenAdmission: new TieredQwenAdmission(1, 1),
      perSubjectLimit: MCP_RECALL_WORK_UNITS,
      globalLimit: MCP_RECALL_WORK_UNITS,
      execute: okExecutor((name) => calls.push(name)),
    });
    const d = dispatcher();

    const first = await execute(d, "recall_memory", { question: "first" });
    assert.notEqual(first.isError, true);
    const exhausted = await execute(d, "ingest_memory", { content: "second", kind: "insight" });
    assert.equal(exhausted.isError, true);
    assert.match(textOf(exhausted), /daily MCP model budget reached/i);

    const count = await execute(d, "memory_count", {});
    const ruleAudit = await execute(d, "audit_memory", {});
    assert.notEqual(count.isError, true);
    assert.notEqual(ruleAudit.isError, true);
    assert.deepEqual(calls, ["recall_memory", "memory_count", "audit_memory"]);
  });

  test("semantic fan-out is charged atomically before the tool executes", async () => {
    let calls = 0;
    const execute = createStdioCallExecutor({
      tenantId: "tenant-stdio",
      runtime: LOCAL_FAKE,
      quotaBackend: new InMemoryDailyQuotaBackend(),
      qwenAdmission: new TieredQwenAdmission(1, 1),
      perSubjectLimit: DEFAULT_MAX_PAIRS - 1,
      globalLimit: DEFAULT_MAX_PAIRS - 1,
      execute: okExecutor(() => { calls += 1; }),
    });
    const result = await execute(dispatcher(), "audit_memory", { semantic: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /daily MCP model budget reached/i);
    assert.equal(calls, 0, "a rejected reservation must never start the semantic judge");
  });

  test("zero-wait admission rejects overlap without spending quota and releases in finally", async () => {
    let startedResolve!: () => void;
    let releaseResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const unblock = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let calls = 0;
    const admission = new TieredQwenAdmission(1, 1);
    const execute = createStdioCallExecutor({
      tenantId: "tenant-stdio",
      runtime: LOCAL_FAKE,
      quotaBackend: new InMemoryDailyQuotaBackend(),
      qwenAdmission: admission,
      perSubjectLimit: MCP_RECALL_WORK_UNITS * 2,
      globalLimit: MCP_RECALL_WORK_UNITS * 2,
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          startedResolve();
          await unblock;
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const d = dispatcher();
    const firstPromise = execute(d, "recall_memory", { question: "first" });
    await started;
    const busy = await execute(d, "recall_memory", { question: "overlap" });
    assert.equal(busy.isError, true);
    assert.match(textOf(busy), /capacity temporarily unavailable/i);
    assert.equal(calls, 1, "busy request must not start provider work");
    releaseResolve();
    assert.notEqual((await firstPromise).isError, true);

    const after = await execute(d, "recall_memory", { question: "after" });
    assert.notEqual(after.isError, true, "the first call released admission in finally");
    assert.deepEqual(admission.snapshot(), { public: 0, judge: 0 });
  });

  test("the real MCP protocol handler cannot bypass the installed stdio executor", async () => {
    const d = dispatcher();
    const execute = createStdioCallExecutor({
      tenantId: "tenant-stdio",
      runtime: LOCAL_FAKE,
      quotaBackend: new InMemoryDailyQuotaBackend(),
      qwenAdmission: new TieredQwenAdmission(1, 1),
      perSubjectLimit: 1,
      globalLimit: 1,
    });
    const server = buildMcpServer(d, execute);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stdio-policy-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const first = await client.callTool({
        name: "ingest_memory",
        arguments: { content: "first fact", kind: "insight" },
      });
      assert.notEqual(first.isError, true);
      const second = await client.callTool({
        name: "ingest_memory",
        arguments: { content: "second fact", kind: "insight" },
      });
      assert.equal(second.isError, true);
      const text = (second.content as Array<{ type: string; text: string }>)[0]!.text;
      assert.match(text, /daily MCP model budget reached/i);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

describe("MCP stdio sanitization and result bounds", () => {
  test("operational failures expose only a correlation id and always release admission", async () => {
    const events: unknown[] = [];
    let fail = true;
    const admission = new TieredQwenAdmission(1, 1);
    const execute = createStdioCallExecutor({
      tenantId: "tenant-stdio",
      runtime: LOCAL_FAKE,
      quotaBackend: new InMemoryDailyQuotaBackend(),
      qwenAdmission: admission,
      perSubjectLimit: MCP_RECALL_WORK_UNITS * 2,
      globalLimit: MCP_RECALL_WORK_UNITS * 2,
      operationalLogger: (event) => events.push(event),
      execute: async () => {
        if (fail) {
          fail = false;
          throw new Error("postgres://admin:secret@private-db internal_table");
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const d = dispatcher();
    const failed = await execute(d, "recall_memory", { question: "first" });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /error id: [0-9a-f-]{36}/i);
    assert.doesNotMatch(textOf(failed), /postgres|admin|secret|private-db|internal_table/i);
    assert.deepEqual(admission.snapshot(), { public: 0, judge: 0 });
    assert.deepEqual(Object.keys(events[0] as object).sort(), ["errorId", "errorName", "operation"]);

    const retry = await execute(d, "recall_memory", { question: "retry" });
    assert.notEqual(retry.isError, true);
  });

  test("oversized results fail safely and unapproved result metadata is dropped", async () => {
    const oversized = createStdioCallExecutor({
      tenantId: "tenant-stdio",
      runtime: LOCAL_FAKE,
      quotaBackend: new InMemoryDailyQuotaBackend(),
      maxResultBytes: 1_024,
      execute: async () => ({ content: [{ type: "text", text: "x".repeat(1_025) }] }),
    });
    const tooLarge = await oversized(dispatcher(), "memory_count", {});
    assert.equal(tooLarge.isError, true);
    assert.match(textOf(tooLarge), /exceeds the 1024-byte stdio limit/i);

    const projected = createStdioCallExecutor({
      tenantId: "tenant-stdio",
      runtime: LOCAL_FAKE,
      quotaBackend: new InMemoryDailyQuotaBackend(),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        secretInternalMetadata: "must-not-cross-boundary",
      }),
    });
    const safe = await projected(dispatcher(), "memory_count", {});
    assert.deepEqual(safe, { content: [{ type: "text", text: "ok" }] });
  });
});
