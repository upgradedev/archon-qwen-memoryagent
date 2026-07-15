# Security policy

Archon MemoryAgent handles persistent, tenant-scoped memory and can invoke paid Qwen
model operations. Security reports are welcome. Please do not test destructively
against the public judging deployment or include credentials, personal data, or real
customer/financial records in a report.

## Supported version

Security fixes target the current `main` branch. The exact live runtime source and
secret-safe verification state are recorded in
[`deploy/DEPLOY_STATE.md`](./deploy/DEPLOY_STATE.md). The final verified live
runtime-source commit is
[`e4b208a63e1768409e5b94fe305a3672c4c96dcd`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/e4b208a63e1768409e5b94fe305a3672c4c96dcd).
Documentation-only descendants may move repository HEAD without changing that
runtime identity.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Email
[`info@upgrade.net.gr`](mailto:info@upgrade.net.gr) with subject
`[SECURITY] archon-qwen-memoryagent` and include:

- the affected route/component and commit;
- reproduction steps using synthetic data;
- impact and required preconditions;
- whether the public deployment was touched; and
- any suggested mitigation.

Do not attach live tokens or cloud credentials. Redact request headers and tenant
identifiers. We will acknowledge and coordinate remediation/disclosure on a
best-effort basis; no public disclosure timeline should be assumed until a fix is
available and affected credentials or deployments have been rotated.

## Security boundaries

- Public data operations are limited to a fixed idempotent demo plus public-tenant
  reads; the UI, documentation, health/readiness, and OpenAPI discovery are also public.
- Production writes, feedback, semantic audit, human conflict resolution, and
  lifecycle operations require a server-mapped reviewer credential.
- Streamable HTTP MCP is authenticated and tenant-scoped. stdio is trusted-local,
  explicit opt-in in production, and still quota/result bounded.
- Qwen-heavy HTTP/MCP operations use durable per-principal/IP and global work-unit
  quotas. These are admission controls, not billing counters or a permanent audit log.
- Production fails closed without real Qwen configuration and judge authentication;
  `/ready` is the release gate.
- The runtime database identity is non-superuser/DML-only and is denied access to the
  neighbouring application database.
- Audit recommendations do not silently mutate memory. Confirmed conflict resolution,
  feedback, consolidation, and forgetting are separate authenticated operations with
  idempotency/provenance controls.

See [`README.md`](./README.md),
[`docs/CLAIM_EVIDENCE_MATRIX.md`](./docs/CLAIM_EVIDENCE_MATRIX.md), and the security
test suites under [`tests/security/`](./tests/security/) for the exact supported
claims. This policy does not claim that any system is vulnerability-free.

## Secrets and submission media

Never commit or publish `.env` files, DashScope/API/reviewer credentials, database
URLs, Authorization headers, cloud/instance identifiers, terminal history, or raw
captures containing them. Raw recording material belongs only under the ignored
`demo/private-originals/` path; sanitized finals belong in the documented media
paths after frame-by-frame review. Reviewer credentials go only in the verified
testing-credential channel, never in the public description, video, screenshots,
posts, URLs, captions, or metadata. Do not assume a Devpost field is private: confirm
visibility before paste, use a dedicated low-privilege/quota-bounded judging
credential, and rotate or revoke it after judging (immediately if a logged-out
preview exposes it).
