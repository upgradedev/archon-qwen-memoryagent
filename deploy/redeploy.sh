#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# redeploy.sh — ONE-COMMAND, idempotent redeploy of the live MemoryAgent box.
#
# TARGET: the LIVE deployment is ECS + docker compose (backend + a pgvector
# container) — see deploy/DEPLOY_STATE.md ("CHOICE: PATH B — ECS + docker
# compose"). This script drives THAT topology. It is NOT the Function Compute
# path (deploy/deploy-fc.sh / deploy/s.yaml remain the nominal FC architecture;
# FC was tried and set aside — ACR console-only docker-login + FC↔RDS VPC).
#
#   Run it ON the box, in the app dir (default /root/memoryagent):
#     ssh -i <key.pem> root@<box-ip>
#     cd /root/memoryagent && bash deploy/redeploy.sh
#
# WHY THIS EXISTS — the failure mode it prevents:
#   The SOTA schema adds columns (importance, superseded_at, superseded_by) + a
#   FTS index. If new CODE is served BEFORE the schema is migrated, every
#   /ingest and every hybrid /recall 500s. `GET /health` needs no DB, so it
#   passes even then — it does NOT catch this. So this script:
#     1. applies the schema FIRST and ABORTS if that fails (fail-closed),
#     2. only then (re)builds + serves the backend,
#     3. proves it with a real ingest+recall round-trip (not just /health).
#   It is safe to run repeatedly (schema is idempotent; smoke cleans up after
#   itself).
#
# PREREQUISITE — the latest code is already in the app dir. Either path works:
#   • git clone (recommended): the box runs from a clone, so just `git pull` in
#       the app dir before running this script; or
#   • rsync a tarball (the original box was seeded this way):
#       rsync -a --exclude node_modules --exclude .git ./ root@<box-ip>:/root/memoryagent/
# Then run this script. (This script does NOT itself `git pull` or rsync — it
# builds from whatever code is already in the app dir.)
#
# Put DASHSCOPE_API_KEY and judge credentials in the private .env (or export
# them). The production readiness gate rejects offline fakes or missing auth.
# For a legacy Compose volume, first rotate the database role with
# deploy/rotate-compose-db-password.sh; changing POSTGRES_PASSWORD alone does
# not update a role that was initialized in an existing volume.
#
# FLAGS:
#   --truncate --confirm-truncate
#                TRUNCATE agent_memory before smoke. Both flags are required;
#                this is destructive and only supported for the local DB service.
#   --no-smoke   skip the ingest+recall smoke (health-only). Not recommended:
#                the smoke is what proves schema-first actually worked.
#   -h|--help    show this help.
#
# CONFIG (env-overridable):
#   APP_DIR (/root/memoryagent) · DB_SVC (db) · DB_INIT_SVC (db-init)
#   BACKEND_SVC (backend)
#   BASE_URL (http://localhost:9000) · SMOKE_COMPANY (__smoke__)
#   SMOKE_TENANT (JUDGE_TENANT_ID, otherwise _public) · SMOKE_API_KEY
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${APP_DIR:-/root/memoryagent}"
DB_SVC="${DB_SVC:-db}"
DB_INIT_SVC="${DB_INIT_SVC:-db-init}"
BACKEND_SVC="${BACKEND_SVC:-backend}"
BASE_URL="${BASE_URL:-http://localhost:9000}"
SMOKE_COMPANY="${SMOKE_COMPANY:-__smoke__}"
SMOKE_TENANT="${SMOKE_TENANT:-}"
SMOKE_API_KEY="${SMOKE_API_KEY:-}"
TRUNCATE=0
CONFIRM_TRUNCATE=0
DO_SMOKE=1

usage() { sed -n '2,47p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --truncate) TRUNCATE=1 ;;
    --confirm-truncate) CONFIRM_TRUNCATE=1 ;;
    --no-smoke) DO_SMOKE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown arg '$arg'"; usage; exit 2 ;;
  esac
done

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mABORT: %s\033[0m\n' "$*" >&2; exit 1; }

if [ "$TRUNCATE" -eq 1 ] && [ "$CONFIRM_TRUNCATE" -ne 1 ]; then
  die "--truncate is destructive and also requires --confirm-truncate."
fi

# ── Compose command (docker compose v2, else docker-compose) ──────────────────
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "docker compose not found (need Docker Compose v2 or docker-compose)."
fi
compose() { "${COMPOSE[@]}" "$@"; }

command -v curl >/dev/null 2>&1 || die "curl not found (needed for health/smoke checks)."

# ── Preflight ─────────────────────────────────────────────────────────────────
log "Preflight"
cd "$APP_DIR" 2>/dev/null || die "app dir '$APP_DIR' not found. Sync code there first (see header)."
[ -f docker-compose.yml ] || [ -f compose.yml ] || die "no compose file in $APP_DIR."
ok "app dir: $APP_DIR"

# Read only the values this script itself needs; Compose consumes the complete
# .env. Values are never printed. Explicit exports win over the file.
env_file_value() {
  local name="$1"
  sed -n "s/^${name}=//p" .env 2>/dev/null | tail -1 | tr -d '\r'
}
if [ -f .env ]; then
  DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-$(env_file_value DASHSCOPE_API_KEY)}"
  DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-$(env_file_value DASHSCOPE_BASE_URL)}"
  JUDGE_API_KEY="${JUDGE_API_KEY:-$(env_file_value JUDGE_API_KEY)}"
  JUDGE_TENANT_ID="${JUDGE_TENANT_ID:-$(env_file_value JUDGE_TENANT_ID)}"
  TRUST_PROXY_ADDRESSES="${TRUST_PROXY_ADDRESSES:-$(env_file_value TRUST_PROXY_ADDRESSES)}"
  TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-$(env_file_value TRUST_PROXY_HOPS)}"
  MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-$(env_file_value MIGRATION_DATABASE_URL)}"
  COMPOSE_DATABASE_URL="${COMPOSE_DATABASE_URL:-$(env_file_value COMPOSE_DATABASE_URL)}"
  MEMORY_APP_DB_PASSWORD="${MEMORY_APP_DB_PASSWORD:-$(env_file_value MEMORY_APP_DB_PASSWORD)}"
  CROSS_APP_DATABASE_NAME="${CROSS_APP_DATABASE_NAME:-$(env_file_value CROSS_APP_DATABASE_NAME)}"
  CROSS_APP_DATABASE_HOST="${CROSS_APP_DATABASE_HOST:-$(env_file_value CROSS_APP_DATABASE_HOST)}"
  CROSS_APP_DATABASE_PORT="${CROSS_APP_DATABASE_PORT:-$(env_file_value CROSS_APP_DATABASE_PORT)}"
fi
DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-https://dashscope-intl.aliyuncs.com/compatible-mode/v1}"
SMOKE_API_KEY="${SMOKE_API_KEY:-${JUDGE_API_KEY:-}}"
SMOKE_TENANT="${SMOKE_TENANT:-${JUDGE_TENANT_ID:-_judge_demo}}"
[ -n "${DASHSCOPE_API_KEY:-}" ] || die "configure DASHSCOPE_API_KEY in .env or the environment (real Qwen is required)."
[ -n "${MIGRATION_DATABASE_URL:-}" ] || die "configure one-shot MIGRATION_DATABASE_URL."
[[ "${MIGRATION_DATABASE_URL}" == postgresql://* || "${MIGRATION_DATABASE_URL}" == postgres://* ]] \
  || die "MIGRATION_DATABASE_URL must use postgres:// or postgresql://."
case "${MIGRATION_DATABASE_URL}" in
  postgres://memoryagent_app:*|postgresql://memoryagent_app:*)
    die "MIGRATION_DATABASE_URL must not authenticate as the runtime role." ;;
esac
[[ "${MEMORY_APP_DB_PASSWORD:-}" =~ ^[A-Za-z0-9._~-]{32,128}$ ]] \
  || die "MEMORY_APP_DB_PASSWORD must be 32-128 URL-safe characters."
[ -n "${COMPOSE_DATABASE_URL:-}" ] || die "configure runtime COMPOSE_DATABASE_URL."
case "${COMPOSE_DATABASE_URL}" in
  postgres://memoryagent_app:"${MEMORY_APP_DB_PASSWORD}"@*|postgresql://memoryagent_app:"${MEMORY_APP_DB_PASSWORD}"@*) ;;
  *) die "COMPOSE_DATABASE_URL must use memoryagent_app and MEMORY_APP_DB_PASSWORD." ;;
esac
[ -n "${CROSS_APP_DATABASE_NAME:-}" ] \
  || die "CROSS_APP_DATABASE_NAME is mandatory for the production isolation proof."
[[ "${CROSS_APP_DATABASE_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
  || die "CROSS_APP_DATABASE_NAME must be a safe PostgreSQL identifier."
[ -z "${CROSS_APP_DATABASE_PORT:-}" ] || [ -n "${CROSS_APP_DATABASE_HOST:-}" ] \
  || die "CROSS_APP_DATABASE_PORT requires CROSS_APP_DATABASE_HOST."
ok "admin migration and non-superuser runtime database roles are separated"
[ -z "${TRUST_PROXY_ADDRESSES:-}" ] || [ -z "${TRUST_PROXY_HOPS:-}" ] \
  || die "configure only one of TRUST_PROXY_ADDRESSES or TRUST_PROXY_HOPS."
if [ -z "${TRUST_PROXY_ADDRESSES:-}" ]; then
  [[ "${TRUST_PROXY_HOPS:-}" =~ ^[1-3]$ ]] \
    || die "configure exact TRUST_PROXY_ADDRESSES or bounded TRUST_PROXY_HOPS=1..3; per-client limits require the real client IP."
fi
ok "reverse-proxy trust boundary configured"
if [ "$DO_SMOKE" -eq 1 ]; then
  [ "${#SMOKE_API_KEY}" -ge 32 ] \
    || die "configure a 32+ character JUDGE_API_KEY or SMOKE_API_KEY for the authenticated smoke."
fi
[[ "$SMOKE_COMPANY" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] \
  || die "SMOKE_COMPANY must contain 1-64 letters, digits, dots, underscores, or hyphens."
[[ "$SMOKE_TENANT" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] \
  || die "SMOKE_TENANT must contain 1-128 letters, digits, dots, underscores, or hyphens."

# Is the pgvector store a local compose service (PATH B), or external RDS?
HAS_DB_SVC=0
if compose config --services 2>/dev/null | grep -qx "$DB_SVC"; then HAS_DB_SVC=1; fi
if [ "$HAS_DB_SVC" -eq 1 ]; then
  ok "pgvector is a compose service ('$DB_SVC') — PATH B topology"
else
  ok "no '$DB_SVC' compose service — assuming external DATABASE_URL (e.g. ApsaraDB RDS)"
  if [ "$TRUNCATE" -eq 1 ]; then
    die "--truncate needs the local '$DB_SVC' compose service. For external RDS, truncate manually."
  fi
fi

# ── Build (idempotent) ────────────────────────────────────────────────────────
log "Build backend image"
compose build
ok "image built"

# Validate the exact value that will reach the serving container with the same
# compiled allowlist the production client uses. This makes arbitrary compatible
# proxies and trial/token/coding-plan endpoints a fail-closed deploy error.
if ! compose run --rm --no-deps -e "DASHSCOPE_BASE_URL=${DASHSCOPE_BASE_URL}" \
  "$BACKEND_SVC" node --input-type=module -e \
  'import { officialRuntimeEndpoint } from "./dist/src/qwen/client.js"; officialRuntimeEndpoint(process.env.DASHSCOPE_BASE_URL);' \
  >/dev/null 2>&1; then
  die "DASHSCOPE_BASE_URL must be an official credential-free pay-as-you-go Alibaba Model Studio endpoint."
fi
ok "official Alibaba Model Studio endpoint verified (value not printed)"

# ── Bring the database up FIRST and wait until it accepts connections ─────────
if [ "$HAS_DB_SVC" -eq 1 ]; then
  log "Start database ($DB_SVC) and wait for readiness"
  compose up -d "$DB_SVC"
  for i in $(seq 1 30); do
    if compose exec -T "$DB_SVC" sh -ec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
      ok "database ready"; break
    fi
    [ "$i" -eq 30 ] && die "database did not become ready in time."
    sleep 2
  done
fi

# ── SCHEMA FIRST — fail-closed. This is the whole point of the script. ────────
log "Apply schema + least-privilege grants (BEFORE serving new code — fail-closed)"
if ! compose run --rm "$DB_INIT_SVC"; then
  die "schema apply FAILED — NOT serving new code (would 500 on every ingest). Fix the schema/DB and re-run."
fi
ok "schema applied and runtime grants provisioned (idempotent)"

log "Verify runtime role and cross-database denial"
VERIFY_ARGS=(run --rm --no-deps -e "CROSS_APP_DATABASE_NAME=${CROSS_APP_DATABASE_NAME}")
[ -n "${CROSS_APP_DATABASE_HOST:-}" ] && VERIFY_ARGS+=(-e "CROSS_APP_DATABASE_HOST=${CROSS_APP_DATABASE_HOST}")
[ -n "${CROSS_APP_DATABASE_PORT:-}" ] && VERIFY_ARGS+=(-e "CROSS_APP_DATABASE_PORT=${CROSS_APP_DATABASE_PORT}")
if ! compose "${VERIFY_ARGS[@]}" "$BACKEND_SVC" node dist/scripts/verify-db-least-privilege.js; then
  die "runtime database role verification FAILED — the new image was not promoted; inspect any previously running version separately."
fi
ok "runtime DML boundary verified"

# ── Optional: clear demo rows for a clean recording ───────────────────────────
if [ "$TRUNCATE" -eq 1 ]; then
  log "Truncate agent_memory (--truncate)"
  compose exec -T "$DB_SVC" sh -ec \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TRUNCATE agent_memory;"' \
    || die "TRUNCATE failed."
  ok "agent_memory cleared"
fi

# ── (Re)deploy the backend with the new build ─────────────────────────────────
log "(Re)deploy backend"
compose up -d --no-deps "$BACKEND_SVC"
ok "backend up"

# ── Post-deploy: health probe (poll until 200) ────────────────────────────────
log "Health check ($BASE_URL/health)"
HEALTH=""
for i in $(seq 1 30); do
  if HEALTH="$(curl -fsS "$BASE_URL/health" 2>/dev/null)"; then break; fi
  [ "$i" -eq 30 ] && die "/health did not return 200 in time. Check: compose logs $BACKEND_SVC"
  sleep 2
done
echo "    $HEALTH"
case "$HEALTH" in *'"status":"ok"'*) ok "health ok" ;; *) die "unexpected /health body." ;; esac

log "Dependency readiness check ($BASE_URL/ready)"
READY="$(curl -fsS "$BASE_URL/ready" 2>/dev/null)" \
  || die "/ready failed — database, Qwen, or judge authentication is not production-ready."
echo "    $READY"
case "$READY" in *'"status":"ready"'*) ok "dependencies ready" ;; *) die "unexpected /ready body." ;; esac

# ── Post-deploy: smoke ingest + recall (proves schema-first actually worked) ──
# /health needs no DB, so it passes even with a missing schema. A real ingest +
# recall round-trip is what proves the migration took. The smoke uses a dedicated
# company and DELETEs its own rows afterward so /memory/count is never inflated.
if [ "$DO_SMOKE" -eq 1 ]; then
  log "Smoke: ingest + recall round-trip (company '$SMOKE_COMPANY')"

  read -r -d '' SMOKE_EVENT <<JSON || true
{"event":{"event_id":"smoke-evt-1","company":"$SMOKE_COMPANY","period":"2026-01",
"employee_count":1,"bank_net_total":1000,"gross_total":1300,"employer_social_security_total":300,
"employee_social_security_total":100,"tax_withheld_total":200,"employer_cost_total":1600,
"cost_gap_amount":600,"cost_gap_pct":60.0,"off_bank_cost":600,
"employees":[{"employee_id":"S-01","name":"Smoke Test","gross":1300,"employee_social_security":100,
"tax":200,"net":1000,"employer_social_security":300,"employer_cost":1600}],
"linked_docs":["smoke-doc-1"]}}
JSON

  ING="$(curl -fsS -X POST "$BASE_URL/ingest" -H 'content-type: application/json' \
        -H "Authorization: Bearer $SMOKE_API_KEY" \
        -d "$SMOKE_EVENT" 2>/dev/null)" \
    || die "POST /ingest failed — this is the exact schema-missing 500 the script guards against. Check compose logs $BACKEND_SVC."
  echo "    ingest: $ING"
  case "$ING" in *'"written"'*) ok "ingest wrote memories" ;; *) die "ingest returned no 'written' count." ;; esac

  REC="$(curl -fsS -X POST "$BASE_URL/recall" -H 'content-type: application/json' \
        -H "Authorization: Bearer $SMOKE_API_KEY" \
        -d "{\"question\":\"What did it cost to employ the team?\",\"company\":\"$SMOKE_COMPANY\"}" 2>/dev/null)" \
    || die "POST /recall failed (hybrid recall path). Check compose logs $BACKEND_SVC."
  case "$REC" in *'"answer"'*) ok "recall returned a grounded answer" ;; *) die "recall returned no 'answer'." ;; esac

  # Clean up through the DML-only app role for both local and managed databases.
  # The one-shot container receives no migration/bootstrap credential.
  compose run --rm --no-deps \
    -e "SMOKE_TENANT=${SMOKE_TENANT}" -e "SMOKE_COMPANY=${SMOKE_COMPANY}" \
    "$BACKEND_SVC" node dist/scripts/cleanup-smoke.js >/dev/null \
    || die "smoke cleanup failed — release is not clean; the new image remains unverified."
  ok "smoke rows removed through the runtime role (count restored)"
fi

log "DONE — schema migrated, backend live, round-trip verified."
echo "    Verified URL base: $BASE_URL"
echo "    Public access remains behind the configured HTTPS reverse proxy; port 9000 is loopback-only."
[ "$DO_SMOKE" -eq 0 ] && echo "    (smoke skipped — health-only; ingest/recall NOT verified)"
exit 0
