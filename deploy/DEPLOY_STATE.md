# MemoryAgent deployment state and production runbook

Updated: **2026-07-16**. This is the authoritative hardened live-release contract. It intentionally omits instance IDs, security-group IDs, key paths, database usernames, and every secret.

<!-- MEMORYAGENT_DEPLOY_STATE_V1 status=LIVE_VERIFIED_READY runtime_sha=104a002820607c754d857473877da28b69ebb44d -->

> **Status: EXACT DEPLOYED — runtime release gate is GREEN; final media capture is pending.**
> <https://memory.43.106.13.19.sslip.io>
>
> Exact deployed runtime source:
> [`104a002820607c754d857473877da28b69ebb44d`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/104a002820607c754d857473877da28b69ebb44d)
> (`main`, merging PR #69). Project-contained exact-deploy attempt 22 finished with
> Alibaba Cloud Assistant terminal status `Success`, exit code `0`, and the
> SHA-bound application marker
> `EXACT_APP_DEPLOY_OK app=memoryagent sha=104a002820607c754d857473877da28b69ebb44d`.
> The bounded provider output ended after that terminal application marker, so the
> retained status/output pair is validated under the reviewed
> `terminal-success-truncated-output` evidence mode; it is not reconstructed or
> hand-edited evidence.
>
> The controller verified immutable GitHub checkout, pinned image build,
> schema/grants, the non-superuser runtime role, cross-application database denial,
> real-Qwen health/readiness, an ingest → grounded recall round trip, zero-residue
> cleanup, and public HTTPS. The shipped Explorer now sends the canonical
> evidence-scoped question with `company=Northwind Trading` and `limit=3`; final
> gallery/video capture must bind to this exact SHA and deployment evidence.
>
> Previous live runtime-source commit
> [`e4b208a63e1768409e5b94fe305a3672c4c96dcd`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/e4b208a63e1768409e5b94fe305a3672c4c96dcd)
> passed exact deploy attempt 8, including checkout/build, schema/grants, DML-only
> runtime identity, cross-application database denial, `/health`, `/ready`, a
> real-embedding ingest → grounded recall → cleanup smoke, public TLS checks, and v4
> seed reconciliation. That evidence is retained as **historical topology and release
> evidence only**; it does not attest `104a002…` or current `main`.
>
> Repository `main` may advance beyond that runtime-source SHA through reviewed
> non-runtime evidence, CI/test-harness, documentation, sanitized submission-media,
> or recording-tooling commits. Public commit
> [`a2c6bccaf4bc1bdd30f6e2ea8f224467a5168083`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/a2c6bccaf4bc1bdd30f6e2ea8f224467a5168083)
> was a reviewed non-runtime descendant anchor: its delta from `e4b208a…` changed
> CI/test enumeration, tests, published load evidence, documentation/media and
> recording tooling; `package.json` changes only the test-script dispatcher. It has
> no `src/**`, dependency-lock, Docker/compose, database-schema, deploy-script or
> deployment-workflow delta. It never made `a2c6bcc…` the deployed source. Later
> runtime-affecting descendants have now passed the exact deployment recorded
> above. After `104a002…`,
> permitted submission-pack paths are `README.md`, `SECURITY.md`, `deploy/DEPLOY_STATE.md`,
> `demo/**`, `docs/**`, `.github/workflows/demo-video.yml`,
> `scripts/capture_live.sh`, and `scripts/captions.txt`. Before capture, verify that
> `104a002…` is an ancestor of `origin/main` and inspect every later changed path.
> Any new path outside that allowlist—or any application, dependency, schema,
> container, runtime/deployment-workflow or deploy-script delta—requires review and,
> when runtime-affecting, a new exact deploy plus a refreshed record here.

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
- The Explorer's password-type **Judge token** field is only for the dedicated low-privilege judging credential supplied through Devpost testing instructions. Verify field visibility rather than assuming privacy; never commit, log, screenshot, or intentionally publish it, and rotate/revoke it after judging.
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

Use two independent URL-safe random database passwords. `POSTGRES_PASSWORD`
belongs to the bootstrap owner named by `POSTGRES_USER`; its
`MIGRATION_DATABASE_URL` is exposed only to the one-shot `db-init` service.
`MEMORY_APP_DB_PASSWORD` belongs to the fixed non-superuser
`memoryagent_app`; only that role appears in host-side `DATABASE_URL` and
container-side `COMPOSE_DATABASE_URL` (`db` is the latter hostname). Generate a
third, separate random 32+ character `JUDGE_API_KEY`. Blank values intentionally
make a copied example fail closed.

Required production values include:

- distinct, long random `POSTGRES_PASSWORD`, `MEMORY_APP_DB_PASSWORD`, and `JUDGE_API_KEY` values;
- an admin-only `MIGRATION_DATABASE_URL` plus runtime URLs authenticating only as `memoryagent_app`;
- `DASHSCOPE_API_KEY` and an allowlisted official Alibaba Model Studio base URL
  (the current baseline uses the international shared endpoint; deploy and
  runtime both reject trial/token/coding-plan hosts and arbitrary proxies);
- `JUDGE_AUTH_REQUIRED=true`, the intended tenant mapping, exact CORS/proxy settings, and quota limits.

Never run `docker compose config` in a public log because it can render interpolated secrets. `docker compose config --services` is safe for checking service names.

## Existing-volume database password rotation

Changing `POSTGRES_PASSWORD` in `.env` does **not** change the bootstrap role
password inside an already-initialized official PostgreSQL volume. Rotate that
admin role first with the supplied script; it passes the new value over stdin to
`psql` and does not print it. This operation must not change
`MEMORY_APP_DB_PASSWORD` or either runtime URL.

```bash
cd /root/memoryagent
set -a; . ./.env; set +a
read -rsp 'New PostgreSQL password (32+ URL-safe chars): ' NEW_POSTGRES_PASSWORD
printf '\n'
export NEW_POSTGRES_PASSWORD

# For the legacy volume keep DB_ROLE/DB_NAME aligned with the role/database that
# actually initialized that volume. Defaults are postgres/postgres.
bash deploy/rotate-compose-db-password.sh

# Securely update POSTGRES_PASSWORD and the password component of
# MIGRATION_DATABASE_URL only. Leave memoryagent_app runtime credentials intact.
unset NEW_POSTGRES_PASSWORD
chmod 600 .env
```

The script verifies a real TCP password login. If it fails, stop and recover with the existing database administrator role; do not delete/recreate `pgdata` as a shortcut.

For a brand-new empty volume, set the final random credentials before the first `docker compose up`; no rotation step is needed.

## Schema-first redeploy

The one-command deployment helper refuses missing judge/Qwen credentials, runs
the admin-only schema/grant job before serving new code, verifies that
`memoryagent_app` has DML-only access (and cannot enter the configured cross-app
database), checks `/health` and `/ready`, performs an authenticated ingest→recall
smoke, and removes its smoke rows. Production refuses to proceed without
`CROSS_APP_DATABASE_NAME`; add
`CROSS_APP_DATABASE_HOST`/`PORT` only when the other app has a separate server.

For a cluster shared with Autopilot, keep both backends stopped, run both
one-shot admin migrations (`memoryagent`/`memoryagent_app` and
`autopilot`/`autopilot_app`), then run both runtime verifiers before starting
either backend. Each migration revokes additive `PUBLIC` cross-database access;
the two completed migrations restore only the owning app role on its own
database. A 42501 denial in both directions is the required release result.

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
  -d '{"question":"Using only the retrieved memory, state the true employer cost for Northwind Trading in 2026-05 and include citation marker [1] in the sentence.","company":"Northwind Trading","limit":3}' \
  | jq '{answer,modelId,citations,grounding}'
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

1. This file records `104a002820607c754d857473877da28b69ebb44d`
   (or a later explicitly reviewed runtime candidate) as exact deployed and
   live-verified. **This condition is currently true.**
2. HTTPS is public, but backend `9000` and PostgreSQL `5432` are not.
3. `/ready` returns `200`; `/health` reports real Qwen.
4. Public and protected reviewer-credential paths pass, including selected-company
   Explorer P&L behavior.
5. The named database volume is present and backed up before risky operations.
6. Database, judge, DashScope, SSH, and any formerly copied credentials have been rotated as required.
7. No secrets appear in Git, Docker inspection output shared publicly, screenshots, videos, posts, or Devpost public fields.

Function Compute remains an alternative. The submission's active proof is the hardened ECS + HTTPS proxy + loopback backend + private durable pgvector topology above.
