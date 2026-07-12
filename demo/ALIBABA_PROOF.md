# Proof of Alibaba Cloud Deployment

This is the submission's **Proof of Alibaba Cloud Deployment**. It links the exact code that uses Alibaba Cloud services and APIs, and points to the live backend.

## Alibaba Cloud services & APIs used — direct code links

The **live deployed path** is **ECS + a self-hosted pgvector container** (docker-compose, one public URL), using the real Alibaba Cloud Qwen models. The Function Compute + managed ApsaraDB path is a provided serverless **alternative**, not the deployed topology.

| Alibaba Cloud service | Code | What it does |
|---|---|---|
| **Model Studio / DashScope** (Qwen Cloud inference API) — *live* | [`src/qwen/client.ts`](../src/qwen/client.ts) | One OpenAI-compatible client to `dashscope-intl.aliyuncs.com/compatible-mode/v1`; calls **`text-embedding-v4`** (embeddings) and **`qwen-plus`** (RAG narration). Verifiable on the live `GET /health`. |
| **ECS** (live backend host) — *live* | [`deploy/redeploy.sh`](../deploy/redeploy.sh) · [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) | Runs the backend **plus a self-hosted `pgvector` container** via docker-compose on one ECS instance (`ap-southeast-1`) behind a single public URL. **This is the deployed live path.** |
| **pgvector on PostgreSQL** (memory store) — *live* | [`src/db/schema.sql`](../src/db/schema.sql) · [`src/db/client.ts`](../src/db/client.ts) | pgvector schema (`vector(1024)` + HNSW cosine index), running in the self-hosted pgvector container on the ECS box. |
| **Function Compute + ApsaraDB RDS / AnalyticDB for PostgreSQL** (serverless topology) — *alternative, not deployed* | [`deploy/s.yaml`](../deploy/s.yaml) · [`deploy/deploy-fc.sh`](../deploy/deploy-fc.sh) | A provided serverless portability path: build/push the container to Alibaba Container Registry, deploy as an FC HTTP function backed by a managed ApsaraDB RDS memory store. Because the store is pg-wire, it is a drop-in `DATABASE_URL` swap for the ECS pgvector container. Provided for portability; **not the deployed path for this submission.** |

## Runtime proof (the basis for the recording)

[`scripts/capture_live.sh`](../scripts/capture_live.sh) drives the **live Alibaba Cloud backend** end-to-end against the deployed URL — health → ingest → cross-session recall → self-audit. Running it (or hitting `GET /health`, which reports the live Qwen model ids) demonstrates the backend answering from Alibaba Cloud.

- **Live backend URL:** provided in the submission form (see [`deploy/DEPLOY_STATE.md`](./../deploy/DEPLOY_STATE.md) for the current address); `GET /health` returns the live `text-embedding-v4` / `qwen-plus` model ids and the 1024-dim vector size.
- **Proof recording (separate from the demo video):** [`alibaba-proof.mp4`](./alibaba-proof.mp4) — ~35s silent terminal capture showing the ECS instance `Running` in `ap-southeast-1` and both apps answering `GET /health` with the real `text-embedding-v4` / `qwen-plus` model ids over HTTPS.

## Single-file link for the submission form

For the form field *"a link to a code file that demonstrates use of Alibaba Cloud services and APIs"*, use:

**`src/qwen/client.ts`** → https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts
