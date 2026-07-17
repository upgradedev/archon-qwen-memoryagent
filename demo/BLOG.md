# We built a Qwen MemoryAgent that challenges its own memory

*Global AI Hackathon Series with Qwen Cloud, MemoryAgent track.*

<!--
PUBLISHER-ONLY CHECKLIST: remove this comment before publishing:

- [ ] Publish from the final default branch; do not paste from an unmerged worktree.
- [ ] Keep the absolute architecture-image URL below. Open it in a signed-out/private
      browser and confirm that the 1600×900 image renders without a GitHub login.
- [ ] Open https://memory.43.106.13.19.sslip.io and the repository CTA in a
      signed-out/private browser. Confirm the landing page, public health state, and
      linked source are reachable without an access request.
- [ ] Run every outbound link through a signed-out/private window; remove any draft,
      localhost, credential-bearing, or private-console URL.
- [ ] Replace {{PUBLIC_VIDEO_URL}} and {{DEVPOST_PROJECT_URL}} only after those pages
      are public, then add them to the optional CTA sentence below.
- [ ] Confirm the published post visibly credits Qwen Cloud / Alibaba Cloud and add
      its final public URL to the Devpost blog/social field.
- [ ] Save a signed-out screenshot of the published article under the project-local,
      ignored `demo/private-originals/publication/` directory; never store login
      tokens or private console data.

Optional sentence after both placeholders resolve:
“Watch the under-three-minute demo at {{PUBLIC_VIDEO_URL}} and see the competition
entry at {{DEVPOST_PROJECT_URL}}.”
-->

Most "agent memory" demos prove one useful thing: the agent can write a fact in
one session and read it back in another. That matters, but it is only the first
half of the problem. We wanted to know what happens when the agent's own memory
starts to **disagree with itself**.

A cross-session agent accumulates facts from many separate write events, over
days, across processes. Nothing stops two of those writes from recording the same
record two different ways: in the original synthetic demo, separate sessions assign
different values to the same `INV-5521.amount` field. A plain vector store may return
whichever one happened to rank higher without surfacing the conflict. The caller sees
a confident answer without the conflicting provenance.

**Archon MemoryAgent** is our entry for the MemoryAgent track, built on Qwen
(`text-embedding-v4` + `qwen-plus`) with a pgvector memory layer, running live on
Alibaba Cloud. Cross-session persistence is there, and the distinctive part is the
self-audit: **the memory audits itself.**

## The architecture, including the trust boundary

This diagram shows the ingestion pipeline, MemoryAgent core, and Qwen Cloud / Alibaba Cloud integration:

![Archon MemoryAgent judge architecture](https://raw.githubusercontent.com/upgradedev/archon-qwen-memoryagent/main/demo/final-media/judge-architecture.jpg)

The trust boundary matters as much as the model graph. The public surface is a fixed,
idempotent demo plus public-tenant reads; public seed and recall are quota-bounded.
Writes, feedback, lifecycle operations, meaning-level audit, and Streamable HTTP MCP
are authenticated and mapped to a tenant by the server. The event linker groups by
`company + period + event_ref`, and P&L totals stay separated by currency.
The judge-facing image above is the canonical 16:9 submission hero. Its editable
source is public in
[`docs/judge-architecture.svg`](https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/docs/judge-architecture.svg);
the denser technical appendix and its PNG/SVG renders are generated from
[`docs/architecture.mmd`](https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/docs/architecture.mmd).

## The key idea: detect, explain, recommend

The agent exposes `POST /consistency`, a pure, domain-neutral audit over its own
active memories. It groups memories by the record they describe (an explicit
record id, or the originating `sourceRef`, never a coarse company/period key that
would manufacture false conflicts) and flags two memory-native problems:

- **Contradiction**: two write events assign **different values** to the **same
  attribute** of the **same record**. Because each memory carries its own write
  timestamp, a contradiction is literally two sessions that remembered the record
  differently.
- **Absence**: a memory references another record that **no memory stores**: a
  dangling reference, an expected counterpart the agent never actually captured.

Detection alone does not tell the caller what to do next. When two values disagree,
the immediate question is *which one do I trust?* For every contradiction, the audit
also emits a **resolution recommendation**: `{ recommendedMemoryId,
recommendedValue, rule, confidence, rationale }`, decided by a fixed priority
ladder over signals **already stored on the memories**. It uses no new data or
domain rulebook:

1. **importance**: an explicitly flagged, high-salience memory outranks a later
   write with none.
2. **source-authority**: a structured record outranks a derived narrative note
   for a raw value.
3. **recency** (default): otherwise the later write wins; the newest session
   presumably corrected the older one.

The result is a **recommendation, not ground truth**. The audit cannot know which
write was actually correct; it can only show which one a defensible policy prefers.
It **never mutates memory**. It surfaces the disagreement, recommends a side with a
confidence and a one-line rationale, and lets the caller decide. That separation is
deliberate: the memory reports its own disagreement instead of hiding it.

### Contradictions in *meaning*, too

The audit above compares metadata fields, so it is blind to memories that oppose
each other in **meaning** while sharing no comparable key, such as *"vendor always
pays on time"* vs *"vendor is chronically late"*. Neither carries a numeric attribute to
compare, so the field-level audit groups nothing and reports OK; the disagreement
lives entirely in the prose. A companion **semantic** audit (`POST
/consistency/semantic`, `src/memory/semantic-consistency.ts`) closes that gap. It
embeds each memory with the same `text-embedding-v4` recall path, keeps only
same-subject pairs by cosine, then asks the configured `QWEN_JUDGE_MODEL` online
whether they directly contradict (`qwen-plus` is the rollback baseline; a candidate
is eligible only after the versioned promotion gate). Offline, it uses a deterministic
polarity/negation heuristic so the audit still runs in CI with no key. The online judge **fails
closed**: any error or unparseable reply returns an explicit `inconclusive` result
with error metadata; it never masquerades as a clean no-conflict result or invents a
contradiction. It reuses the **same read-only resolution ladder** and, like the
rule-based path, **never mutates memory**. It runs *alongside* the field-level
engine as an additive check, replacing neither path. It is exposed over authenticated,
quota-bounded HTTP and HTTP MCP (the `audit_memory` tool takes `semantic: true`),
and its fixed contradiction pair is planted by the public idempotent demo seed
so you can see the agent catch a meaning-level contradiction in its own memory.
That evidence has limits. We can show the mechanism in the live demo and reproduce
the scored deterministic fixture offline. Historical online experiments remain in
the technical appendix with their provenance caveats; they are not presented here
as clean release evidence.

## Measurements we can reproduce offline

Memory-quality claims need evidence. The deterministic claims below are reproducible
from committed fixtures without a live provider call and are gated in CI:

**Retrieval.** On real `text-embedding-v4` embeddings, over a frozen, diverse,
hand-labelled corpus, our `reranked-hybrid` retriever (dense + lexical fused with
Reciprocal Rank Fusion, then a bounded `qwen-plus` listwise rerank over the candidate
set) beats a strong single-vector dense condition on the three reported metrics in
this frozen corpus:

| Metric | dense baseline | reranked-hybrid |
|---|---:|---:|
| MRR | 0.883 | **0.911** |
| nDCG@5 | 0.903 | **0.938** |
| Recall@3 | 90.0% | **96.7%** |

The dense condition is an explicit, reproducible single-vector cosine control,
similar to the plain similarity mode documented by LangChain's
`VectorStoreRetriever`. It is not a product head-to-head or a claim about every
system's current defaults.
Hybrid *alone* does **not** beat a modern embedder on top-rank ordering on a clean
corpus. That result is why we added bounded Qwen listwise reranking and reported the
null result rather than tuning the corpus back toward duplicates. A meaning-shuffled control retriever collapses to near
chance, proving the benchmark actually discriminates semantics. The CI claim is
fixture-bound: on the committed labelled retrieval fixture, hybrid Recall@3 and
Recall@5 must remain at least as high as dense recall; it is not a universal claim
about unseen corpora.

**Self-audit.** On a labelled dataset of injected conflicts plus a consistent
control set (agreeing re-ingests, float-noise, distinct records sharing an
attribute name):

> **5 / 5 injected problems detected, 0 false positives**: 100% detection, 100%
> precision. The control set matters because it checks that the audit stays *silent*
> on things that only look like conflicts.

**Resolution.** On four cases encoding the declared importance → authority →
recency policy:

> **4 / 4 declared-policy conformance (selected memory + rule)**, with structural
> invariants (every contradiction resolved, recommendation points at a real
> memory, confidence in [0,1]) enforced too.

This measures **policy-conformance, not policy-optimality**. A 100% result means the
recommender faithfully implements its stated, defensible policy, not that the policy
is universally right. It therefore remains a recommendation with a confidence,
never an automatic edit.

## Persistence means a fresh process, not a new tab

The track still requires genuine cross-session persistence. Our end-to-end test
writes memories in Session A, tears the process down completely
(pool closed; nothing survives in-process), then a **fresh Session B** with
fresh instances and no shared state recalls those memories by meaning and narrates
a grounded, cited `qwen-plus` answer. The only thing shared between the two
sessions is the database. That's what "persistent, cross-session memory" means,
and it's a gated test, not a slide.

## What it's a memory *of*

The shipped financial proof has two explicit inputs: a document pipeline that fuses
a payroll register, bank confirmation, and payslips, and a strict JSON path for
purchase/sales invoices. Over those memories it reports source-linked payroll totals, purchases,
sales, known/unknown cash, and net profit **per currency**. If currencies are mixed,
top-level monetary totals are `null` and `by_currency` carries independent totals.
Payroll without supported currency evidence is counted as unknown and excluded
from monetary aggregation. It is never assumed to be EUR or combined through an
`UNSPECIFIED` pseudo-currency.

That scope is intentionally narrower than the broader Archon roadmap. This entry
does not claim shipped order/receipt/general-bank-statement extraction, EBITDA, or
sales targets.

## The stack, and where it runs

- **Qwen models:** `text-embedding-v4` (1024-dim embeddings), `qwen-plus` (RAG
  narration, rerank, and skills), the health-visible configured semantic judge,
  and `qwen-vl-max` (payroll-document
  vision extraction), via Alibaba Cloud Model Studio / DashScope.
- **Memory store:** pgvector on PostgreSQL, using `agent_memory(embedding vector(1024))`
  with an HNSW cosine index, semantic recall as `ORDER BY embedding <=> $query`.
- **Live deployment:** an Alibaba Cloud **ECS** instance (`ecs.e-c1m2.large`,
  ap-southeast-1) running docker-compose, with the backend container alongside a
  self-hosted **pgvector container** as the memory store, behind one public URL.
  Because the store is pg-wire, the identical code runs unchanged against a managed
  ApsaraDB RDS / AnalyticDB for PostgreSQL instance (the Function Compute
  alternative shipped in `deploy/`), a drop-in `DATABASE_URL` swap.

Offline, with no DashScope key, deterministic Fakes exercise the model seams and the
pgvector/fixture path with zero cloud credentials. Production is fail-closed: real
Qwen plus configured judge authentication are required for `/ready`.

A [published live k6 record](https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/load/RESULTS_2026-07-15.md)
adds bounded operational evidence: on earlier exact release `e4b208a…`, a read-only
`0 → 1 → 2 → 0` arrival-rate ramp completed 342 HTTP requests and 42 grounded Qwen
recalls with zero HTTP failures. It is deliberately modest production-path
stability/latency evidence, not a saturation test, maximum-throughput claim, or
attestation of the later submitted source.

## Four iterations that changed what we shipped

We did not begin with a polished contradiction engine. The first milestone was the
plain Track 1 contract: write through one session, tear it down, and make a fresh
client recover a bounded cited answer. Qwen Cloud's OpenAI-compatible endpoint let
us keep model seams injectable: production uses the official DashScope endpoint,
while deterministic fixtures exercise failure paths without credentials.

The second iteration came from an uncomfortable demo result. Dense recall could
retrieve either of two plausible values and remain silent about the disagreement.
That moved conflict detection out of the narrator and into a pure, read-only policy
engine with provenance and an explicit human decision. The third iteration handled
the case that field rules cannot see: opposing prose with no shared number. We added
a separately authenticated Qwen semantic judge, kept its result advisory, and
measured the deterministic offline seam without calling it live-model accuracy.

The final iterations were operational. We added tenant mapping, durable Qwen work
quotas, least-privilege PostgreSQL, fail-closed readiness, dry-run/confirm lifecycle,
and exact runtime-source deployment evidence. A last live check exposed legacy demo
sales from before currency scoping; v4 reconciliation now produces one EUR Northwind
P&L bucket, zero unknown-currency records, and an idempotent second seed. That defect
was more valuable than a perfect rehearsal because it forced the demo data to obey
the same invariants as the product.

Those iterations clarified the system boundary. Models handle embedding, reranking,
narration, and semantic comparison; code owns tenancy, arithmetic, citations,
mutation, and release truth. The domain-neutral audit plus REST, MCP, and pg-wire seams make
the MIT core reusable for support, research, and other long-lived agents. The next
evidence step is independent labelling and longitudinal usage, not an unsupported
claim that this synthetic fixture already proves production-scale accuracy.

## Open it signed out and test the boundary

The public, quota-bounded Explorer is live at
[memory.43.106.13.19.sslip.io](https://memory.43.106.13.19.sslip.io/). Open it in a
signed-out/private browser to inspect the public demo and health state. Protected
mutation, lifecycle, feedback, semantic-audit, and MCP operations intentionally
require the separate reviewer credential supplied through Devpost testing
instructions. No credential belongs in this article.

The complete MIT-licensed source, architecture, benchmark fixtures, and exact
reproduction commands are in the
[public repository](https://github.com/upgradedev/archon-qwen-memoryagent). To run
the offline evidence locally:

```bash
cp .env.example .env
# Set independent bootstrap/admin and memoryagent_app runtime passwords/URLs;
# set a third, separate 32+ character JUDGE_API_KEY.
set -a; . ./.env; set +a
npm ci
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build db-init
npm run db:verify-role
npm run memory:demo                 # write the payroll evidence, recall by meaning
npm run bench -- --gate             # retrieval: regression + fusion + discrimination gates
npm run bench:consistency -- --gate # self-audit: 5/5 detected, 0 false positives
npm run bench:semantic -- --gate    # meaning audit: 90% recall, 100% precision, 0 FP
npm run bench:resolution -- --gate  # resolution: 4/4 declared-policy conformance
```

Persistent memory becomes trustworthy only when it can surface two incompatible
versions of the same fact. That is what we built.

---

**Next step:** [try the live Explorer](https://memory.43.106.13.19.sslip.io/), then
[inspect the architecture and quickstart](https://github.com/upgradedev/archon-qwen-memoryagent#readme)
or [reproduce the full benchmark method](https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/BENCHMARK.md).
The project is MIT licensed.
