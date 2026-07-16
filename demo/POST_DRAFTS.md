# Archon MemoryAgent — ready-to-publish post drafts

Replace only bracketed placeholders after the video/blog is public. All numerical claims below match the committed evidence matrix.

## Short launch post (X / Bluesky)

AI memory shouldn't hide its own conflicts. Archon MemoryAgent gives Qwen persistent pgvector recall, cited answers, and read-only contradiction recommendations. Live: https://memory.43.106.13.19.sslip.io #QwenCloudHackathon

## Video launch post (X / Bluesky)

In our original synthetic demo, one session remembers €8,400 and another €8,900. Archon MemoryAgent surfaces both and recommends—without rewriting history. Video: [PUBLIC_VIDEO_URL] Live: https://memory.43.106.13.19.sslip.io #QwenCloudHackathon

## LinkedIn launch post

Most agent-memory demos prove that a fact can be written in one session and retrieved in another. We focused on the harder problem: what happens when the agent's own memories disagree?

For the Global AI Hackathon Series with Qwen Cloud, we built **Archon MemoryAgent**:

- persistent, tenant-scoped pgvector memory across sessions;
- hybrid dense + lexical retrieval with Qwen reranking and cited answers;
- a deterministic field-level self-audit that detects conflicts and recommends which value to trust without mutating either memory;
- an additive Qwen meaning-level audit for contradictions with no shared field;
- explicit feedback, dry-run/confirm forgetting, authenticated HTTP MCP, and currency-safe financial evidence.

The claims are measured: 5/5 field-level injected problems with 0 false positives; 4/4 labelled resolution-policy results; and an offline meaning-level benchmark at 90% recall, 100% precision, and 0 false positives. That semantic score is deliberately reported as an offline deterministic-judge result—not live-Qwen accuracy.

Live demo: https://memory.43.106.13.19.sslip.io
Public repo: https://github.com/upgradedev/archon-qwen-memoryagent
Video: [PUBLIC_VIDEO_URL]
Technical write-up: [PUBLIC_BLOG_URL]

#Qwen #AlibabaCloud #AIAgents #RAG #MCP #PostgreSQL #pgvector

## Public blog teaser

**Title:** Memory that audits itself: a Qwen MemoryAgent you can actually trust

**Subtitle:** Persistent recall is the easy half. Archon audits cross-session conflicts read-only, recommends a resolution, and lets a reviewer apply a separate atomic decision—with reproducible evidence for each claim.

**Excerpt:**

An agent can retrieve the “right” vector and still be wrong if another stored memory says the opposite. This post walks through a read-only consistency engine, an additive meaning-level Qwen audit, hybrid pgvector retrieval, tenant/auth boundaries, and the measurement choices that keep the claims honest.

**Suggested canonical article:** publish [`BLOG.md`](./BLOG.md) on a public platform, upload the rendered architecture image, and end with:

> Try the public demo at https://memory.43.106.13.19.sslip.io and inspect the MIT-licensed source at https://github.com/upgradedev/archon-qwen-memoryagent. Track 1: MemoryAgent, Global AI Hackathon Series with Qwen Cloud.

## Video description

Archon MemoryAgent is a Track 1 submission for the Global AI Hackathon Series with Qwen Cloud. It stores persistent cross-session memories in pgvector, recalls grounded answers with Qwen citations, and audits its own memory for field-level and meaning-level contradictions—returning a read-only resolution recommendation rather than silently rewriting history.

Live: https://memory.43.106.13.19.sslip.io
Source (MIT): https://github.com/upgradedev/archon-qwen-memoryagent
Architecture: https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/docs/judge-architecture.svg
Alibaba/Qwen code proof: https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts
Technical post: [PUBLIC_BLOG_URL]

Models: `text-embedding-v4`, `qwen-plus` narration/rerank/skills, the health-visible configured semantic judge (`qwen-plus` rollback baseline), and `qwen-vl-max` via Alibaba Cloud Model Studio / DashScope.

## Devpost project update

Final release update: Archon MemoryAgent now ships server-owned tenant isolation, authenticated mutations and semantic audit, durable weighted Qwen quotas, exact invoice idempotency, explicit human conflict resolution, dry-run/confirm memory lifecycle, authenticated HTTP MCP, and mixed-currency-safe P&L. Exact test/coverage values are linked from the final immutable CI run. Demo: [PUBLIC_VIDEO_URL]
