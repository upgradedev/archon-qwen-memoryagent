# Proof of Alibaba Cloud Deployment

This is the submission's **Proof of Alibaba Cloud Deployment**. It links the exact code that uses Alibaba Cloud services and APIs, and points to the live backend.

## Alibaba Cloud services & APIs used — direct code links

| Alibaba Cloud service | Code | What it does |
|---|---|---|
| **Model Studio / DashScope** (Qwen Cloud inference API) | [`src/qwen/client.ts`](../src/qwen/client.ts) | One OpenAI-compatible client to `dashscope-intl.aliyuncs.com/compatible-mode/v1`; calls **`text-embedding-v4`** (embeddings) and **`qwen-plus`** (RAG narration). |
| **Function Compute** (serverless custom-container HTTP function) | [`deploy/s.yaml`](../deploy/s.yaml) · [`deploy/deploy-fc.sh`](../deploy/deploy-fc.sh) | Builds the container, pushes to Alibaba Container Registry, deploys the backend as an FC HTTP function. |
| **ECS** (live deployment) | [`deploy/redeploy.sh`](../deploy/redeploy.sh) · [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) | docker-compose backend + a pgvector container on an ECS instance behind one public URL. |
| **ApsaraDB RDS / AnalyticDB for PostgreSQL** (pgvector memory store) | [`src/db/schema.sql`](../src/db/schema.sql) · [`src/db/client.ts`](../src/db/client.ts) | pgvector schema (`vector(1024)` + HNSW cosine index). Because it is pg-wire, the identical code runs on a managed RDS instance or the ECS pgvector container. |

## Runtime proof (the basis for the recording)

[`scripts/capture_live.sh`](../scripts/capture_live.sh) drives the **live Alibaba Cloud backend** end-to-end against the deployed URL — health → ingest → cross-session recall → self-audit. Running it (or hitting `GET /health`, which reports the live Qwen model ids) demonstrates the backend answering from Alibaba Cloud.

- **Live backend URL:** provided in the submission form (see [`deploy/DEPLOY_STATE.md`](./../deploy/DEPLOY_STATE.md) for the current address); `GET /health` returns the live `text-embedding-v4` / `qwen-plus` model ids and the 1024-dim vector size.
- **Proof recording (separate from the demo video):** _<add the public link here after recording the live box / Alibaba Cloud console>_

## Single-file link for the submission form

For the form field *"a link to a code file that demonstrates use of Alibaba Cloud services and APIs"*, use:

**`src/qwen/client.ts`** → https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts
