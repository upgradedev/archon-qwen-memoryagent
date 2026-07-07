// Narrator unit tests — NO database, NO DashScope key. Cover the grounded/cited
// answer composition (FakeNarrator), the offline auto-selection, and that
// QwenNarrator reuses the injectable OpenAI-compatible client correctly (canned)
// and short-circuits on empty recall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeNarrator, QwenNarrator, defaultNarrator } from "../../src/agents/narrator.js";
import type { RecallHit } from "../../src/memory/store.js";
import type { QwenChatClient } from "../../src/qwen/client.js";

const HITS: RecallHit[] = [
  {
    id: "m1",
    kind: "insight",
    company: "Acme Foods AE",
    period: "2026-03",
    sourceRef: "evt-acme-2026-03",
    content:
      "Off-bank payroll cost at Acme Foods AE for 2026-03: the bank salary transfer of " +
      "€41,000 understates the true employer cost by €22,800 (28.8%).",
    metadata: null,
    createdAt: "2026-03-31T00:00:00Z",
    distance: 0.1,
    score: 0.9,
  },
  {
    id: "m2",
    kind: "payroll_event",
    company: "Acme Foods AE",
    period: "2026-03",
    sourceRef: "evt-acme-2026-03",
    content:
      "Payroll for Acme Foods AE in 2026-03: 3 employees, true employer cost €63,800, " +
      "net paid from bank €41,000.",
    metadata: null,
    createdAt: "2026-03-31T00:00:00Z",
    distance: 0.2,
    score: 0.8,
  },
];

test("FakeNarrator grounds the answer in every recalled memory and cites each", async () => {
  const { answer, citations, modelId } = await new FakeNarrator().narrate(
    "What was our real employer payroll cost last month?",
    HITS
  );
  assert.equal(modelId, "fake-narrator");
  assert.equal(citations.length, 2);
  for (const c of citations) assert.ok(answer.includes(c.marker), `missing marker ${c.marker}`);
  assert.ok(answer.includes("€63,800"), "answer must cite the true employer cost");
  assert.ok(answer.includes("€22,800"), "answer must surface the off-bank-cost wedge");
});

test("FakeNarrator returns the no-memory answer (no citations) on empty recall", async () => {
  const { answer, citations } = await new FakeNarrator().narrate("anything", []);
  assert.equal(citations.length, 0);
  assert.match(answer, /No relevant memories/i);
});

test("defaultNarrator selects the offline FakeNarrator without a DashScope key", () => {
  const saved = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  try {
    assert.equal(defaultNarrator().modelId, "fake-narrator");
  } finally {
    if (saved !== undefined) process.env.DASHSCOPE_API_KEY = saved;
  }
});

test("QwenNarrator sends recalled memories to the chat model and returns its cited answer", async () => {
  let capturedUser = "";
  let capturedModel = "";
  const canned: QwenChatClient = {
    chat: {
      completions: {
        async create(args) {
          capturedModel = args.model;
          capturedUser = args.messages.find((m) => m.role === "user")?.content ?? "";
          return {
            choices: [
              {
                message: {
                  content:
                    "True employer cost was €63,800 [2], of which €22,800 is off the bank transfer [1].",
                },
              },
            ],
          };
        },
      },
    },
  };
  const n = new QwenNarrator(canned, "qwen-plus");
  const { answer, citations, modelId } = await n.narrate(
    "What was our real employer payroll cost last month?",
    HITS
  );
  assert.equal(modelId, "qwen-plus");
  assert.equal(capturedModel, "qwen-plus");
  assert.equal(citations.length, 2);
  assert.ok(capturedUser.includes("€63,800"), "prompt must include recalled memory");
  assert.ok(capturedUser.includes("real employer payroll cost"), "prompt must include the question");
  assert.ok(answer.includes("€63,800"));
});

test("QwenNarrator short-circuits on empty recall without calling the model", async () => {
  let called = false;
  const canned: QwenChatClient = {
    chat: {
      completions: {
        async create() {
          called = true;
          return { choices: [] };
        },
      },
    },
  };
  const { answer, citations } = await new QwenNarrator(canned).narrate("anything", []);
  assert.equal(called, false, "must not call Qwen when there is no evidence");
  assert.equal(citations.length, 0);
  assert.match(answer, /No relevant memories/i);
});
