// End-to-end test — the guarantee the live demo needs: EVERY template chip the
// explorer ships is answerable from the /demo/seed data with a grounded, CITED
// answer (never the "no relevant memories" fallback). This is the "check the
// templates in the pipeline" contract: seed the demo, then drive each template
// question through the REAL /recall route and assert a non-empty, cited answer.
//
// Fully OFFLINE and DB-free: buildServer() is handed an InMemoryStore +
// FakeEmbedder + FakeNarrator, so the DB-backed routes (/demo/seed, /recall,
// /memory/list) run end-to-end through Fastify's in-process inject with NO
// database and NO DashScope key. Runs in every CI lane (not gated on DATABASE_URL).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { UI_HTML } from "../../src/ui.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { DEMO_TEMPLATES } from "../../src/demo-data.js";

// The narrator's zero-evidence fallback (src/agents/narrator.ts). A grounded
// answer must never equal this — asserting citations.length >= 1 already excludes
// it, but we check the string too for an unambiguous failure message.
const NO_MEMORY = "No relevant memories found in the agent's persistent memory.";

let app: FastifyInstance;

before(async () => {
  // Force the offline Fakes regardless of the caller's environment.
  delete process.env.DASHSCOPE_API_KEY;
  app = await buildServer({
    store: new InMemoryStore(),
    embedder: new FakeEmbedder(),
    narrator: new FakeNarrator(),
  });
  await app.ready();

  // Seed the demo memories through the real /demo/seed route (the same path the
  // "Run demo" button and the live-box seed command hit).
  const seed = await app.inject({ method: "POST", url: "/demo/seed" });
  assert.equal(seed.statusCode, 200, "seeding the demo data failed");
  const count = await app.inject({ method: "GET", url: "/memory/count" });
  assert.ok(count.json().count > 0, "demo seed wrote no memories");
});

after(async () => {
  await app.close();
});

test("there is at least one template chip to verify", () => {
  assert.ok(DEMO_TEMPLATES.length > 0, "DEMO_TEMPLATES is empty — no chips ship");
});

// The core guarantee: every shipped chip → grounded, cited answer from the seed.
for (const t of DEMO_TEMPLATES) {
  test(`template "${t.q}" → grounded, cited answer (not the no-memory fallback)`, async () => {
    const res = await app.inject({
      method: "POST",
      url: "/recall",
      payload: { question: t.q, company: t.c },
    });
    assert.equal(res.statusCode, 200, `recall failed for "${t.q}"`);
    const body = res.json();

    // 1. A real, non-empty answer — never the zero-evidence fallback.
    assert.ok(typeof body.answer === "string" && body.answer.length > 0, "empty answer");
    assert.notEqual(body.answer, NO_MEMORY, `"${t.q}" returned the no-relevant-memories fallback`);

    // 2. At least one citation — the answer is GROUNDED in stored memory.
    assert.ok(Array.isArray(body.citations) && body.citations.length >= 1, `"${t.q}" has no citations`);

    // 3. Every citation is actually referenced in the answer text ([1], [2], …).
    for (const c of body.citations) {
      assert.ok(body.answer.includes(c.marker), `answer for "${t.q}" is missing citation marker ${c.marker}`);
      assert.ok(typeof c.content === "string" && c.content.length > 0, "citation has no content");
    }
  });
}

// Every shipped chip must exist verbatim in the served page — proves the chips a
// judge sees are exactly the questions this test verified (no drift, and the
// template injection into UI_HTML actually shipped).
test("the served UI ships each verified template question verbatim (no drift)", () => {
  for (const t of DEMO_TEMPLATES) {
    assert.ok(UI_HTML.includes(t.q), `served UI is missing the chip "${t.q}"`);
  }
});

// Negative control — proves the test has teeth: a question scoped to a company
// the seed never wrote finds nothing, so recall returns the no-memory fallback
// with zero citations. If THIS ever returned a cited answer, the assertions above
// would be meaningless.
test("negative control: a non-seeded company yields the no-memory fallback (test has teeth)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/recall",
    payload: { question: DEMO_TEMPLATES[0]!.q, company: "No Such Company ZZZ" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.citations.length, 0, "expected zero citations for an unseeded company");
  assert.equal(body.answer, NO_MEMORY);
});

// GET /memory/list shape — the browse view's contract. Each row carries the
// fields the explorer's browse panel renders (kind · company · snippet · when).
test("GET /memory/list returns the browse-view shape { count, items[] }", async () => {
  const res = await app.inject({ method: "GET", url: "/memory/list?limit=50" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.count === "number", "count is not a number");
  assert.ok(Array.isArray(body.items) && body.items.length > 0, "items is empty");
  assert.equal(body.count, body.items.length, "count must match items length");
  for (const m of body.items) {
    for (const field of ["id", "kind", "company", "snippet", "createdAt"]) {
      assert.ok(field in m, `memory/list row is missing "${field}"`);
    }
    assert.ok("period" in m, "memory/list row is missing period");
  }
});
