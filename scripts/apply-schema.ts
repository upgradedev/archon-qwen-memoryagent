// Apply src/db/schema.sql to the pgvector database pointed at by DATABASE_URL.
//
//   npm run db:schema
//
// Idempotent: every statement is IF NOT EXISTS-safe, so it is safe to re-run
// against an existing database (local pgvector docker or Alibaba Cloud PostgreSQL).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool, closePool } from "../src/db/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "src", "db", "schema.sql");

async function main() {
  const sql = readFileSync(schemaPath, "utf8");
  const pool = getPool();
  const client = await pool.connect();
  console.log(`Applying schema → ${redactUrl(process.env.DATABASE_URL!)}`);
  // Strip `--` comment lines FIRST (a comment may contain a semicolon), then
  // split on `;`. This schema has no semicolons inside literals.
  const statements = stripComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  try {
    // FC can cold-start multiple instances concurrently. Serialize idempotent
    // DDL so two starters never race on CREATE INDEX / ALTER TABLE.
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, ["archon-memoryagent-schema-v1"]);
    for (const stmt of statements) await client.query(stmt);
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log("Tables:", rows.map((r) => r.table_name).join(", "));
    const idx = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'agent_memory' AND indexname = 'idx_agent_memory_embedding' LIMIT 1`
    );
    if (!idx.rowCount) throw new Error("vector index idx_agent_memory_embedding is missing");
    console.log("✓ vector index idx_agent_memory_embedding present");
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, ["archon-memoryagent-schema-v1"]);
    } catch {
      // Releasing the session below is the PostgreSQL-guaranteed fallback.
    }
    client.release(); // advisory locks are released with the session
    await closePool();
  }
}

function redactUrl(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}

function stripComments(fragment: string): string {
  return fragment
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

main().catch((err) => {
  console.error("Schema apply failed:", err);
  process.exit(1);
});
