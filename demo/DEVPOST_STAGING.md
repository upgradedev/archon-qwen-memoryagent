# Devpost staging sheet — Archon MemoryAgent

This is the single operator sheet for taking the project to a complete **Draft** on
Devpost without clicking **Submit project**. The official
[rules](https://qwencloud-hackathon.devpost.com/rules) and the live form are
controlling; field labels can change. Do not enter a secret, Qwen Cloud account id, legal name,
country, or other personal data into this public repository.

**Current hard stop:** do not populate a judge-facing “working current build” claim
or capture final media until [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md)
records `aee7897…` as exact-deployed/live-verified. It is currently pending.

## Step 1 — team

- **Solo/team:** `[SELECT IN DEVPOST]`
- **Team members:** `[ADD DIRECTLY IN DEVPOST]`
- If entering as a team or organization, the submitting account must be its
  authorized representative. Complete [`RIGHTS_RELEASE_CHECKLIST.md`](./RIGHTS_RELEASE_CHECKLIST.md).

## Step 2 — overview

| Field | Exact value / artifact |
|---|---|
| Project name | **Archon MemoryAgent — a memory that audits itself** |
| Tagline | **Persistent Qwen memory that recalls, cites, and surfaces its own cross-session contradictions.** |
| Thumbnail | [`thumbnail.png`](./thumbnail.png), 1500×1000 (3:2), PNG, below 5 MB |
| Thumbnail source | [`thumbnail.svg`](./thumbnail.svg), original repository-owned vector |

The tagline is 94 characters, below Devpost's published 140-character limit.
Preview the gallery crop before leaving this step; the title and two conflicting
values must remain readable on a small project card.

## Step 3 — project details

| Field | Exact value / action |
|---|---|
| Built with | **Qwen Cloud, Alibaba Cloud, Qwen, Model Context Protocol (MCP), TypeScript, Fastify, PostgreSQL, pgvector, Docker, OpenAI SDK** |
| Project Story | Paste only the canonical body between the horizontal separators in [`SUBMISSION.md`](./SUBMISSION.md). |
| Try it out | <https://memory.43.106.13.19.sslip.io> |
| Video demo | `[PUBLIC_YOUTUBE_VIMEO_OR_YOUKU_URL]` — public, no login, strictly under 3:00 |
| Image gallery | Upload the approved 1500×1000 files in the order and with the captions in [`SCREENSHOT_MANIFEST.md`](./SCREENSHOT_MANIFEST.md). Do not substitute the 16:9 video proof frames. |
| Public source | <https://github.com/upgradedev/archon-qwen-memoryagent> |
| License | **MIT**; confirm GitHub shows it on the repository landing page. |
| Track/category | **Track 1 — MemoryAgent** |
| Architecture diagram | Upload [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg). |
| Alibaba/Qwen code proof | <https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts> |
| Additional live-deploy code | <https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/deploy/redeploy.sh> |
| Optional blog/social URL | `[PUBLIC_BLOG_OR_SOCIAL_URL]` — must be published and publicly reachable to qualify for the bonus. |

### Existing-project / competition-window answer

Use this if the form asks how an existing project was improved during the
hackathon:

> Archon carries forward an existing product name and financial-analysis context.
> During the competition window we built this standalone Qwen/Alibaba persistent
> MemoryAgent: the pgvector memory store; bounded hybrid retrieval and Qwen
> reranking; field-level and meaning-level self-audits; explicit human conflict
> resolution; feedback, consolidation and forgetting; tenant-scoped REST and MCP
> boundaries; reproducible evaluations; and the Alibaba Cloud deployment and judge
> experience. Upstream extraction/analysis patterns were ported where useful and
> are disclosed; they are not presented as newly created evidence.

### Multiple-submission uniqueness answer

Use this if the form asks about another entry from the same entrant:

> Archon MemoryAgent is a persistent-memory system: it stores and retrieves
> cross-session evidence, surfaces field and meaning-level contradictions, and
> provides reviewer-controlled resolution and forgetting. Archon Autopilot is a
> separate accounts-payable workflow agent whose core is bounded tool use,
> human approval and post-approval execution. The entries have separate codebases,
> demos, narratives and track-specific functionality and are substantially
> different.

### Required developer-tool feedback draft

Use or edit this only if the form asks for tool feedback:

> Qwen Cloud's OpenAI-compatible DashScope surface made it straightforward to use
> text-embedding-v4, qwen-plus and qwen-vl-max through one typed client. The model
> seams also made deterministic offline testing practical. A dedicated reranker was
> not enabled for this account, so the shipped bounded rerank uses one listwise
> qwen-plus call. Clearer per-account model availability and quota metadata would
> make production rollout even easier.

### Fields that must be entered directly, never stored here

- Countries of residence and any other eligibility information.
- Legal names, email addresses and team invitations.
- Qwen Cloud developer/account id.
- The dedicated reviewer credential, and only after its Devpost-field visibility
  is confirmed. Use [`DEVPOST_PRIVATE_TESTING.md`](./DEVPOST_PRIVATE_TESTING.md).
- Any organizer custom question containing personal, contractual or cloud-account
  information.

## Step 4 — additional information / custom questions

The live 2026-07-16 form exposes the following fields. Values marked **human** must
be confirmed by the entrant and entered directly; the repository intentionally does
not guess or retain them.

| Actual Devpost field | Exact value / action |
|---|---|
| Submitter type | `[HUMAN CONFIRM: Individual / Team / Organization]` |
| Organization name | Leave blank only if the confirmed submitter type is Individual/Team and no organization applies. |
| Country of residence | `[HUMAN CONFIRM AND ENTER DIRECTLY]` — appears publicly in the gallery. |
| Newly built or previously existing | **New** — the distinct entry repository starts 2026-07-01; retain the reuse disclosure below. |
| Start date | **07-01-26** |
| Required pre-May-26/update explanation | **Not applicable — this is a new competition-period project started July 1, 2026. It carries forward the Archon name and financial-analysis context only. During the submission period we built the standalone Qwen/Alibaba persistent memory store, hybrid recall and reranking, field- and meaning-level self-audits, explicit human conflict resolution, lifecycle controls, REST/MCP boundaries, evaluations, CI, and live deployment. Reused context is disclosed and is not claimed as newly authored evidence.** |
| Track | **Track 1: MemoryAgent** |
| Code repository | <https://github.com/upgradedev/archon-qwen-memoryagent> |
| Alibaba/Qwen code file | <https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts> |
| Architecture Diagram upload | [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg) |
| Alibaba Deployment Screenshot upload | [`gallery/08-alibaba-runtime-proof.png`](./gallery/08-alibaba-runtime-proof.png), only after `CAPTURE_REVIEW.json` passes for the exact deployment. |
| Published Blog or Social Post | `[PUBLIC_BLOG_OR_SOCIAL_URL]`, only after signed-out verification. |
| AI tools leveraged | **Qwen Cloud models (qwen-plus, qwen-vl-max, text-embedding-v4), OpenAI Codex, and Anthropic Claude.** |
| Learning level | **Significant** |
| Age-of-majority attestation | `[HUMAN LEGAL ATTESTATION REQUIRED]` |
| Eligible-jurisdiction attestation | `[HUMAN LEGAL ATTESTATION REQUIRED]` |
| Sponsor/affiliate/government-employment attestation | `[HUMAN LEGAL ATTESTATION REQUIRED]` |
| Testing Instructions | Paste the public block from [`DEVPOST_PRIVATE_TESTING.md`](./DEVPOST_PRIVATE_TESTING.md), then add the active credential only in this judges-visible field after exact-deploy canaries pass. |

- Confirm every entered answer is English.
- Do not infer privacy from a field name. Save the draft, then inspect its public
  preview logged out before any live credential is added.

## Stop point — complete draft, no submission

The requested handoff point is reached only when every Devpost step is green and
the final page is open, but **Submit project has not been clicked**.

- [ ] Team/entrant details complete.
- [ ] Overview complete; 3:2 thumbnail crop inspected.
- [ ] Story, technology tags, live URL, repository, license and Track 1 complete.
- [ ] Architecture uploaded.
- [ ] Public video URL added and tested logged out.
- [ ] Sanitized gallery uploaded in manifest order.
- [ ] Alibaba/Qwen code-proof link added.
- [ ] Testing instructions added safely; no credential is publicly visible.
- [ ] Optional published blog/social link added.
- [ ] All custom questions complete.
- [ ] Rights/eligibility sign-off complete.
- [ ] Draft preview proofread on desktop and mobile widths.
- [ ] Browser is stopped on the final submission step; **Submit project remains untouched**.
