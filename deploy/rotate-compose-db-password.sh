#!/usr/bin/env bash
# One-time credential rotation for an existing local pgvector Compose volume.
# The official Postgres image only consumes POSTGRES_PASSWORD during first
# initialization; changing .env alone does not rotate a role in an old volume.
#
# Usage (on the ECS box, before redeploy.sh):
#   NEW_POSTGRES_PASSWORD='<32+ URL-safe random chars>' \
#     bash deploy/rotate-compose-db-password.sh
#
# Keep DB_ROLE/DB_NAME at the bootstrap role/database that initialized an old
# volume. This rotates only that migration role. The backend's independent
# memoryagent_app password and runtime URLs must not be changed to this value.
set -euo pipefail

APP_DIR="${APP_DIR:-/root/memoryagent}"
DB_SVC="${DB_SVC:-db}"
DB_ROLE="${DB_ROLE:-postgres}"
DB_NAME="${DB_NAME:-postgres}"
NEW_POSTGRES_PASSWORD="${NEW_POSTGRES_PASSWORD:-}"
MEMORY_APP_DB_PASSWORD="${MEMORY_APP_DB_PASSWORD:-}"

die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

[[ "$DB_ROLE" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
  || die "DB_ROLE is not a safe PostgreSQL identifier."
[[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
  || die "DB_NAME is not a safe PostgreSQL identifier."
[[ "$NEW_POSTGRES_PASSWORD" =~ ^[A-Za-z0-9._~-]{32,128}$ ]] \
  || die "NEW_POSTGRES_PASSWORD must be 32-128 URL-safe characters (letters, digits, . _ ~ -)."
[[ "$MEMORY_APP_DB_PASSWORD" =~ ^[A-Za-z0-9._~-]{32,128}$ ]] \
  || die "load the independent 32-128 character MEMORY_APP_DB_PASSWORD from the private .env first."

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "docker compose not found."
fi
compose() { "${COMPOSE[@]}" "$@"; }

cd "$APP_DIR" 2>/dev/null || die "app dir '$APP_DIR' not found."

# Satisfy the new manifest's required interpolation without recreating the
# backend. Existing-volume initialization ignores these database values; the
# ALTER ROLE below is the operation that actually rotates the credential.
export POSTGRES_USER="$DB_ROLE"
export POSTGRES_PASSWORD="$NEW_POSTGRES_PASSWORD"
export POSTGRES_DB="$DB_NAME"
export MIGRATION_DATABASE_URL="postgresql://${DB_ROLE}:${NEW_POSTGRES_PASSWORD}@db:5432/${DB_NAME}"
export MEMORY_APP_DB_PASSWORD
export COMPOSE_DATABASE_URL="postgresql://memoryagent_app:${MEMORY_APP_DB_PASSWORD}@db:5432/${DB_NAME}"

compose config --services | grep -qx "$DB_SVC" \
  || die "Compose service '$DB_SVC' does not exist."
compose up -d "$DB_SVC"

for i in $(seq 1 30); do
  if compose exec -T "$DB_SVC" pg_isready -U "$DB_ROLE" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 30 ] && die "database did not become ready."
  sleep 2
done

# Inputs are deliberately restricted above; the secret travels over stdin and
# is never placed in a psql command-line argument or printed by this script.
printf 'ALTER ROLE "%s" WITH LOGIN PASSWORD '\''%s'\'';\n' \
  "$DB_ROLE" "$NEW_POSTGRES_PASSWORD" \
  | compose exec -T "$DB_SVC" psql -v ON_ERROR_STOP=1 -U "$DB_ROLE" -d "$DB_NAME" >/dev/null \
  || die "role password rotation failed; the volume may require its original admin role."

compose exec -T -e PGPASSWORD="$NEW_POSTGRES_PASSWORD" "$DB_SVC" \
  psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_ROLE" -d "$DB_NAME" \
  -c 'SELECT 1;' >/dev/null \
  || die "rotation command ran, but TCP password verification failed."

printf 'Bootstrap password rotated and verified. Update POSTGRES_PASSWORD and MIGRATION_DATABASE_URL only, then run deploy/redeploy.sh.\n'
