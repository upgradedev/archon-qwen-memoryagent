# Archon MemoryAgent: canonical Devpost draft

*Paste the body below as the canonical Devpost Project Story for Track 1
(MemoryAgent), approximately 750 words. Do not substitute
[`PROJECT_STORY.md`](./PROJECT_STORY.md); that file is the long-form evidence story.*

All other form fields, custom-question answers and the deliberate pre-submit stop
point are staged in [`DEVPOST_STAGING.md`](./DEVPOST_STAGING.md). Testing-copy and
credential handling are isolated in
[`DEVPOST_PRIVATE_TESTING.md`](./DEVPOST_PRIVATE_TESTING.md).

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

## Memory that calls out its own contradictions

We built **Archon MemoryAgent** after seeing a persistent-memory demo fail in a
more dangerous way than forgetting. Separate sessions assigned different values
to the same `INV-5521.amount` field, and plain vector recall returned whichever
ranked higher without revealing the conflict. Support copilots, research assistants,
and financial-document pipelines all inherit that failure mode when they must stay
consistent over time. Archon is a persistent, queryable, cross-session memory that
recalls grounded, cited answers **and audits its own memory for contradictions**.
The audit recommends which value to trust without mutation. An authenticated reviewer can separately
accept or override that recommendation through one atomic, idempotent decision.
Its domain-neutral audit and tenant-scoped REST/MCP/pg-wire seams make the MIT core
reusable beyond this financial proof without claiming unmeasured production scale.

### What happens when facts disagree

- **Cross-session recall for limited context**: memories are embedded with
  `text-embedding-v4` and stored in **pgvector**; a fresh process retrieves a bounded,
  relevant slice (maximum 20) and grounds a `qwen-plus` answer in cited memories. A
  cross-session e2e test proves session B recalls what session A wrote and tore down.
- **Self-auditing memory**: `POST /consistency` is a pure,
  domain-neutral engine that flags cross-session contradictions and dangling
  references, then **recommends** which value to trust over a fixed
  importance → source-authority → recency ladder. It remains read-only and never mutates memory.
  Measured: **5/5 detected, 0 false positives; 4/4 declared-policy conformance.**
- **Meaning-level self-audit**: a companion `POST /consistency/semantic` catches
  memories that oppose each other in *meaning* with no shared field (*"pays on
  time"* vs *"chronically late"*): it embeds each memory, keeps same-subject pairs
  by cosine, then asks the configured **`QWEN_JUDGE_MODEL`** online, or runs a
  deterministic polarity heuristic offline, to judge whether they contradict,
  reusing the same read-only
  resolution ladder and **never mutating**. The HTTP route is authenticated and
  quota-bounded; the same operation is reachable over authenticated HTTP MCP
  (`audit_memory` with `semantic: true`) and seeded into the live demo. The Explorer
  makes its judge-facing scope explicit: it scans at most one eligible, highest-similarity
  `insight` pair with `maxPairs: 1`. What we can show is narrower: a working
  mechanism, a live demo, and a labelled offline
  regression set. Its offline 90% recall/100% precision figures describe the deterministic judge.
- **Feedback and forgetting**: authenticated feedback protects a correct memory or
  atomically supersedes an incorrect one. The final live gate stores a Session-A
  correction, then requires a fresh Session-B request to recall and cite it. This is
  durable state, not autonomous training or model-weight learning. Retention preview selects
  exactly one synthetic superseded candidate before one audited deletion; protected
  state must remain unchanged and exact-marker cleanup must reach zero.
- **Strong retrieval**: hybrid dense + lexical (RRF) with one bounded listwise
  `qwen-plus` re-rank call. On the frozen labelled fixture, reranked-hybrid beats
  the explicit dense condition: MRR 0.883 → 0.911, Recall@3 90.0% → 96.7%.
  CI separately gates fixture-bound hybrid Recall@3/@5 ≥ dense; it does not claim
  that relationship universally.
- **What the comparison shows**: the pinned Mem0 probe found retrieval parity, and no
  separately named contradiction/resolution method matched the disclosed `dir()`
  probe. Zep is cited rather than claimed as a run. The differentiator is a portable,
  explainable, read-only audit plus explicit human resolution.
- **What the release proves**: exact source `0910ab7…` is live-verified from
  project-contained attempt 27. Alibaba Cloud Assistant finished successfully with
  exit code `0`. Its retained log ends at the SHA-bound application marker rather
  than the aggregate final marker, so this is verified success with a truncated
  provider log. A separately published
  earlier exact release completed a live, read-only k6 ramp with 342 requests, 42 grounded Qwen
  recalls and zero HTTP failures; that modest profile is stability evidence, not a
  saturation or maximum-capacity claim. Exact test/coverage totals come only from the
  submitted commit's immutable CI artifact.

The public judge path provides a fixed, idempotent seed plus public-tenant recall
and field audit with bounded quotas. Mutations, semantic audit, and lifecycle use
the dedicated reviewer credential supplied in the Devpost testing instructions.

This project carries forward the Archon name/product context and ports upstream
extraction/analysis pipeline patterns. The contest-entry work
recorded here for the judged capability is the Qwen/Alibaba-backed persistent
MemoryAgent, its self-audit/resolution/lifecycle/MCP boundaries, evaluations, and
deployment path. Reused product context is not presented as evidence of novelty.

This entry was materially built during the competition window. The repository
history begins with commit `6ec9389` on 2026-07-01, after the 2026-05-26
competition opening. This establishes only the repository's recorded timing;
repository history alone is not proof of authorship, originality, or completeness.

### Where Qwen Cloud is used

`text-embedding-v4` (embeddings) · `qwen-plus` (RAG narration + bounded listwise rerank)
· health-visible `QWEN_JUDGE_MODEL` (semantic judge; `qwen-plus` rollback baseline)
· `qwen-vl-max` (document-ingestion vision extractor), all through the OpenAI-compatible
DashScope endpoint. The final release-bound canary sends an original synthetic
payroll-register + bank-confirmation PNG pair through protected `dryRun`, requires
response-reported `qwen-vl-max` and one fused event, then proves zero writes and
zero marker residue.

**Live:** https://memory.43.106.13.19.sslip.io · **Track 1 (MemoryAgent)** · Repo:
https://github.com/upgradedev/archon-qwen-memoryagent

---

**Operator-only Alibaba Cloud proof reference (use the dedicated form field):** the DashScope OpenAI-compatible client (base URL + Qwen
instantiation) is
[`src/qwen/client.ts`](https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts);
app-specific runtime proof image: `demo/gallery/10-alibaba-runtime-proof.png` (generated only from exact-deploy controller evidence plus sanitized Alibaba console, live readiness, and the response-reported qwen-vl-max dry-run canary; raw captures stay ignored under `demo/private-originals/`).
