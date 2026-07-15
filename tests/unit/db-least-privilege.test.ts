import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_RUNTIME_ROLE,
  assertRuntimeDatabaseUrl,
  assertRuntimeRolePassword,
  deriveCrossDatabaseUrl,
  quoteSqlIdentifier,
  quoteSqlLiteral,
} from "../../src/db/least-privilege.js";

test("runtime database URL is pinned to the non-superuser Memory role", () => {
  const parsed = assertRuntimeDatabaseUrl(
    "postgresql://memoryagent_app:abcdefghijklmnopqrstuvwxyz-123456@db:5432/memoryagent?sslmode=require",
  );
  assert.equal(decodeURIComponent(parsed.username), MEMORY_RUNTIME_ROLE);
  assert.throws(
    () => assertRuntimeDatabaseUrl("postgresql://postgres:abcdefghijklmnopqrstuvwxyz-123456@db:5432/memoryagent"),
    /memoryagent_app/,
  );
  assert.throws(() => assertRuntimeDatabaseUrl("https://memoryagent_app:secret@example.test/memoryagent"));
});

test("cross-app negative probe derives a URL without changing runtime credentials", () => {
  const runtime = "postgresql://memoryagent_app:abcdefghijklmnopqrstuvwxyz-123456@db:5432/memoryagent?sslmode=require";
  const cross = new URL(deriveCrossDatabaseUrl(runtime, "autopilot", "auto-db.internal", "6432"));
  assert.equal(decodeURIComponent(cross.username), "memoryagent_app");
  assert.equal(decodeURIComponent(cross.password), "abcdefghijklmnopqrstuvwxyz-123456");
  assert.equal(cross.hostname, "auto-db.internal");
  assert.equal(cross.port, "6432");
  assert.equal(cross.pathname, "/autopilot");
  assert.equal(cross.searchParams.get("sslmode"), "require");
  assert.throws(() => deriveCrossDatabaseUrl(runtime, "not/a/db"), /safe PostgreSQL identifier/);
});

test("role provisioning accepts only URL-safe strong secrets and quotes SQL defensively", () => {
  assert.equal(assertRuntimeRolePassword("abcdefghijklmnopqrstuvwxyz-123456"), "abcdefghijklmnopqrstuvwxyz-123456");
  assert.throws(() => assertRuntimeRolePassword("short"), /32-128/);
  assert.equal(quoteSqlIdentifier('memory"db'), '"memory""db"');
  assert.equal(quoteSqlLiteral("a'b"), "'a''b'");
});
