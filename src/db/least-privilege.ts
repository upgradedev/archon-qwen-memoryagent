export const MEMORY_RUNTIME_ROLE = "memoryagent_app";
export const DEFAULT_MEMORY_DATABASE = "memoryagent";

const SAFE_DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SAFE_ROLE_PASSWORD = /^[A-Za-z0-9._~-]{32,128}$/;

export function assertSafeDatabaseName(value: string, label = "database name"): string {
  if (!SAFE_DATABASE_NAME.test(value)) {
    throw new Error(`${label} must be a safe PostgreSQL identifier`);
  }
  return value;
}

export function assertRuntimeRolePassword(value: string | undefined): string {
  if (!value || !SAFE_ROLE_PASSWORD.test(value)) {
    throw new Error("MEMORY_APP_DB_PASSWORD must be 32-128 URL-safe characters");
  }
  return value;
}

export function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function quoteSqlLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("SQL literal cannot contain NUL");
  return `'${value.replace(/'/g, "''")}'`;
}

export function assertRuntimeDatabaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("runtime DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    decodeURIComponent(parsed.username) !== MEMORY_RUNTIME_ROLE ||
    !parsed.password || !parsed.hostname || !parsed.pathname.slice(1)
  ) {
    throw new Error(`runtime DATABASE_URL must authenticate as ${MEMORY_RUNTIME_ROLE}`);
  }
  return parsed;
}

export function deriveCrossDatabaseUrl(
  runtimeUrl: string,
  databaseName: string,
  host?: string,
  port?: string,
): string {
  const parsed = assertRuntimeDatabaseUrl(runtimeUrl);
  parsed.pathname = `/${assertSafeDatabaseName(databaseName, "cross-app database name")}`;
  if (host) parsed.hostname = host;
  if (port) {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) {
      throw new Error("cross-app database port must be an integer from 1 to 65535");
    }
    parsed.port = String(numeric);
  }
  return parsed.toString();
}
