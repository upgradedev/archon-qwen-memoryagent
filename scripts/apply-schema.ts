// Apply src/db/schema.sql with a bootstrap/migration connection, then grant the
// minimum runtime privileges to memoryagent_app. The long-lived application
// must receive only DATABASE_URL; MIGRATION_DATABASE_URL and
// MEMORY_APP_DB_PASSWORD belong to this one-shot job.
//
//   MIGRATION_DATABASE_URL=postgresql://<admin>@host/memoryagent \
//   MEMORY_APP_DB_PASSWORD=<32+ URL-safe chars> npm run db:schema

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";
import {
  MEMORY_RUNTIME_ROLE,
  assertRuntimeRolePassword,
  assertSafeDatabaseName,
  quoteSqlIdentifier,
  quoteSqlLiteral,
} from "../src/db/least-privilege.js";
import { sanitizedOperationalFailure } from "../src/server/error-sanitization.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "src", "db", "schema.sql");
const SCHEMA_LOCK = "archon-memoryagent-schema-v1";

async function main() {
  const connectionString = migrationDatabaseUrl();
  const sql = readFileSync(schemaPath, "utf8");
  const client = new Client({
    connectionString,
    application_name: "archon-qwen-memoryagent-migration",
  });
  await client.connect();
  console.log(`Applying schema → ${redactUrl(connectionString)}`);

  // Strip `--` comment lines first (a comment may contain a semicolon), then
  // split on `;`. This schema deliberately has no semicolons inside literals.
  const statements = stripComments(sql)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  let locked = false;
  let inTransaction = false;
  try {
    // Multiple deploy jobs can overlap. Serialize the idempotent DDL and the
    // grants so no application instance can observe a half-applied schema.
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [SCHEMA_LOCK]);
    locked = true;
    await client.query("BEGIN");
    inTransaction = true;
    for (const statement of statements) await client.query(statement);

    const password = process.env.MEMORY_APP_DB_PASSWORD;
    if (password) {
      await provisionRuntimeRole(client, assertRuntimeRolePassword(password));
    } else if (process.env.NODE_ENV === "production") {
      throw new Error("MEMORY_APP_DB_PASSWORD is required for production schema application");
    } else {
      console.warn(
        "Runtime grants skipped: set MEMORY_APP_DB_PASSWORD to provision the least-privilege role.",
      );
    }

    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const index = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'agent_memory' AND indexname = 'idx_agent_memory_embedding' LIMIT 1`,
    );
    if (!index.rowCount) throw new Error("vector index idx_agent_memory_embedding is missing");
    await client.query("COMMIT");
    inTransaction = false;
    console.log("Tables:", rows.map((row) => row.table_name).join(", "));
    console.log("✓ vector index idx_agent_memory_embedding present");
    if (password) console.log(`✓ least-privilege runtime role ${MEMORY_RUNTIME_ROLE} provisioned`);
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original migration failure; closing ends any transaction.
      }
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [SCHEMA_LOCK]);
      } catch {
        // Closing the session below is the PostgreSQL-guaranteed fallback.
      }
    }
    await client.end();
  }
}

function migrationDatabaseUrl(): string {
  const raw = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!raw) throw new Error("MIGRATION_DATABASE_URL is required for schema application");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("migration database URL is invalid");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error("migration database URL must use PostgreSQL and name a host/database");
  }
  if (decodeURIComponent(parsed.username) === MEMORY_RUNTIME_ROLE) {
    throw new Error("schema application refuses the runtime database role");
  }
  return raw;
}

async function provisionRuntimeRole(client: Client, password: string): Promise<void> {
  const context = await client.query<{ database_name: string; migration_role: string }>(
    `SELECT current_database() AS database_name, current_user AS migration_role`,
  );
  const row = context.rows[0];
  if (!row) throw new Error("migration database context is unavailable");
  const databaseName = assertSafeDatabaseName(row.database_name, "current database name");
  const runtimeRole = quoteSqlIdentifier(MEMORY_RUNTIME_ROLE);
  const database = quoteSqlIdentifier(databaseName);
  const migrationRole = quoteSqlIdentifier(row.migration_role);

  // PostgreSQL does not parameterize role identifiers/passwords in DDL. The
  // identifier is fixed and the password has a strict URL-safe grammar before
  // being defensively SQL-quoted.
  const exists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
    [MEMORY_RUNTIME_ROLE],
  );
  if (!exists.rows[0]?.exists) {
    await client.query(`CREATE ROLE ${runtimeRole} LOGIN`);
  }
  const memberships = await client.query<{ granted_role: string }>(
    `SELECT granted.rolname AS granted_role
       FROM pg_auth_members membership
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles granted ON granted.oid = membership.roleid
      WHERE member.rolname = $1`,
    [MEMORY_RUNTIME_ROLE],
  );
  for (const membership of memberships.rows) {
    await client.query(
      `REVOKE ${quoteSqlIdentifier(membership.granted_role)} FROM ${runtimeRole}`,
    );
  }
  await client.query(
    `ALTER ROLE ${runtimeRole}
       LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
       CONNECTION LIMIT 50 PASSWORD ${quoteSqlLiteral(password)}`,
  );

  const ownership = await client.query<{ unsafe_owner: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_database d
          JOIN pg_roles r ON r.oid = d.datdba
         WHERE d.datname = current_database() AND r.rolname = $1
       ) OR EXISTS (
         SELECT 1 FROM pg_namespace n
          JOIN pg_roles r ON r.oid = n.nspowner
         WHERE n.nspname = 'public' AND r.rolname = $1
       ) OR EXISTS (
         SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_roles r ON r.oid = c.relowner
         WHERE n.nspname = 'public' AND r.rolname = $1
       ) AS unsafe_owner`,
    [MEMORY_RUNTIME_ROLE],
  );
  if (ownership.rows[0]?.unsafe_owner) {
    throw new Error("runtime role already owns database/schema objects; manual reassignment is required");
  }

  // CONNECT is an allow-list. Revoking it from PUBLIC is essential: PostgreSQL
  // privileges are additive, so a role-specific REVOKE cannot override PUBLIC.
  await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
  await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${runtimeRole}`);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtimeRole}`);

  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${runtimeRole}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${runtimeRole}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`,
  );
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${runtimeRole}`);
  await client.query(
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`,
  );

  // Future migrations owned by this migration principal inherit the same
  // boundary. Runtime never owns schema objects and receives no DDL/TRUNCATE.
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationRole} IN SCHEMA public
       REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationRole} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationRole} IN SCHEMA public
       REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrationRole} IN SCHEMA public
       GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtimeRole}`,
  );

  const crossDatabaseRaw = process.env.CROSS_APP_DATABASE_NAME?.trim();
  if (crossDatabaseRaw) {
    const crossDatabaseName = assertSafeDatabaseName(crossDatabaseRaw, "cross-app database name");
    if (crossDatabaseName === databaseName) {
      throw new Error("cross-app database must differ from the MemoryAgent database");
    }
    if (process.env.CROSS_APP_DATABASE_HOST?.trim()) {
      // A separately hosted application owns its own bootstrap ACLs. This
      // migration never receives that server's admin credentials; the runtime
      // verifier proves these Memory credentials are rejected there instead.
      return;
    }
    const crossExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [crossDatabaseName],
    );
    if (!crossExists.rows[0]?.exists) {
      throw new Error("configured cross-app database does not exist");
    }
    const crossDatabase = quoteSqlIdentifier(crossDatabaseName);
    await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${crossDatabase} FROM PUBLIC`);
    await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${crossDatabase} FROM ${runtimeRole}`);
  }
}

function redactUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<invalid database URL>";
  }
}

function stripComments(fragment: string): string {
  return fragment
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

main().catch((error) => {
  console.error("Schema apply failed", sanitizedOperationalFailure("schema_apply", error));
  process.exit(1);
});
