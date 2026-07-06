// Unit test — the custom-skills layer (schemas + dispatcher + qwen function-
// calling loop), fully offline: FakeEmbedder + InMemoryStore + FakeNarrator and
// a canned tool-calling chat client. No DB, no DASHSCOPE_API_KEY, no network.
//
// Asserts (1) the shared skill catalogue is well-formed and typed, (2) the
// dispatcher executes each skill against the injectable MemoryAgent and returns
// the right shape, and (3) the function-calling loop lets a (fake) qwen-plus
// invoke a skill and ground its final answer in the result.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";
import { SkillDispatcher } from "../../src/skills/dispatcher.js";
import { SKILLS, MEMORY_KINDS, getSkill } from "../../src/skills/schemas.js";
import {
  runSkillLoop,
  skillTools,
  type ToolCallingChatClient,
  type ToolChatArgs,
  type ToolChatResponse,
} from "../../src/skills/loop.js";

function buildDispatcher(): { dispatcher: SkillDispatcher; store: InMemoryStore } {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator());
  return { dispatcher: new SkillDispatcher(agent, store), store };
}

let dispatcher: SkillDispatcher;
beforeEach(() => {
  delete process.env.DASHSCOPE_API_KEY; // guarantee the offline Fakes
  ({ dispatcher } = buildDispatcher());
});

test("skill catalogue: the four memory skills are defined with typed JSON-Schema params", () => {
  const names = SKILLS.map((s) => s.name).sort();
  assert.deepEqual(names, ["audit_memory", "ingest_memory", "memory_count", "recall_memory"]);
  for (const s of SKILLS) {
    assert.ok(s.description.length > 20, `${s.name} needs a real description`);
    assert.equal(s.parameters.type, "object");
    assert.ok(s.parameters.properties, `${s.name} needs properties`);
  }
  // recall requires a question; ingest requires content + kind.
  assert.deepEqual(getSkill("recall_memory").parameters.required, ["question"]);
  assert.deepEqual(getSkill("ingest_memory").parameters.required, ["content", "kind"]);
  // kind is a sharp enum, not free text.
  const kindEnum = (getSkill("ingest_memory").parameters.properties.kind as { enum: string[] }).enum;
  assert.deepEqual([...kindEnum].sort(), [...MEMORY_KINDS].sort());
});

test("getSkill throws on an unknown skill name", () => {
  assert.throws(() => getSkill("nope" as never), /Unknown skill/);
});

test("dispatch ingest_memory → writes one embedded memory and returns its id", async () => {
  const res = (await dispatcher.dispatch("ingest_memory", {
    company: "Helios Retail",
    content: "P&L for Helios Retail 2026-02: revenue 120000, operating profit 22000.",
    kind: "insight",
  })) as { written: number; id: string };
  assert.equal(res.written, 1);
  assert.ok(typeof res.id === "string" && res.id.length > 0);
  const count = (await dispatcher.dispatch("memory_count", {})) as { count: number };
  assert.equal(count.count, 1);
});

test("dispatch recall_memory → grounded answer + citations from stored memory", async () => {
  await dispatcher.dispatch("ingest_memory", {
    company: "ByteCraft Software",
    content: "Revenue for ByteCraft Software 2026-05 was 210000 euros.",
    kind: "document",
  });
  const res = (await dispatcher.dispatch("recall_memory", {
    company: "ByteCraft Software",
    question: "What was ByteCraft Software revenue?",
  })) as { answer: string; citations: unknown[]; modelId: string; consistency: unknown };
  assert.ok(res.answer.length > 0);
  assert.ok(Array.isArray(res.citations) && res.citations.length >= 1);
  assert.equal(res.modelId, "fake-narrator");
  assert.ok(res.consistency, "recall carries a best-effort self-audit");
});

test("dispatch audit_memory → returns a read-only consistency report", async () => {
  await dispatcher.dispatch("ingest_memory", {
    company: "Helios Retail",
    content: "Invoice INV-1 total 18400 for Helios Retail.",
    kind: "document",
  });
  const report = (await dispatcher.dispatch("audit_memory", { company: "Helios Retail" })) as {
    contradictions: unknown[];
  };
  assert.ok(report, "an audit report is returned");
  assert.ok(Array.isArray(report.contradictions));
});

test("dispatch memory_count → the current memory size", async () => {
  const res = (await dispatcher.dispatch("memory_count", {})) as { count: number };
  assert.equal(res.count, 0);
});

test("dispatch rejects an unknown skill and missing required args", async () => {
  await assert.rejects(() => dispatcher.dispatch("frobnicate", {}), /Unknown skill/);
  await assert.rejects(() => dispatcher.dispatch("recall_memory", {}), /question/);
  await assert.rejects(() => dispatcher.dispatch("ingest_memory", { content: "x" }), /kind/);
});

test("skillTools projects the catalogue as OpenAI-compatible function tools", () => {
  const tools = skillTools(dispatcher);
  assert.equal(tools.length, SKILLS.length);
  for (const t of tools) {
    assert.equal(t.type, "function");
    assert.ok(t.function.name && t.function.parameters);
  }
});

// A scripted tool-calling client: turn 1 asks for a recall, turn 2 (after it sees
// the tool result) returns a grounded final answer. Proves the loop dispatches a
// real skill and feeds the result back — with no network and no key.
class ScriptedChatClient implements ToolCallingChatClient {
  public calls: ToolChatArgs[] = [];
  chat = {
    completions: {
      create: async (args: ToolChatArgs): Promise<ToolChatResponse> => {
        this.calls.push(args);
        const sawToolResult = args.messages.some((m) => m.role === "tool");
        if (!sawToolResult) {
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "recall_memory",
                        arguments: JSON.stringify({ question: "revenue?", company: "ByteCraft Software" }),
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        return { choices: [{ message: { content: "ByteCraft Software revenue was 210000 euros [1]." } }] };
      },
    },
  };
}

test("runSkillLoop: qwen-plus invokes a skill then grounds its final answer", async () => {
  await dispatcher.dispatch("ingest_memory", {
    company: "ByteCraft Software",
    content: "Revenue for ByteCraft Software 2026-05 was 210000 euros.",
    kind: "document",
  });
  const client = new ScriptedChatClient();
  const out = await runSkillLoop(client, dispatcher, "What was ByteCraft revenue?", { model: "qwen-plus" });

  assert.equal(out.turns, 2, "one tool turn + one final-answer turn");
  assert.equal(out.invocations.length, 1);
  assert.equal(out.invocations[0]!.name, "recall_memory");
  assert.match(out.answer, /210000/);
  // The loop advertised the skills as tools to the model.
  assert.ok(client.calls[0]!.tools && client.calls[0]!.tools.length === SKILLS.length);
});

test("runSkillLoop: returns the model's answer directly when it calls no skill", async () => {
  const client: ToolCallingChatClient = {
    chat: {
      completions: {
        create: async (): Promise<ToolChatResponse> => ({
          choices: [{ message: { content: "No memory lookup needed." } }],
        }),
      },
    },
  };
  const out = await runSkillLoop(client, dispatcher, "hello", {});
  assert.equal(out.turns, 1);
  assert.equal(out.invocations.length, 0);
  assert.equal(out.answer, "No memory lookup needed.");
});

test("runSkillLoop: stops at the turn budget if the model keeps calling skills", async () => {
  // A client that ALWAYS asks for memory_count — exercises the maxTurns guard.
  const client: ToolCallingChatClient = {
    chat: {
      completions: {
        create: async (): Promise<ToolChatResponse> => ({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "c", type: "function", function: { name: "memory_count", arguments: "" } },
                ],
              },
            },
          ],
        }),
      },
    },
  };
  const out = await runSkillLoop(client, dispatcher, "loop forever", { maxTurns: 3 });
  assert.equal(out.turns, 3);
  assert.equal(out.invocations.length, 3);
  assert.match(out.answer, /maximum number of skill-calling turns/);
});
