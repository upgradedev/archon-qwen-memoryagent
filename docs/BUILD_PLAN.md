# Archon MemoryAgent — Build Plan (8-day sprint)

**Hackathon:** Global AI Hackathon Series with Qwen Cloud — **MemoryAgent** track.
**Deadline:** **July 9, 2026 @ 2:00pm PDT** (authoritative Devpost). Prize pool $70K+ ($7K cash + $3K credits per track). Entrant eligible.

## Deliverables (from the rules)

1. Public open-source repo (MIT) — **done** (this repo).
2. Proof the backend runs on **Alibaba Cloud** — short recording. **User-gated** (needs account).
3. **Architecture diagram** — in `README.md` (ASCII) + a polished image for the video.
4. **~3-minute video** demonstrating the submission functioning. **User-gated**.
5. **Track identification** — MemoryAgent, stated in README + Devpost form.

## Confirmed requirements (research, 2026-07-01)

- **Qwen models:** `text-embedding-v4` (embeddings — default **1024** dims, range 64–2048; matches `vector(1024)`) + `qwen-plus` (chat/narration; `qwen-max`/`qwen-turbo` alternatives).
- **Endpoint:** OpenAI-compatible, `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (international). Key env `DASHSCOPE_API_KEY`. Works with the standard `openai` SDK.
- **Alibaba Cloud deployment:** the *compute* must run on Alibaba Cloud. **The live deployment landed on ECS + docker-compose** (backend container + a self-hosted pgvector container, one public URL; see `deploy/DEPLOY_STATE.md` and `deploy/redeploy.sh`) — fastest, most reliable single public URL for the hackathon bar. A **Function Compute** custom-container HTTP function (serverless, HTTP trigger on CAPort, ACR image, `s deploy`) is kept as a clearly-labelled alternative (`deploy/s.yaml`, `deploy/deploy-fc.sh`).
- **Memory store:** **pgvector on PostgreSQL, running on Alibaba Cloud** — self-hosted `pgvector/pgvector` container on the ECS box for the live deploy; because it is pg-wire, the identical code also runs on a managed **AnalyticDB / ApsaraDB RDS** instance (the FC alternative), a `DATABASE_URL` swap. DashVector deferred (stronger pure-Alibaba story, but new API + deadline).

## Architecture

`MemoryAgent(embedder, store, narrator)` — all injectable.
- **embedder:** `QwenEmbedder` (real) / `FakeEmbedder` (offline), auto-selected on `DASHSCOPE_API_KEY`.
- **store:** `PgVectorStore` (pgvector SQL) / `InMemoryStore` (unit tests).
- **narrator:** `QwenNarrator` (qwen-plus RAG) / `FakeNarrator` (offline).
- **HTTP:** `src/server.ts` (Fastify) → `/health`, `/ingest`, `/recall`. This is the FC deploy artifact.

## Status

| Slice | State |
|---|---|
| Scaffold + config + MIT + CI (gitleaks → typecheck → pyramid) | ✅ done |
| `QwenEmbedder` + `FakeEmbedder` (+ auto-select) | ✅ done |
| `QwenNarrator` + `FakeNarrator` (+ auto-select) | ✅ done |
| `MemoryStore` (`PgVectorStore` + `InMemoryStore`) + pgvector schema (HNSW) | ✅ done |
| `MemoryAgent` ingest/recallAnswer | ✅ done |
| HTTP backend + Dockerfile + docker-compose | ✅ done |
| Test pyramid: 17 unit (local ✓) + integration + e2e cross-session (CI/pgvector) | ✅ done |
| FC deploy assets (`s.yaml`, `deploy-fc.sh`) | ✅ done (user-gated to run) |
| CI green on GitHub | ⏳ verify after push |

## Timeline to July 9

- **Day 1–2 (done):** research, scaffold, memory layer, test pyramid, CI, HTTP backend, deploy assets.
- **Day 3 (user-gated):** provision Alibaba PostgreSQL (pgvector) + Model Studio key; `deploy-fc.sh`; verify `/health` + `/recall` live with **real Qwen**.
- **Day 4:** real-Qwen recall-quality check; tune `qwen-plus` prompt; optional per-tenant vector indexing note.
- **Day 5:** polish architecture diagram (image), record the ~3-min video (ingest in one session → recall in a new one → hidden-cost answer), capture the Alibaba-Cloud-running recording.
- **Day 6:** blog/write-up; Devpost form (track = MemoryAgent, repo URL, video, diagram, deployment proof).
- **Day 7–8:** buffer + submit before **July 9 2:00pm PDT**.

## What the user must provide

1. **Alibaba Cloud account** + AccessKey (`ALIBABA_CLOUD_ACCESS_KEY_ID` / `_SECRET`) + an **ACR namespace** (region `ap-southeast-1`).
2. **Model Studio (DashScope) API key** — `DASHSCOPE_API_KEY` (claim hackathon credits via the Devpost coupon form).
3. An **Alibaba PostgreSQL** instance with pgvector (AnalyticDB for PostgreSQL, or ApsaraDB RDS for PostgreSQL) → its `DATABASE_URL`.
4. Region confirmation (default `ap-southeast-1` / Singapore, matching the intl Qwen endpoint).

Everything else (code, CI, tests, deploy scripts) is done and CI-gated.
