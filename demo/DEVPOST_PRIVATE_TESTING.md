# Devpost testing instructions — safe copy/paste template

This tracked file contains **placeholders only**. Never commit, screenshot, log or
paste a real reviewer credential here. The public app already provides a complete
no-login Track 1 path; the credential unlocks additional protected operations.

## Block A — safe public testing instructions

Paste this block into the testing-instructions field in every case:

> **Archon MemoryAgent judge path (no login required)**<br>
> Open https://memory.43.106.13.19.sslip.io and click **Run demo** once. This action
> uses a fixed, idempotent seed that accepts no caller-controlled content and
> automatically submits the bounded `company=Northwind Trading`, `limit=3` recall.
> Inspect the resulting grounded Qwen answer and its resolved numbered citations;
> do not submit the recall question a second time. Click **Run self-audit** to see
> `INV-5521.amount` stored as `8400` and
> `8900`; the read-only audit keeps both memories visible and recommends `8900`
> under its declared recency policy. It does not mutate either memory.
>
> Readiness: https://memory.43.106.13.19.sslip.io/ready<br>
> Active models: https://memory.43.106.13.19.sslip.io/health<br>
> API docs: https://memory.43.106.13.19.sslip.io/docs<br>
> Detailed guide: https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/docs/JUDGE-GUIDE.md

## Block B — protected path, use only through a confirmed non-public channel

Before using this block, confirm the actual Devpost field is visible only to the
organizer/judges. A custom-question label such as “testing instructions” is not by
itself proof of privacy. If visibility cannot be confirmed, do **not** paste a live
secret; ask the organizer for a secure credential channel and keep Block A only.

Replace the placeholder in Devpost itself, never in a local or tracked file:

> **Protected semantic audit and lifecycle**<br>
> Dedicated low-privilege reviewer token: `{{ENTER_DIRECTLY_IN_CONFIRMED_PRIVATE_FIELD}}`<br>
> In the Explorer, enter the token in the password-type field labeled
> **Reviewer token (protected audit/feedback)** and click **Run semantic audit**.
> The fixed demo compares “always pays on time” with “chronically late” and returns
> the configured Qwen judge's read-only result with
> completion/model provenance. Clear the field immediately after use. The same
> credential can inspect tenant-scoped feedback, conflict resolution,
> consolidation and forgetting; lifecycle calls preview by default and require
> `confirm=true`, an operation id and an explicit reason before mutation.

## Credential release gate

- [ ] Credential is dedicated to judging, not reused from an admin/cloud account.
- [ ] It maps server-side to one bounded judge tenant and has no cross-tenant access.
- [ ] It is covered by per-principal/global quotas and in-flight admission limits.
- [ ] It was tested once without being placed in shell history or process arguments.
- [ ] The saved Devpost preview was inspected logged out and did not expose it.
- [ ] It will remain valid and free of charge through August 11, 2026 at 2:00 PM PDT.
- [ ] Rotation/revocation is scheduled immediately after judging, or immediately on exposure.

If the token is ever visible in a public preview, screenshot, video, browser history,
log, Actions artifact or post, rotate it before continuing; redaction alone is not
sufficient.
