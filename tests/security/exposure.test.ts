// PEN-TEST — Sensitive-data exposure & error leakage (OWASP API8 Security
// Misconfiguration / LLM02 Sensitive Information Disclosure / CWE-209 error
// leakage). The invariant: no route leaks server internals. A server-side fault
// returns an opaque typed envelope with correlation ids and NO exception message,
// stack trace, source path, connection string, or provider payload. Validation
// errors remain useful 4xx responses; /health exposes only model ids + embedding
// dimension — never a key, secret, token, or password. Fully OFFLINE (Fakes, no
// DB, no DASHSCOPE key — no real credential is ever in scope).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { InMemoryStore, type MemoryStore } from "../../src/memory/store.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { FakeJudge } from "../../src/memory/semantic-consistency.js";

function offlineServer(store: MemoryStore): Promise<FastifyInstance> {
  delete process.env.DASHSCOPE_API_KEY;
  return buildServer({ store, embedder: new FakeEmbedder(), narrator: new FakeNarrator(), judge: new FakeJudge() });
}

// A store whose every method rejects — simulates the memory layer being
// unreachable, the path that flows through the generic error handler.
function unreachableStore(): MemoryStore {
  const boom = async () => {
    throw new Error(
      "memory store unreachable at C:\\srv\\secret.ts:73 postgres://admin:password@db/private?api_key=sk-not-a-real-key",
    );
  };
  return new Proxy({}, { get: () => boom }) as unknown as MemoryStore;
}

// Patterns that must NEVER appear in a response body.
const STACK_FRAME = /\n\s*at\s+/; // V8 stack frame
const SOURCE_PATH = /(?:[A-Za-z]:\\|\/)[^\s"]*\.(?:ts|js):\d+/; // file.ts:123 with a path
const SECRETISH = /(sk-[A-Za-z0-9]{8,}|"?(?:api[_-]?key|secret|password|token)"?\s*[:=])/i;
const CONN_STRING = /postgres(?:ql)?:\/\/[^\s"]+/i;

describe("Exposure: a server-side fault returns a graceful envelope, no internals", () => {
  test("GET /memory/count on an unreachable store → generic correlated 503 with no internals", async () => {
    const app = await offlineServer(unreachableStore());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/memory/count" });
    await app.close();

    assert.equal(res.statusCode, 503, "an internal fault maps to a 503, not a 200 or a hang");
    const body = res.json();
    assert.equal(body.error, "service temporarily unavailable");
    assert.equal(typeof body.requestId, "string", "the response must carry a request correlation id");
    assert.match(body.errorId, /^[0-9a-f-]{36}$/i, "the response must carry an opaque error id");
    assert.equal(body.stack, undefined, "the envelope must not carry a stack property");
    // The raw payload must not leak even the exception message, much less its
    // V8 stack, source path, connection string, or fake credential sentinel.
    assert.doesNotMatch(res.payload, /memory store unreachable/i, "response leaked the exception message");
    assert.doesNotMatch(res.payload, STACK_FRAME, "response leaked a stack frame");
    assert.doesNotMatch(res.payload, SOURCE_PATH, "response leaked a source path");
    assert.doesNotMatch(res.payload, CONN_STRING, "response leaked a connection string");
    assert.doesNotMatch(res.payload, SECRETISH, "response leaked credential-shaped data");
  });

  test("POST /recall on an unreachable store → error envelope, still no internals", async () => {
    const app = await offlineServer(unreachableStore());
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/recall", payload: { question: "hello" } });
    await app.close();
    assert.ok(res.statusCode >= 500, "an embedder/store outage during recall surfaces as a 5xx, not a 200");
    assert.equal(res.json().error, "service temporarily unavailable");
    assert.equal(typeof res.json().requestId, "string");
    assert.match(res.json().errorId, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(res.payload, /memory store unreachable/i);
    assert.doesNotMatch(res.payload, STACK_FRAME);
    assert.doesNotMatch(res.payload, SOURCE_PATH);
    assert.doesNotMatch(res.payload, CONN_STRING);
  });
});

describe("Exposure: client-error envelopes are equally opaque", () => {
  test("a 400 validation error is a typed { error } with no stack / path", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/ingest", payload: {} });
    await app.close();
    assert.equal(res.statusCode, 400);
    assert.equal(typeof res.json().error, "string");
    assert.doesNotMatch(res.payload, STACK_FRAME);
    assert.doesNotMatch(res.payload, SOURCE_PATH);
  });
});

describe("Exposure: /health reveals model ids only — never a credential", () => {
  test("health carries status + model ids + dim, and no key/secret/token/password", async () => {
    const app = await offlineServer(new InMemoryStore());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();
    assert.equal(res.statusCode, 200);
    const h = res.json();
    assert.equal(h.status, "ok");
    assert.equal(typeof h.embedder, "string");
    assert.equal(typeof h.narrator, "string");
    assert.ok(Number.isInteger(h.embedDim));
    // No property leaks a credential.
    assert.doesNotMatch(res.payload, SECRETISH, "/health must not expose a key/secret/token/password field");
    assert.doesNotMatch(res.payload, /sk-[A-Za-z0-9]{8,}/, "/health must not expose an API key value");
  });
});
