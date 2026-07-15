// Remove only the deployment smoke rows through the same DML-only runtime role
// used by the backend. Works for local Compose and external managed PostgreSQL;
// no migration/bootstrap credentials are accepted.

import { Client } from "pg";
import { assertRuntimeDatabaseUrl } from "../src/db/least-privilege.js";
import { sanitizedOperationalFailure } from "../src/server/error-sanitization.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for smoke cleanup");
  assertRuntimeDatabaseUrl(databaseUrl);
  const tenant = requiredScopedValue("SMOKE_TENANT", 128);
  const company = requiredScopedValue("SMOKE_COMPANY", 64);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "archon-qwen-memoryagent-smoke-cleanup",
  });
  await client.connect();
  try {
    const result = await client.query(
      `DELETE FROM agent_memory WHERE tenant_id = $1 AND company = $2`,
      [tenant, company],
    );
    console.log(`✓ deployment smoke cleanup removed ${result.rowCount ?? 0} row(s)`);
  } finally {
    await client.end();
  }
}

function requiredScopedValue(name: "SMOKE_TENANT" | "SMOKE_COMPANY", maxLength: number): string {
  const value = process.env[name] ?? "";
  const pattern = new RegExp(`^[A-Za-z0-9_.-]{1,${maxLength}}$`);
  if (!pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

main().catch((error) => {
  console.error("Smoke cleanup failed", sanitizedOperationalFailure("smoke_cleanup", error));
  process.exit(1);
});
