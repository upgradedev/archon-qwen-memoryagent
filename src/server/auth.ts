import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_PUBLIC_TENANT = "_public";

export interface JudgePrincipal {
  tenantId: string;
  role: "judge";
}

export interface JudgeAuthOptions {
  /** Production defaults to true. Set false only for an isolated local/test server. */
  required?: boolean;
  /** Map tenant id -> secret. The tenant is derived from the matching secret. */
  apiKeys?: Record<string, string>;
  publicTenantId?: string;
}

export interface JudgeAuthConfig {
  required: boolean;
  apiKeys: ReadonlyArray<{ tenantId: string; digest: Buffer }>;
  publicTenantId: string;
  /** Per-process pepper: configured API keys are never retained as plaintext digests. */
  digestKey: Buffer;
}

export type AuthResult =
  | { ok: true; principal: JudgePrincipal }
  | { ok: false; statusCode: 401 | 503; error: string };

export function loadJudgeAuth(options: JudgeAuthOptions = {}): JudgeAuthConfig {
  const requestedRequired = options.required ?? envFlag("JUDGE_AUTH_REQUIRED", process.env.NODE_ENV === "production");
  // Production mutation auth cannot be disabled by a mistyped/unsafe runtime
  // override. Explicit opt-out remains available only to isolated local tests.
  const required = process.env.NODE_ENV === "production" ? true : requestedRequired;
  const publicTenantId = normalizeTenantId(
    options.publicTenantId ?? process.env.PUBLIC_TENANT_ID ?? DEFAULT_PUBLIC_TENANT,
  );
  const configured = options.apiKeys ?? readKeysFromEnvironment();
  const digestKey = randomBytes(32);
  const apiKeys: Array<{ tenantId: string; digest: Buffer }> = [];
  const tenants = new Set<string>();
  const secrets = new Set<string>();
  const minimumCredentialLength = process.env.NODE_ENV === "production" ? 32 : 16;
  for (const [rawTenantId, key] of Object.entries(configured)) {
    if (typeof key !== "string" || key.length < minimumCredentialLength) {
      throw new Error(`judge credentials must be strings of at least ${minimumCredentialLength} characters`);
    }
    const tenantId = normalizeTenantId(rawTenantId);
    if (tenants.has(tenantId)) throw new Error("judge credential configuration contains a duplicate tenant");
    if (secrets.has(key)) throw new Error("one judge credential cannot map to multiple tenants");
    tenants.add(tenantId);
    secrets.add(key);
    apiKeys.push({ tenantId, digest: digest(key, digestKey) });
  }
  return { required, apiKeys, publicTenantId, digestKey };
}

/**
 * Authenticate a judge/admin request without trusting any caller-supplied tenant
 * header or request-body field. A credential maps to exactly one server-side
 * tenant id; this is the principal that every protected store query receives.
 */
export function authenticateJudge(
  headers: Record<string, string | string[] | undefined>,
  config: JudgeAuthConfig,
): AuthResult {
  if (!config.required) {
    return { ok: true, principal: { tenantId: config.publicTenantId, role: "judge" } };
  }
  if (config.apiKeys.length === 0) {
    return {
      ok: false,
      statusCode: 503,
      error: "judge authentication is required but no judge credential is configured",
    };
  }
  const supplied = extractCredential(headers);
  if (!supplied) {
    return { ok: false, statusCode: 401, error: "judge authentication required" };
  }
  const suppliedDigest = digest(supplied, config.digestKey);
  for (const entry of config.apiKeys) {
    if (timingSafeEqual(suppliedDigest, entry.digest)) {
      return { ok: true, principal: { tenantId: entry.tenantId, role: "judge" } };
    }
  }
  return { ok: false, statusCode: 401, error: "invalid judge credential" };
}

export function normalizeTenantId(value: string): string {
  const tenant = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(tenant)) {
    throw new Error("tenant ids must be 1-64 letters, numbers, dot, underscore or hyphen");
  }
  return tenant;
}

function extractCredential(headers: Record<string, string | string[] | undefined>): string | null {
  const authorization = first(headers.authorization);
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = first(headers["x-api-key"]);
  return apiKey?.trim() || null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readKeysFromEnvironment(): Record<string, string> {
  if (process.env.JUDGE_API_KEYS_JSON) {
    try {
      const parsed = JSON.parse(process.env.JUDGE_API_KEYS_JSON) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      const out: Record<string, string> = {};
      for (const [tenant, key] of Object.entries(parsed)) {
        if (typeof key !== "string") throw new Error(`credential for ${tenant} is not a string`);
        out[tenant] = key;
      }
      return out;
    } catch (err) {
      throw new Error(`JUDGE_API_KEYS_JSON is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (process.env.JUDGE_API_KEY) {
    return { [process.env.JUDGE_TENANT_ID ?? DEFAULT_PUBLIC_TENANT]: process.env.JUDGE_API_KEY };
  }
  return {};
}

function digest(secret: string, digestKey: Buffer): Buffer {
  // Judge credentials are high-entropy API keys, not user-memorable passwords.
  // A per-process keyed digest avoids storing/comparing raw keys and prevents an
  // exposed digest from becoming a reusable offline verifier. Constant-time compare
  // below prevents equality timing leaks.
  return createHmac("sha256", digestKey).update(secret, "utf8").digest();
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
