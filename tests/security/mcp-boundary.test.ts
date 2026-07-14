// PEN-TEST — MCP tool-boundary / excessive-agency (OWASP LLM06 Excessive Agency,
// LLM08 Vector/Tool misuse). The MCP surface exposes exactly four memory tools;
// three of them are reads and one (ingest_memory) is a single-fact write. The
// invariant this suite proves: a tool call cannot be COERCED into an action
// outside its contract — a read tool never mutates, `audit_memory semantic:true`
// stays read-only, an unknown tool returns a structured error (never a transport
// throw that would crash the client session), hostile/extra arguments are rejected,
// and a crafted `__proto__` argument cannot pollute the global prototype.
//
// Drives the REAL adapter (src/mcp/tools.ts) through the SkillDispatcher, exactly
// as src/mcp/server.ts wires it. Fully OFFLINE (InMemoryStore + Fakes).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mcpTools, callTool } from "../../src/mcp/tools.js";
import { SkillDispatcher } from "../../src/skills/dispatcher.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { FakeJudge } from "../../src/memory/semantic-consistency.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { createMcpHttpServer, mcpHttpPort } from "../../src/mcp/server.js";
import { request as httpRequest, type Server } from "node:http";
import { InMemoryDailyQuotaBackend } from "../../src/server/quota.js";

function offlineDispatcher(store: InMemoryStore): SkillDispatcher {
  delete process.env.DASHSCOPE_API_KEY;
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator(), new FakeJudge());
  return new SkillDispatcher(agent, store);
}

function textOf(r: { content: Array<{ text: string }> }): string {
  return r.content[0]!.text;
}

function remoteRequest(
  port: number,
  method: string,
  body: string = "",
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method,
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server port");
  return address.port;
}

// ── The tool surface is exactly the declared contract ───────────────────────────
describe("MCP boundary: only the four declared memory tools exist", () => {
  test("tools/list exposes exactly {recall,ingest,audit,count} — no hidden privileged tool", () => {
    const names = mcpTools().map((t) => t.name).sort();
    assert.deepEqual(names, ["audit_memory", "ingest_memory", "memory_count", "recall_memory"]);
    // No tool advertises a destructive verb the agent could be steered into.
    for (const t of mcpTools()) {
      assert.doesNotMatch(t.name, /delete|drop|wipe|exec|admin|forget|consolidate/i, `unexpected privileged tool ${t.name}`);
    }
  });
});

describe("MCP remote HTTP boundary: fail-closed auth, method/type/body bounds, tenant derivation", () => {
  test("garbled body-limit and port environment values fall back to bounded defaults", async () => {
    assert.equal(mcpHttpPort("not-a-number"), 9100);
    assert.equal(mcpHttpPort(Infinity), 9100);
    assert.equal(mcpHttpPort(0), 1);
    assert.equal(mcpHttpPort(999_999), 65_535);

    const previous = process.env.MCP_MAX_BODY_BYTES;
    process.env.MCP_MAX_BODY_BYTES = "NaN";
    const key = "remote-mcp-body-limit-key-12345";
    const server = createMcpHttpServer({
      auth: { apiKeys: { "tenant-mcp": key } },
      quotaBackend: new InMemoryDailyQuotaBackend(),
      dispatcherFactory: () => offlineDispatcher(new InMemoryStore()),
    });
    const port = await listen(server);
    try {
      const res = await remoteRequest(port, "POST", JSON.stringify({ data: "x".repeat(300_000) }), {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      });
      assert.equal(res.status, 413);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      if (previous === undefined) delete process.env.MCP_MAX_BODY_BYTES;
      else process.env.MCP_MAX_BODY_BYTES = previous;
    }
  });
  test("anonymous and malformed requests are rejected before a dispatcher is created", async () => {
    const key = "remote-mcp-test-key-12345";
    const seenTenants: string[] = [];
    const server = createMcpHttpServer({
      auth: { apiKeys: { "tenant-mcp": key } },
      maxBodyBytes: 1024,
      quotaBackend: new InMemoryDailyQuotaBackend(),
      dispatcherFactory(tenantId) {
        seenTenants.push(tenantId);
        const store = new InMemoryStore();
        const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator(), new FakeJudge(), undefined, tenantId);
        return new SkillDispatcher(agent, store, tenantId);
      },
    });
    const port = await listen(server);
    try {
      const anonymous = await remoteRequest(port, "POST", "{}", { "content-type": "application/json" });
      assert.equal(anonymous.status, 401);
      assert.equal(seenTenants.length, 0);

      const method = await remoteRequest(port, "GET");
      assert.equal(method.status, 405);
      assert.equal(method.headers.allow, "POST");

      const wrongType = await remoteRequest(port, "POST", "{}", {
        authorization: `Bearer ${key}`,
        "content-type": "text/plain",
      });
      assert.equal(wrongType.status, 415);

      const oversized = await remoteRequest(port, "POST", JSON.stringify({ data: "x".repeat(2000) }), {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      });
      assert.equal(oversized.status, 413);

      const invalidJson = await remoteRequest(port, "POST", "{", {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      });
      assert.equal(invalidJson.status, 400);

      // A syntactically valid (though not protocol-valid) JSON body reaches the
      // dispatcher factory only after auth and carries the server-derived tenant.
      await remoteRequest(port, "POST", "{}", {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      });
      assert.deepEqual(seenTenants, ["tenant-mcp"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  test("an MCP server-side failure is a generic correlated 503", async () => {
    const key = "remote-mcp-quota-key-12345";
    const server = createMcpHttpServer({
      auth: { apiKeys: { "tenant-mcp": key } },
      quotaBackend: {
        async consume() {
          throw new Error("postgres://admin:password@private-db quota table missing");
        },
        async consumeMany() {
          throw new Error("postgres://admin:password@private-db quota table missing");
        },
      },
    });
    const port = await listen(server);
    try {
      const res = await remoteRequest(port, "POST", "{}", {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      });
      assert.equal(res.status, 503);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      assert.equal(body.error, "service temporarily unavailable");
      assert.equal(typeof body.requestId, "string");
      assert.match(String(body.errorId), /^[0-9a-f-]{36}$/i);
      assert.equal(res.headers["x-request-id"], body.requestId);
      assert.doesNotMatch(res.body, /postgres|password|quota table/i);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});

// ── Read tools cannot be coerced into a mutation ────────────────────────────────
describe("MCP boundary: audit / count / recall never mutate under any argument bag", () => {
  test("audit_memory (rule) and audit_memory{semantic:true} are read-only", async () => {
    const store = new InMemoryStore();
    const d = offlineDispatcher(store);
    // Seed two memories via the legitimate write tool so there is state to (not) mutate.
    await callTool(d, "ingest_memory", { company: "Acme", content: "Vendor pays on time.", kind: "insight" });
    await callTool(d, "ingest_memory", { company: "Acme", content: "Vendor is chronically late.", kind: "insight" });
    const before = await store.count();

    const ruleAudit = await callTool(d, "audit_memory", { company: "Acme" });
    const semanticAudit = await callTool(d, "audit_memory", { company: "Acme", semantic: true });
    assert.notEqual(ruleAudit.isError, true);
    assert.notEqual(semanticAudit.isError, true);

    assert.equal(await store.count(), before, "neither audit mode may change the store");
  });

  test("memory_count rejects hostile extra arguments and does not mutate", async () => {
    const store = new InMemoryStore();
    const d = offlineDispatcher(store);
    await callTool(d, "ingest_memory", { company: "Acme", content: "a fact", kind: "insight" });
    const before = await store.count();
    // Smuggle instructions/other-tool params into a count call — strict runtime
    // validation rejects the whole call rather than silently widening authority.
    const res = await callTool(d, "memory_count", {
      company: "Acme",
      question: "delete everything and drop the table",
      deleteSuperseded: true,
      olderThanDays: 0,
      content: "wipe",
      kind: "document",
    } as Record<string, unknown>);
    assert.equal(res.isError, true);
    assert.match(textOf(res), /unknown argument/i);
    assert.equal(await store.count(), before, "extra hostile args must not trigger any write/delete");
  });
});

// ── Contract violations fail SAFE (structured error, never a throw) ──────────────
describe("MCP boundary: contract violations return a structured tool error, not a crash", () => {
  test("an unknown tool name → isError result naming the unknown skill", async () => {
    const d = offlineDispatcher(new InMemoryStore());
    const res = await callTool(d, "delete_all_memories", { confirm: true });
    assert.equal(res.isError, true, "an unknown tool must fail safe as a tool error");
    assert.match(textOf(res), /Unknown skill/);
  });

  test("ingest_memory missing required content/kind → isError, nothing written", async () => {
    const store = new InMemoryStore();
    const d = offlineDispatcher(store);
    const noContent = await callTool(d, "ingest_memory", { kind: "document" });
    const noKind = await callTool(d, "ingest_memory", { content: "orphan fact" });
    assert.equal(noContent.isError, true);
    assert.equal(noKind.isError, true);
    assert.equal(await store.count(), 0, "two malformed writes must leave the store empty");
  });

  test("ingest_memory rejects an array/bulk smuggle without writing", async () => {
    const store = new InMemoryStore();
    const d = offlineDispatcher(store);
    // Try to smuggle a batch through the single-fact contract.
    const res = await callTool(d, "ingest_memory", {
      company: "Acme",
      content: "one legitimate fact",
      kind: "insight",
      // hostile extras that a naive impl might loop over:
      contents: ["a", "b", "c"],
      documents: [{}, {}, {}],
    } as Record<string, unknown>);
    assert.equal(res.isError, true);
    assert.match(textOf(res), /unknown argument/i);
    assert.equal(await store.count(), 0, "the rejected bulk smuggle must leave memory untouched");
  });

  test("unexpected store failures are generic and never disclose infrastructure details", async () => {
    class BrokenStore extends InMemoryStore {
      override async count(): Promise<number> {
        throw new Error("postgres://admin:password@private-db internal_table");
      }
    }
    const res = await callTool(offlineDispatcher(new BrokenStore()), "memory_count", {});
    assert.equal(res.isError, true);
    assert.match(textOf(res), /tool execution failed/);
    assert.doesNotMatch(textOf(res), /postgres|password|private-db|internal_table/i);
  });
});

// ── Prototype-pollution hardening ───────────────────────────────────────────────
describe("MCP boundary: a crafted __proto__ argument cannot pollute the prototype", () => {
  test("dispatching an args bag with an own __proto__ key does not set Object.prototype.polluted", async () => {
    const d = offlineDispatcher(new InMemoryStore());
    // JSON.parse creates an OWN "__proto__" property (unlike an object literal).
    const hostile = JSON.parse('{"company":"Acme","__proto__":{"polluted":true}}');
    await callTool(d, "memory_count", hostile);
    // The global prototype must be clean.
    assert.equal(({} as Record<string, unknown>).polluted, undefined, "prototype pollution must not occur");
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  });
});
