# DEPLOY_STATE — Qwen MemoryAgent → Alibaba Cloud

Crash-recoverable checkpoint. Updated after EVERY step. Secrets MASKED.

> ## ⚡ TURNKEY REDEPLOY (one command)
> The manual steps below are now scripted in **`deploy/redeploy.sh`** (idempotent,
> schema-first + fail-closed, health + ingest/recall smoke, optional `--truncate`).
> On the box (the box now runs from a git clone — `git pull` is enough; the old
> rsync-tarball seed still works too):
> ```bash
> ssh -i C:/tools/aliyun/archon-mem-kp.pem root@43.106.13.19
> cd /root/memoryagent && git pull                           # or rsync latest code in
> bash deploy/redeploy.sh                                     # or: --truncate for a clean demo
> ```
> For REAL Qwen, keep a `.env` with `DASHSCOPE_API_KEY` next to `docker-compose.yml`
> (compose interpolates it; without it the app runs the offline Fakes).
> It targets the live **ECS + docker compose** box (PATH B below), NOT Function
> Compute. The manual runbook that follows is the same steps, longhand.
>
> ## ⚠️ REDEPLOY RUNBOOK (READ FIRST after PR #4 merges)
> The SOTA branch adds columns (`importance`, `superseded_at`, `superseded_by`) +
> a GIN full-text index to `agent_memory`. The live pgvector volume has the OLD
> table; `CREATE TABLE IF NOT EXISTS` will NOT add them — only the new
> `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `schema.sql` will. **A code-only
> redeploy without re-applying the schema will 500 on every `/ingest` and every
> hybrid `/recall`.** So a clean redeploy is, in order:
> 1. SSH in; `cd /root/memoryagent`; pull the merged code.
> 2. **Re-apply the schema FIRST** (migrates the live table):
>    `docker compose run --rm backend npm run db:schema`
>    (or run `apply-schema.ts` against the live `DATABASE_URL`).
> 3. `docker compose up -d --build` to serve the new code.
> 4. Verify: `curl /health`, then a hybrid `/recall` returns 200.
>
> Also: the verification run left demo rows for company **`VerifyCo SA`** in the
> live DB. Clear them (or `TRUNCATE agent_memory` and re-ingest) before recording
> the demo so `/memory/count` isn't inflated.

- Region: **ap-southeast-1** (Singapore / international)
- Repo: `C:\dev\solutions\private_nebius_aiserverless_challenge\repos\qwen-memoryagent`
- App: Node/TS Fastify HTTP server, port 9000. Endpoints: `/health` (200, embedDim 1024, no DB), `/memory/count`, `/ingest`, `/recall`. Needs DATABASE_URL (pgvector). DashScope key optional (falls back to deterministic Fakes).
- AccessKey ID: `LTAI****` (masked, in .env)
- DASHSCOPE_API_KEY: EMPTY — user is creating it. Deploy with Fakes; real Qwen needs the key later.

## Path decision
- PATH A: ApsaraDB RDS PostgreSQL (pgvector) + Function Compute (per deploy/s.yaml).
- PATH B (fallback): single ECS + docker compose (app + pgvector/pgvector), public IP.
- CHOICE: **PATH B — ECS + docker compose** (backend + pgvector/pgvector container).
  Rationale: fastest+most reliable single public URL; FC path walls on ACR Personal docker-login password (console-only) + serverless-devs + FC↔RDS VPC networking. Hackathon bar = a live public URL on Alibaba, not architectural richness. pgvector container gives the round-trip "on Alibaba". Reuse existing VPC/vswitch to avoid network junk. Release the RDS orphan to stop billing.

## Progress log

### Step 0 — orientation (DONE)
- Read repo, Dockerfile, s.yaml, deploy-fc.sh, server.ts, schema.sql. App understood.

### Step 1 — account gate (DONE — PASS)
- aliyun CLI v3.4.3 installed at `/c/tools/aliyun/aliyun.exe` (absolute path used every call; Git Bash on Windows).
- Configured profile `default`, mode AK, region ap-southeast-1, AK `LTAI5t****`.
- `aliyun ecs DescribeRegions` returned full region list → AccessKey VALID, account readable. No verification wall hit at read level (create-level TBD).

### Step 2 — orphan check (DONE)
- ECS: none. ACR (cr GetInstanceCount): 0 (no Enterprise ACR instance).
- **RDS ORPHAN FOUND** from crashed run:
  - id `pgm-gs558i717e0f8z6u`, desc `archon-mem-pg`, **PostgreSQL 16.0**, Postpaid (pay-as-you-go)
  - class pg.x2m.medium.2c, port 5432, ConnectionString `pgm-gs558i717e0f8z6u.pgsql.singapore.rds.aliyuncs.com` (INTRANET only)
  - VPC `vpc-t4n52ldyprw3c6s7c0x5o`, vSwitch `vsw-t4nkxqnrrmnl8sxpijtno`
  - Status: **Creating** (created 11:52 GMT, still provisioning ~8 min in). No DB/account yet (ops denied while Creating).
- Account CAN create resources (RDS exists) → **no real-name/payment verification wall**.

### Step 3 — path decision + provision (IN PROGRESS)
- RDS orphan delete REFUSED (IncorrectDBInstanceState — still Creating). **TODO cleanup:** `aliyun rds DeleteDBInstance --DBInstanceId pgm-gs558i717e0f8z6u --RegionId ap-southeast-1` once it reaches Running (else keeps billing Postpaid).
- ECS plan: image `ubuntu_22_04_x64_20G_alibase_20260615.vhd`, type `ecs.e-c1m2.large` (fallback `ecs.u1-c1m2.large`), zone ap-southeast-1c.
- Reusing VPC `vpc-t4n52ldyprw3c6s7c0x5o`, vSwitch `vsw-t4nkxqnrrmnl8sxpijtno` (172.16.3.0/24).
- Security group **`sg-t4n2trq33br7znmgs2yf`** — ingress tcp 22 + 9000 from 0.0.0.0/0.
- Key pair **`archon-mem-kp`** (id skp-t4nfifew0vcpwvg50l4b); pem at `C:/tools/aliyun/archon-mem-kp.pem` (chmod 600, NOT committed).
- ECS **`i-t4ngalzjr5nwtuowbv7y`** RUNNING. Public IP **`43.106.13.19`**, private 172.16.3.7. SSH user `root`, key `C:/tools/aliyun/archon-mem-kp.pem`.

### Step 4 — deploy container (IN PROGRESS)
- SSH OK (user root). Installed Docker 29.1.3 + Compose v2.40.3 (apt).
- Uploaded source tarball (no node_modules/.git) → /root/memoryagent, extracted.
- `docker compose up -d --build` → backend + db (pgvector/pgvector:pg16) both UP. backend `0.0.0.0:9000->9000`, db healthy.
- Effective app DATABASE_URL (compose network): `postgresql://postgres:****@db:5432/postgres` (pgvector container on the ECS box).
- Schema applied via db container (idempotent): vector 0.8.4 ext + agent_memory + payroll_events tables + HNSW index verified.

### Step 5 — smoke (DONE — PASS)
- `GET /health` → `{"status":"ok","embedder":"fake-hash-embedder","narrator":"fake-narrator","embedDim":1024}` (200).
- `POST /ingest` (ACME SA 2026-05 PayrollEvent) → `{"written":4,...}`.
- `GET /memory/count` → `{"count":4}`.
- `POST /recall` → cited RAG answer with pgvector cosine scores (HNSW semantic recall over `agent_memory`). **pgvector round-trip on Alibaba CONFIRMED.**
- Embedder/narrator = Fakes because DASHSCOPE_API_KEY is empty (expected).

---

## ✅ DEPLOYMENT LIVE — REPORT

### Live public URL (hackathon proof of Alibaba deployment)
**http://43.106.13.19:9000** — endpoints: `/health`, `/memory/count`, `/ingest`, `/recall`.

### Alibaba Cloud services used
- **ECS** (Elastic Compute Service): instance `i-t4ngalzjr5nwtuowbv7y`, `ecs.e-c1m2.large`, Ubuntu 22.04, ap-southeast-1c, public IP 43.106.13.19, running Docker Compose (backend + pgvector).
- **VPC** `vpc-t4n52ldyprw3c6s7c0x5o` / vSwitch `vsw-t4nkxqnrrmnl8sxpijtno`, Security Group `sg-t4n2trq33br7znmgs2yf` (22 + 9000 open).
- pgvector store = `pgvector/pgvector:pg16` container on the ECS box (pg-wire compatible; same SQL as ApsaraDB RDS for PostgreSQL).

### Created DATABASE_URL (masked)
`postgresql://postgres:****@db:5432/postgres` (compose network; data in docker volume `memoryagent_pgdata`).

### Smoke result
ALL PASS (health 200 / embedDim 1024, ingest 4, count 4, recall cited pgvector answer).

### Exact remaining steps
1. **Enable real Qwen** (once DASHSCOPE_API_KEY exists): SSH `ssh -i C:/tools/aliyun/archon-mem-kp.pem root@43.106.13.19`; in `/root/memoryagent/docker-compose.yml` uncomment + set under `backend.environment`:
   `DASHSCOPE_API_KEY: <key>` and `DASHSCOPE_BASE_URL: https://dashscope-intl.aliyuncs.com/compatible-mode/v1`; then `cd /root/memoryagent && docker compose up -d`. Re-check `/health` → embedder should read `text-embedding-v4` (still embedDim 1024).
2. **Release the RDS orphan** `pgm-gs558i717e0f8z6u` (unused, still billing Postpaid) once it reaches Running:
   `aliyun rds DeleteDBInstance --DBInstanceId pgm-gs558i717e0f8z6u --RegionId ap-southeast-1` (refused earlier while status=Creating).
3. **Cost note:** ECS + (RDS until deleted) bill hourly (PostPaid). Stop/release when the demo is recorded.

### Post-deploy hardening (DONE)
- Removed `/root/memoryagent/.env` from the ECS box (tarball had included it — it carried the master AccessKey; app doesn't use it, compose sets env inline). Also deleted the uploaded tarball. Secret was only ever on our own box (port 22 open to 0.0.0.0/0), never published — removal suffices, no rotation required unless the box is treated as untrusted.
- Set `docker update --restart=unless-stopped` on both containers → an ECS stop/start now self-heals (the live URL survives a reboot). Compose file itself has no `restart:`, so this was applied live.

### No walls hit. Account is real-name/payment-verified (created RDS + ECS successfully).

---

## 🔵 STEP 6 — FLIPPED TO REAL QWEN (DONE — LIVE, NON-FAKE)

- User set `DASHSCOPE_API_KEY` (`sk-ws****`, 116 chars) in local `.env`.
- Pushed it to the box via **stdin** into `/root/memoryagent/.env` (umask 077; never a shell arg → not in process list / history). Added `DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.
- Uncommented `backend.environment` lines 36-37 in compose (`DASHSCOPE_API_KEY: ${DASHSCOPE_API_KEY}` + `DASHSCOPE_BASE_URL`), `docker compose up -d` recreated backend. In-container check: `KEY_LEN=116`, base = -intl endpoint.
- **`/health` now:** `{"status":"ok","embedder":"text-embedding-v4","narrator":"qwen-plus","embedDim":1024}` — real Qwen, NOT fake-hash-embedder.
- Cleared old fake-embedded rows (`TRUNCATE agent_memory`), re-ingested 2 events (ACME 4 + ByteCraft 3 = count 7) with **real text-embedding-v4 embeddings** (no DashScope auth/region/model errors).
- **Real recall:** `modelId: qwen-plus`, genuine synthesized answer (not the deterministic fake template), real cosine scores (top insight distance 0.29 / score 0.71), `company` filter correctly excluded ByteCraft. Sample answer: _"The hidden payroll cost at ACME SA for 2026-05 is €5,800 — the gap between the bank salary transfer of €10,000 and the true employer cost of €15,800 [2]. This €5,800 wedge represents 28.0% of the bank transfer and consists mostly of employer social-security contributions of €2,800 [1]..."_

**RESULT: valid REAL-Qwen live deployment on Alibaba Cloud (ECS + pgvector) at http://43.106.13.19:9000.** Still open: release RDS orphan `pgm-gs558i717e0f8z6u` once Running; stop/release ECS after demo to cap cost.

## Resource IDs
- ECS instance id: `i-t4ngalzjr5nwtuowbv7y` (ap-southeast-1c, ecs.e-c1m2.large)
- Security group: `sg-t4n2trq33br7znmgs2yf` · Key pair: `archon-mem-kp` (pem `C:/tools/aliyun/archon-mem-kp.pem`)
- VPC/vSwitch: `vpc-t4n52ldyprw3c6s7c0x5o` / `vsw-t4nkxqnrrmnl8sxpijtno`
- RDS orphan (unused, delete once Running): `pgm-gs558i717e0f8z6u`
- DATABASE_URL (masked): `postgresql://postgres:****@db:5432/postgres` (pgvector container)
- **Live public URL: http://43.106.13.19:9000** (REAL Qwen)
