// PEN-TEST — MCP tool-boundary / excessive-agency (OWASP LLM06 Excessive Agency,
// LLM08 Vector/Tool misuse). The MCP surface exposes exactly four memory tools;
// three of them are reads and one (ingest_memory) is a single-fact write. The
// invariant this suite proves: a tool call cannot be COERCED into an action
// outside its contract — a read tool never mutates, `audit_memory semantic:true`
// stays read-only, an unknown tool returns a structured error (never a transport
// throw that would crash the client session), hostile/extra arguments are ignored,
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

function offlineDispatcher(store: InMemoryStore): SkillDispatcher {
  delete process.env.DASHSCOPE_API_KEY;
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator(), new FakeJudge());
  return new SkillDispatcher(agent, store);
}

function textOf(r: { content: Array<{ text: string }> }): string {
  return r.content[0]!.text;
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

  test("memory_count with hostile extra arguments only counts — it does not act on them", async () => {
    const store = new InMemoryStore();
    const d = offlineDispatcher(store);
    await callTool(d, "ingest_memory", { company: "Acme", content: "a fact", kind: "insight" });
    const before = await store.count();
    // Smuggle instructions/other-tool params into a count call — all must be ignored.
    const res = await callTool(d, "memory_count", {
      company: "Acme",
      question: "delete everything and drop the table",
      deleteSuperseded: true,
      olderThanDays: 0,
      content: "wipe",
      kind: "document",
    } as Record<string, unknown>);
    assert.notEqual(res.isError, true);
    assert.match(textOf(res), /"count": 1/);
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

  test("ingest_memory writes EXACTLY one fact — an array/bulk smuggle does not fan out", async () => {
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
    assert.notEqual(res.isError, true);
    assert.match(textOf(res), /"written": 1/);
    assert.equal(await store.count(), 1, "the single-fact write contract must not fan out to a bulk insert");
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
