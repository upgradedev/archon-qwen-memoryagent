# Archon MemoryAgent — final submission plan

**Track:** 1 — MemoryAgent
**Deadline:** **July 20, 2026 at 2:00 PM PDT** (July 21, 00:00 EEST)
**Canonical handoff:** [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md)

## Engineering package

| Deliverable | State | Evidence |
|---|---|---|
| Public MIT repository | Ready | `LICENSE` in repository root |
| Qwen + Alibaba implementation proof | Ready | `src/qwen/client.ts`, `Dockerfile`, compose/deploy assets |
| Persistent/queryable cross-session memory | Ready | `tests/e2e/cross-session.test.ts`, pgvector schema/store |
| Rule + semantic self-audit | Ready | `BENCHMARK.md`, `bench:consistency`, `bench:semantic`, `bench:resolution` |
| Auth, tenant isolation, quotas, idempotency | Ready in source | security/e2e suites and [`CLAIM_EVIDENCE_MATRIX.md`](./CLAIM_EVIDENCE_MATRIX.md) |
| Submission architecture image | Ready | [`judge-architecture.svg`](./judge-architecture.svg) plus [`demo/final-media/judge-architecture.jpg`](../demo/final-media/judge-architecture.jpg); dense appendix in `architecture.*` |
| Judge path + credential instructions | Ready as copy | [`JUDGE-GUIDE.md`](./JUDGE-GUIDE.md) and media checklist; field visibility must be verified before paste |
| Exact live runtime release | **Blocked — redeploy required** | Previous `e4b208a…` proof is historical. Current runtime candidate [`aee7897d4d436501fc9b0dc1ed28e3757131f559`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/aee7897d4d436501fc9b0dc1ed28e3757131f559) contains the selected-company P&L UI fix and is not yet claimed as deployed; see [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md). |

Exact test and coverage values must be copied only from the final immutable CI
artifact. Real-DB slices skip explicitly when no integration database is supplied.

## Final release gate

Immediately before recording or submitting:

1. Confirm [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) still identifies the
   exact runtime-source commit intended for the recording. Redeploy first if runtime
   source changed; documentation-only changes do not require a new runtime image.
2. Require cheap `GET /ready` → `200`, then authenticated `GET /ready/deep` →
   `200` twice to verify database, embedding, narration, and the bounded cache.
3. Require `GET /health` to report `text-embedding-v4` and `qwen-plus`.
4. Confirm `/openapi.json` contains `/ready`, `/ingest/invoice`, `/feedback`, `/consistency/semantic`, `/consolidate`, and `/forget`.
5. Exercise the public seed/recall/rule-audit path and the protected reviewer-credential semantic path.

Do not record against a stale deployment or show a secret in terminal history, Swagger, screenshots, or video.

## Human-owned finish

After the release gate is green, the remaining actions are media and platform work:

- record and publicly host one demo video under three minutes;
- capture the final screenshot set;
- publish the drafted blog/social posts and collect public URLs;
- paste the prepared description, proof-code link, architecture, live URL, video URL, blog URL, track, and dedicated testing credential into Devpost after verifying its field visibility; and
- submit before the deadline and retain the confirmation receipt.

Use [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md) as the single checklist; do not revive the earlier day-by-day sprint plan.
The video-specific execution order is split into
[`../demo/VIDEO_SCRIPT.md`](../demo/VIDEO_SCRIPT.md),
[`../demo/VIDEO_RECORDING_CHECKLIST.md`](../demo/VIDEO_RECORDING_CHECKLIST.md), and
[`../demo/BUILD_RECORDING.md`](../demo/BUILD_RECORDING.md).
