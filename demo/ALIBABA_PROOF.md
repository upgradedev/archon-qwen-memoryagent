# Proof of Alibaba Cloud Deployment

This is the submission's **Proof of Alibaba Cloud Deployment**. It links the exact code that uses Alibaba Cloud services and APIs, and points to the live backend.

## Alibaba Cloud services & APIs used — direct code links

The **live deployed path** is **ECS + a self-hosted pgvector container** (docker-compose, one public URL), using the real Alibaba Cloud Qwen models. The Function Compute + managed ApsaraDB path is a provided serverless **alternative**, not the deployed topology.

The organizer's [official Qwen Cloud resources](https://qwencloud-hackathon.devpost.com/resources)
publish `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` as the
OpenAI-compatible API base URL. [`src/qwen/client.ts`](../src/qwen/client.ts) defaults
to and allowlists that exact endpoint alongside the supported official regional
hosts; this is the qualifying Qwen Cloud path, not an
unrelated provider-compatible proxy.

| Alibaba Cloud service | Code | What it does |
|---|---|---|
| **Model Studio / DashScope** (Qwen Cloud inference API) — *live* | [`src/qwen/client.ts`](../src/qwen/client.ts) + [`src/pipeline/vision.ts`](../src/pipeline/vision.ts) | OpenAI-compatible client for **`text-embedding-v4`**, **`qwen-plus`** narration/rerank/skills, an independently configured semantic **`QWEN_JUDGE_MODEL`**, and **`qwen-vl-max`** vision extraction. `qwen-plus` is the judge rollback baseline; a candidate may replace only that setting after the frozen promotion gate. All active model ids are verifiable on live `GET /health`; `/ready` proves a non-Fake provider is configured. |
| **ECS** (live backend host) — *live* | [`deploy/redeploy.sh`](../deploy/redeploy.sh) · [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) | Runs the backend **plus a self-hosted `pgvector` container** via docker-compose on one ECS instance (`ap-southeast-1`) behind a single public URL. **This is the deployed live path.** |
| **pgvector on PostgreSQL** (memory store) — *live* | [`src/db/schema.sql`](../src/db/schema.sql) · [`src/db/client.ts`](../src/db/client.ts) | pgvector schema (`vector(1024)` + HNSW cosine index), running in the self-hosted pgvector container on the ECS box. |
| **Function Compute + ApsaraDB RDS / AnalyticDB for PostgreSQL** (serverless topology) — *alternative, not deployed* | [`deploy/s.yaml`](../deploy/s.yaml) · [`deploy/deploy-fc.sh`](../deploy/deploy-fc.sh) | A provided serverless portability path: build/push the container to Alibaba Container Registry, deploy as an FC HTTP function backed by a managed ApsaraDB RDS memory store. Because the store is pg-wire, it is a drop-in `DATABASE_URL` swap for the ECS pgvector container. Provided for portability; **not the deployed path for this submission.** |

## Runtime provenance — current-source redeploy pending

The previous live MemoryAgent runtime source was exact commit
[`e4b208a63e1768409e5b94fe305a3672c4c96dcd`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/e4b208a63e1768409e5b94fe305a3672c4c96dcd).
Exact deploy attempt 8 passed checkout/build, schema/grants, DML-only runtime
identity, cross-application denial, health/readiness, real-embedding grounded recall
with cleanup, and public UI/health/ready TLS verification. The subsequent public v4
seed reconciled one EUR P&L bucket with zero unknown-currency records and was
idempotent on the second call. Current `main` candidate
[`aee7897d4d436501fc9b0dc1ed28e3757131f559`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/aee7897d4d436501fc9b0dc1ed28e3757131f559)
contains a runtime UI fix and is **not yet claimed as deployed or verified**. The
secret-safe operational record is [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md);
recording and submission stay blocked until it records the new exact deployment.

Use the release gate in [`FINAL_MEDIA_CHECKLIST.md`](./FINAL_MEDIA_CHECKLIST.md): `/ready` must report database/Qwen/auth ready, `/health` must report the real Qwen model ids, and the public plus protected reviewer-credential paths must pass. Protected writes and semantic audit require the dedicated judging credential; do not record or publish it. The optional `Generate Authenticated Demo Video` workflow consumes that value only from the private `MEMORYAGENT_JUDGE_API_KEY` Actions secret and never renders it; its artifact still requires the same final human review.

- **Live backend URL:** provided in the submission form (see [`deploy/DEPLOY_STATE.md`](./../deploy/DEPLOY_STATE.md) for the current address); `GET /health` returns the active embedding, narration, and semantic-judge model ids plus the 1024-dim vector size.
- **Proof image (also reusable as a final-video proof frame):** generate the MemoryAgent-specific `demo/gallery/08-alibaba-runtime-proof.png` only after the candidate is exact-deployed and verified. The compositor requires the same deploy-controller SHA/status/output, a sanitized Alibaba console capture, MemoryAgent `/ready`, `/health` with all three active model ids, and the MemoryAgent URL. Do not reuse another entry's proof. Keep raw console capture in ignored `demo/private-originals/`; only the sanitized composite belongs in `demo/gallery/`.

## Single-file link for the submission form

For the form field *"a link to a code file that demonstrates use of Alibaba Cloud services and APIs"*, use:

**`src/qwen/client.ts`** → https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts
