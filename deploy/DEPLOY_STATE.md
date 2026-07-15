# MemoryAgent deployment state and production runbook

Updated: **2026-07-15**. This is the authoritative hardened live-release contract. It intentionally omits instance IDs, security-group IDs, key paths, database usernames, and every secret.

> **Status: LIVE and production-verified over HTTPS.**
> <https://memory.43.106.13.19.sslip.io>
>
> Runtime code commit: [`1f3688a`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/1f3688a57e8ae3fa2869f1dbba8d18dee35da93b), including the production-image closure hotfix. The final hardening landed through [PR #56](https://github.com/upgradedev/archon-qwen-memoryagent/pull/56) and the Docker runtime gate through [PR #57](https://github.com/upgradedev/archon-qwen-memoryagent/pull/57).
>
> Verified on the live host: real `text-embedding-v4` / `qwen-plus`; `/ready` 200 with database, Qwen and judge auth ready; authenticated ingest→recall and semantic-audit success; unauthenticated protected route 401; backend loopback-only; PostgreSQL has no host port; direct public 9000/5432 blocked; container limits and read-only/cap-drop controls active; zero smoke rows remain.

## Historical note — do not operate from the old snapshot

The original bootstrap log described a temporary pre-hardening state: port `9000` exposed publicly, default PostgreSQL credentials, optional DashScope configuration with Fake providers, and unauthenticated writes. It also contained obsolete resource IDs and incomplete cleanup guidance.

That snapshot is **historical only** and has been replaced by this runbook. It is not evidence of the current release. Any credential that ever appeared in a copied `.env`, terminal capture, or old host must be treated as compromised and rotated; “removal is enough” is not an acceptable current policy.

## Qualifying production topology

```text
Internet
   │ HTTPS :443
   ▼
host-managed TLS reverse proxy
   │ http://127.0.0.1:9000
   ▼
Fastify backend container (non-root, read-only root filesystem)
   │ private Docker `data` network
   ▼
PostgreSQL + pgvector container ── named volume `pgdata`

Backend ── HTTPS ── Alibaba Cloud Model Studio / DashScope
```

- **Active path:** Alibaba Cloud ECS in `ap-southeast-1`, running Docker Compose.
- **Public origin:** <https://memory.43.106.13.19.sslip.io>.
- **Backend exposure:** Compose binds `127.0.0.1:${BACKEND_PORT:-9000}:9000`; port `9000` is not an Internet listener. The HTTPS reverse proxy is host-managed and outside this repository.
- **Database exposure:** PostgreSQL uses Docker `expose`, not a host port, and is attached only to the internal `data` network.
- **Deterministic egress:** the backend joins `edge` and `data`, with Compose `gw_priority: 1` on `edge`; the internal DB network can never become Qwen's default route.
- **Durability:** database files live in the named `pgdata` volume, so normal container rebuild/recreation preserves them. `docker compose down -v`, volume deletion, or host-disk loss is destructive; use an ECS disk snapshot/backup before risky maintenance.
- **Alternative only:** Function Compute + managed pg-wire PostgreSQL remains available through `deploy/s.yaml`; it is not the claimed active topology.

The live Alibaba security group exposes `80` only for HTTP redirect/ACME and `443` for the application; administrative SSH is restricted to the operator `/32`. It does not expose `9000` or `5432` to the Internet.

## Current security and readiness contract

### Real Qwen, fail closed

- Production requires `DASHSCOPE_API_KEY`; `ALLOW_FAKE_QWEN` remains false.
- `/health` is liveness and reports model IDs, but it does not prove database/auth readiness.
- `/ready` is the release gate. It returns `200` only when the database/schema, non-Fake Qwen providers, and judge authentication are configured.
- Never call a Fake-backed deployment a qualifying live release.

### Authentication and tenant isolation

- `JUDGE_AUTH_REQUIRED=true` in production.
- `JUDGE_API_KEY` + `JUDGE_TENANT_ID`, or `JUDGE_API_KEYS_JSON`, map credentials to tenants on the server. Request bodies cannot select another tenant.
- The fixed `/demo/seed` and public-tenant read path remain judge-accessible without login. Public seed and recall are quota-bounded.
- `/ingest`, `/ingest/invoice`, `/ingest/documents`, `/feedback`, `/consistency/semantic`, `/consolidate`, and `/forget` are protected. Lifecycle routes preview by default and require `confirm=true` before mutation.
- The Explorer's password-type **Judge token** field is only for the credential supplied privately through Devpost. Never commit, log, screenshot, or publish it.
- Streamable HTTP MCP is separately fail-closed authenticated; stdio is the local trusted transport.

### Spend and runtime containment

- Qwen-heavy HTTP/MCP requests use durable PostgreSQL-backed per-subject/IP plus global UTC-daily quotas, so counters survive backend restarts and work across replicas.
- The backend image runs as the unprivileged `node` user.
- Compose gives the backend a read-only root filesystem, a bounded `/tmp` tmpfs, `no-new-privileges`, and drops all Linux capabilities. PostgreSQL also uses `no-new-privileges`.
- Compose configures explicit containment limits: PostgreSQL **640 MiB / 1 CPU / 128 PIDs** and the backend **512 MiB / 1 CPU / 128 PIDs**. The 2026-07-15 live `docker inspect` gate verified the exact byte/CPU/PID values, backend read-only root, and `cap-drop ALL`.

### Reverse-proxy trust

- Terminate TLS at the trusted host proxy and forward only to `127.0.0.1:9000`.
- The documented loopback-only Compose topology has exactly one host proxy hop, so set `TRUST_PROXY_HOPS=1` explicitly in the private `.env`. For other topologies, configure exact `TRUST_PROXY_ADDRESSES` where possible; deployment aborts if neither trust boundary is explicit.
- Keep `HTTP_RATE_LIMIT_MAX` at a bounded per-client value (default 300/minute); Qwen-heavy routes retain separate durable daily quotas.
- Keep `CORS_ORIGIN` empty for same-origin UI or list exact trusted origins. Wildcard/reflected origins are not part of the production contract.

## Secret-safe environment setup

Create `/root/memoryagent/.env` from `.env.example`, fill every required blank with generated secrets/URLs, then restrict it:

```bash
cd /root/memoryagent
umask 077
cp .env.example .env
chmod 600 .env
# Edit .env with a trusted interactive editor. Do not paste values into commands,
# chat, CI logs, screenshots, or shell history.
```

Use one URL-safe random database password in `POSTGRES_PASSWORD`, in the
host-side `DATABASE_URL`, and in the container-side `COMPOSE_DATABASE_URL`
(`db` is the latter hostname). Generate a separate random 32+ character
`JUDGE_API_KEY`; blank values are intentional and make a copied example fail
closed until configured.

Required production values include:

- distinct, long random `POSTGRES_PASSWORD` and `JUDGE_API_KEY` values;
- matching `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, and `COMPOSE_DATABASE_URL` values;
- `DASHSCOPE_API_KEY` and the international DashScope base URL;
- `JUDGE_AUTH_REQUIRED=true`, the intended tenant mapping, exact CORS/proxy settings, and quota limits.

Never run `docker compose config` in a public log because it can render interpolated secrets. `docker compose config --services` is safe for checking service names.

## Existing-volume database password rotation

Changing `POSTGRES_PASSWORD` in `.env` does **not** change the role password inside an already-initialized official PostgreSQL volume. Rotate the live role first with the supplied script; it passes the new value over stdin to `psql` and does not print it.

```bash
cd /root/memoryagent
set -a; . ./.env; set +a
read -rsp 'New PostgreSQL password (32+ URL-safe chars): ' NEW_POSTGRES_PASSWORD
printf '\n'
export NEW_POSTGRES_PASSWORD

# For the legacy volume keep DB_ROLE/DB_NAME aligned with the role/database that
# actually initialized that volume. Defaults are postgres/postgres.
bash deploy/rotate-compose-db-password.sh

# Securely update POSTGRES_PASSWORD and COMPOSE_DATABASE_URL in .env to the same
# new value, then remove it from the current shell.
unset NEW_POSTGRES_PASSWORD
chmod 600 .env
```

The script verifies a real TCP password login. If it fails, stop and recover with the existing database administrator role; do not delete/recreate `pgdata` as a shortcut.

For a brand-new empty volume, set the final random credentials before the first `docker compose up`; no rotation step is needed.

## Schema-first redeploy

The one-command deployment helper refuses missing judge/Qwen credentials, applies the schema before serving new code, checks `/health` and `/ready`, performs an authenticated ingest→recall smoke, and removes its smoke rows.

```bash
ssh <restricted-admin-host-alias>
cd /root/memoryagent
git pull --ff-only
set -a; . ./.env; set +a
bash deploy/redeploy.sh
```

Do not use `--no-smoke` for a final release. Never use `--truncate --confirm-truncate` on the judging database unless a destructive reset is explicitly intended and a backup exists.

After deployment, confirm container and network state without printing environment values:

```bash
cd /root/memoryagent
docker compose ps
docker compose config --services
docker volume inspect memoryagent_pgdata --format '{{.Name}} {{.Mountpoint}}'
docker inspect "$(docker compose ps -q db)" \
  --format 'db memory={{.HostConfig.Memory}} nano_cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}'
docker inspect "$(docker compose ps -q backend)" \
  --format 'backend memory={{.HostConfig.Memory}} nano_cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}'
ss -lnt | grep -E '127\.0\.0\.1:9000|:443'
curl -fsS http://127.0.0.1:9000/ready
```

Expected: backend/database healthy, named volume present, `docker inspect` values of `671088640 / 1000000000 / 128` for DB and `536870912 / 1000000000 / 128` for backend, application port bound only to loopback, and local `/ready` returning `status=ready`.

## Judge-safe public verification

These commands contain no credentials and are safe to include in a judge walkthrough:

```bash
BASE=https://memory.43.106.13.19.sslip.io

curl -fsS "$BASE/health" | jq '{status,embedder,narrator,embedDim}'
curl -fsS "$BASE/ready"  | jq '{status,checks}'
curl -fsS "$BASE/openapi.json" \
  | jq -e '.paths | has("/ready") and has("/ingest/invoice") and has("/feedback") and has("/consistency/semantic") and has("/consolidate") and has("/forget")'

curl -fsS -X POST "$BASE/demo/seed" | jq '{seeded,alreadySeeded,company}'
curl -fsS -X POST "$BASE/recall" \
  -H 'content-type: application/json' \
  -d '{"question":"What did it really cost to employ the team?","company":"Northwind Trading"}' \
  | jq '{answer,modelId,citations}'
curl -fsS -X POST "$BASE/consistency" \
  -H 'content-type: application/json' \
  -d '{"company":"Northwind Trading"}' \
  | jq '{ok,contradictions}'
```

Expected production evidence:

- `/health`: `text-embedding-v4`, `qwen-plus`, dimension `1024`;
- `/ready`: `200`, `status=ready`, database/Qwen/auth checks ready;
- OpenAPI: all final hardened routes present;
- public fixed seed/recall/field-audit path succeeds without a token.

For the protected semantic audit, read the private token without echoing it and keep the value out of the `curl` process arguments by supplying the header through process substitution:

```bash
read -rsp 'Private Devpost reviewer token: ' JUDGE_TOKEN; printf '\n'
curl -fsS -X POST "$BASE/consistency/semantic" \
  -H @<(printf 'Authorization: Bearer %s\n' "$JUDGE_TOKEN") \
  -H 'content-type: application/json' \
  -d '{"company":"Northwind Trading","kind":"insight"}' \
  | jq '{ok,completion,semanticContradictions}'
unset JUDGE_TOKEN
```

Run the protected command only in Bash with tracing disabled (`set +x`). Crop/clear the token field before screenshots or recording cuts.

## Release decision

A release is judge-ready only when all of the following are true:

1. HTTPS is public, but backend `9000` and PostgreSQL `5432` are not.
2. `/ready` returns `200`; `/health` reports real Qwen.
3. Public and private-token judge paths pass.
4. The named database volume is present and backed up before risky operations.
5. Database, judge, DashScope, SSH, and any formerly copied credentials have been rotated as required.
6. No secrets appear in Git, Docker inspection output shared publicly, screenshots, videos, posts, or Devpost public fields.

Function Compute remains an alternative. The submission's active proof is the hardened ECS + HTTPS proxy + loopback backend + private durable pgvector topology above.
