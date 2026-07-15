# Archon MemoryAgent — Devpost submission description

*Paste the body below as the canonical Devpost Project Story for Track 1
(MemoryAgent), approximately 600 words. Do not substitute
[`PROJECT_STORY.md`](./PROJECT_STORY.md); that file is the long-form evidence story.*

Submission operators should use the [official rules](https://qwencloud-hackathon.devpost.com/rules)
and [official schedule](https://qwencloud-hackathon.devpost.com/details/dates) as
the controlling references. Public video/blog URLs and any dedicated reviewer
credential belong in their dedicated Devpost fields, not in the description below;
verify credential-field visibility rather than assuming it is private.
Final paste is allowed only while [`deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md)
records the verified runtime source, the pre-recording smoke is green, and any later
repository commits are documentation, sanitized submission media, or non-runtime
recording tooling only.

---

## Archon MemoryAgent — a memory that audits itself

**AI agents and assistants forget the moment a session ends** — and when they *do*
carry facts forward, they silently contradict themselves. One session records a
figure as €18,000; a later session records €19,000 for the same record; plain vector
recall just returns whichever ranked higher and stays quiet. Anyone building agents
that must stay consistent over time — support copilots, research assistants,
financial-document pipelines — inherits a memory they can't trust. **Archon
MemoryAgent** is a persistent, queryable, cross-session memory that recalls grounded,
cited answers **and audits its own memory for contradictions**. The audit recommends
which value to trust without mutation; an authenticated reviewer can separately
accept or override that recommendation through one atomic, idempotent decision.
Its domain-neutral audit and tenant-scoped REST/MCP/pg-wire seams make the MIT core
reusable beyond this financial proof without claiming unmeasured production scale.

### What it does

- **Cross-session recall for limited context**: memories are embedded with
  `text-embedding-v4` and stored in **pgvector**; a fresh process retrieves a bounded,
  relevant slice (maximum 20) and grounds a `qwen-plus` answer in cited memories. A
  cross-session e2e test proves session B recalls what session A wrote and tore down.
- **Self-auditing memory (the headline)**: `POST /consistency` is a pure,
  domain-neutral engine that flags cross-session contradictions and dangling
  references, then **recommends** which value to trust over a fixed
  importance → source-authority → recency ladder — read-only, never mutating.
  Measured: **5/5 detected, 0 false positives; 4/4 declared-policy conformance.**
- **Meaning-level self-audit**: a companion `POST /consistency/semantic` catches
  memories that oppose each other in *meaning* with no shared field (*"pays on
  time"* vs *"chronically late"*): it embeds each memory, keeps same-subject pairs
  by cosine, then asks the configured **`QWEN_JUDGE_MODEL`** online, a deterministic polarity
  heuristic offline — whether they contradict, reusing the same read-only
  resolution ladder and **never mutating**. The HTTP route is authenticated and
  quota-bounded; the same operation is reachable over authenticated HTTP MCP
  (`audit_memory` with `semantic: true`) and seeded into the live demo. Honest
  scope: proven mechanism + working live demo + a labelled offline regression set;
  its offline 90% recall/100% precision figures describe the deterministic judge.
- **Feedback and forgetting**: authenticated feedback protects a correct memory or
  atomically supersedes an incorrect one. Consolidation and retention endpoints are
  tenant-scoped, preview by default, and require `confirm=true` before mutation.
- **Strong retrieval**: hybrid dense + lexical (RRF) with a `qwen-plus` cross-encoder
  re-rank. Reranked-hybrid beats a strong dense baseline — MRR 0.883 → 0.911,
  Recall@3 90.0% → 96.7% — on a frozen labelled benchmark, gated in CI.
- **Honest positioning**: a pinned probe vs Mem0 (retrieval parity; no separately
  named contradiction/resolution method matched the disclosed `dir()` probe) with Zep cited — the differentiator
  is a portable, explainable, read-only audit plus explicit human resolution.

The public judge path provides a fixed, idempotent seed plus public-tenant recall
and field audit with bounded quotas. Mutations, semantic audit, and lifecycle use
the dedicated reviewer credential supplied in the Devpost testing instructions.

Reuse boundary: the entry carries forward the Archon name/product context and
ports upstream extraction/analysis pipeline patterns. The contest-entry work
recorded here for the judged capability is the Qwen/Alibaba-backed persistent
MemoryAgent, its self-audit/resolution/lifecycle/MCP boundaries, evaluations, and
deployment path. Reused product context is not presented as evidence of novelty.

This entry was materially built during the competition window. The repository
history begins with commit `6ec9389` on 2026-07-01, after the 2026-05-26
competition opening. This establishes only the repository's recorded timing;
repository history alone is not proof of authorship, originality, or completeness.

### Qwen Cloud usage

`text-embedding-v4` (embeddings) · `qwen-plus` (RAG narration + cross-encoder rerank)
· health-visible `QWEN_JUDGE_MODEL` (semantic judge; `qwen-plus` rollback baseline)
· `qwen-vl-max` (document-ingestion vision extractor) — via the OpenAI-compatible
DashScope endpoint.

**Live:** https://memory.43.106.13.19.sslip.io · **Track 1 (MemoryAgent)** · Repo:
https://github.com/upgradedev/archon-qwen-memoryagent

---

**Operator-only Alibaba Cloud proof reference (use the dedicated form field):** the DashScope OpenAI-compatible client (base URL + Qwen
instantiation) is
[`src/qwen/client.ts`](https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts);
app-specific runtime proof recording: `demo/gallery/memoryagent-alibaba-runtime-proof.mp4` (to be captured from the verified live deployment during final media production; raw console footage stays ignored under `demo/private-originals/`).
