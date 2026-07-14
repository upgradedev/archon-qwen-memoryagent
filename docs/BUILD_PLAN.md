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
| Submission architecture image | Ready | `architecture.mmd`, `architecture.svg`, `architecture.png` |
| Judge path + private-credential instructions | Ready as copy | [`JUDGE-GUIDE.md`](./JUDGE-GUIDE.md) and media checklist |

Verified full test/coverage result: **300 total, 285 pass, 0 fail, 15 real-DB skips**; **91.96% statements, 84.96% branches, 91.25% functions, 91.96% lines**.

## Final release gate

Immediately before recording or submitting:

1. Deploy the final image.
2. Require `GET /ready` → `200` with database/Qwen/auth checks ready.
3. Require `GET /health` to report `text-embedding-v4` and `qwen-plus`.
4. Confirm `/openapi.json` contains `/ready`, `/ingest/invoice`, `/feedback`, `/consistency/semantic`, `/consolidate`, and `/forget`.
5. Exercise the public seed/recall/rule-audit path and the private-token semantic path.

Do not record against a stale deployment or show a secret in terminal history, Swagger, screenshots, or video.

## Human-owned finish

After the release gate is green, the remaining actions are media and platform work:

- record and publicly host one demo video under three minutes;
- capture the final screenshot set;
- publish the drafted blog/social posts and collect public URLs;
- paste the prepared description, proof-code link, architecture, live URL, video URL, blog URL, track, and private testing credential into Devpost; and
- submit before the deadline and retain the confirmation receipt.

Use [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md) as the single checklist; do not revive the earlier day-by-day sprint plan.
