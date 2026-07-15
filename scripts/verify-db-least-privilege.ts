// Fail-closed deployment proof for the long-lived database principal. This
// script receives only the runtime DATABASE_URL; it never needs bootstrap/admin
// credentials. CROSS_APP_DATABASE_NAME optionally proves that the same runtime
// credentials cannot enter the neighbouring app database.

import { Client } from "pg";
import {
  MEMORY_RUNTIME_ROLE,
  assertRuntimeDatabaseUrl,
  deriveCrossDatabaseUrl,
} from "../src/db/least-privilege.js";
import { sanitizedOperationalFailure } from "../src/server/error-sanitization.js";

interface RoleProof {
  database_name: string;
  role_name: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  has_membership: boolean;
  can_connect: boolean;
  can_temp: boolean;
  can_schema_usage: boolean;
  can_schema_create: boolean;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
  owns_schema: boolean;
  owns_table: boolean;
  owns_database: boolean;
  owns_any_public_object: boolean;
}

async function main() {
  const runtimeUrl = process.env.DATABASE_URL;
  if (!runtimeUrl) throw new Error("DATABASE_URL is required for role verification");
  assertRuntimeDatabaseUrl(runtimeUrl);

  const client = new Client({
    connectionString: runtimeUrl,
    application_name: "archon-qwen-memoryagent-role-verifier",
  });
  await client.connect();
  try {
    const proof = await client.query<RoleProof>(
      `SELECT
         current_database() AS database_name,
         current_user AS role_name,
         r.rolsuper,
         r.rolcreatedb,
         r.rolcreaterole,
         r.rolinherit,
         r.rolreplication,
         r.rolbypassrls,
         EXISTS (
           SELECT 1 FROM pg_auth_members membership WHERE membership.member = r.oid
         ) AS has_membership,
         has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
         has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp,
         has_schema_privilege(current_user, 'public', 'USAGE') AS can_schema_usage,
         has_schema_privilege(current_user, 'public', 'CREATE') AS can_schema_create,
         has_table_privilege(current_user, 'public.agent_memory', 'SELECT') AS can_select,
         has_table_privilege(current_user, 'public.agent_memory', 'INSERT') AS can_insert,
         has_table_privilege(current_user, 'public.agent_memory', 'UPDATE') AS can_update,
         has_table_privilege(current_user, 'public.agent_memory', 'DELETE') AS can_delete,
         has_table_privilege(current_user, 'public.agent_memory', 'TRUNCATE') AS can_truncate,
         pg_get_userbyid(n.nspowner) = current_user AS owns_schema,
         pg_get_userbyid(c.relowner) = current_user AS owns_table,
         EXISTS (
           SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid
         ) AS owns_database,
         EXISTS (
           SELECT 1 FROM pg_class owned
           JOIN pg_namespace owned_namespace ON owned_namespace.oid = owned.relnamespace
           WHERE owned_namespace.nspname = 'public' AND owned.relowner = r.oid
         ) AS owns_any_public_object
       FROM pg_roles r
       JOIN pg_namespace n ON n.nspname = 'public'
       JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'agent_memory'
       WHERE r.rolname = current_user`,
    );
    const row = proof.rows[0];
    if (!row) throw new Error("runtime role proof is unavailable");
    if (
      row.role_name !== MEMORY_RUNTIME_ROLE ||
      row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolinherit ||
      row.rolreplication || row.rolbypassrls || row.has_membership || !row.can_connect || row.can_temp ||
      !row.can_schema_usage || row.can_schema_create || !row.can_select ||
      !row.can_insert || !row.can_update || !row.can_delete || row.can_truncate ||
      row.owns_schema || row.owns_table || row.owns_database || row.owns_any_public_object
    ) {
      throw new Error("runtime database role violates the least-privilege contract");
    }
    console.log(`✓ ${MEMORY_RUNTIME_ROLE} has DML-only access to the MemoryAgent schema`);
  } finally {
    await client.end();
  }

  const crossDatabase = process.env.CROSS_APP_DATABASE_NAME?.trim();
  if (crossDatabase) await verifyCrossDatabaseDenied(runtimeUrl, crossDatabase);
}

async function verifyCrossDatabaseDenied(runtimeUrl: string, crossDatabase: string): Promise<void> {
  const connectionString = deriveCrossDatabaseUrl(
    runtimeUrl,
    crossDatabase,
    process.env.CROSS_APP_DATABASE_HOST?.trim() || undefined,
    process.env.CROSS_APP_DATABASE_PORT?.trim() || undefined,
  );
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    application_name: "archon-qwen-memoryagent-cross-db-denial-probe",
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (error) {
    try {
      await client.end();
    } catch {
      // The denial is already established; never replace it with close noise.
    }
    const code = databaseErrorCode(error);
    // Same-cluster ACL denial is 42501. For an independently hosted app DB,
    // invalid authorization proves that these credentials have no account there.
    if (["42501", "28000", "28P01"].includes(code)) {
      console.log(`✓ ${MEMORY_RUNTIME_ROLE} is denied cross-app database access`);
      return;
    }
    throw new Error("cross-app database denial could not be established");
  }
  await client.end();
  throw new Error("runtime role unexpectedly connected to the cross-app database");
}

function databaseErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

main().catch((error) => {
  console.error("Database role verification failed", sanitizedOperationalFailure("db_role_verify", error));
  process.exit(1);
});
