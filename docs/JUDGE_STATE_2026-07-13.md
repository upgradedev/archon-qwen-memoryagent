# Judge-State Snapshot — 2026-07-13

> **Purpose.** A durable record of where the Archon MemoryAgent entry stands against the
> Qwen Cloud Hackathon judging bar after the 2026-07-12/13 judgment-review pass (merged
> PRs #48–#52). It captures the current judged score, the discrepancies those PRs closed,
> and the ranked, still-open path to exceed the target — so the next session resumes
> without re-deriving any of it.
>
> **Out of scope (already done / user-owned).** The **demo video** is re-rendered and
> committed (semantic + MCP beats, live `qwen-plus`), and the **blog / Devpost project
> story** is drafted and ready to submit. Both are excluded from the forward path below;
> the remaining video/Devpost actions are user steps (upload + form), not engineering.

## 1. Challenge + target

| Item | Value |
|---|---|
| Challenge | Global AI Hackathon Series with Qwen Cloud — **Track 1: MemoryAgent** |
| Deadline | **2026-07-20, 2 PM PDT** |
| Rubric | **Technical Depth & Engineering 30% · Innovation & AI Creativity 30% · Problem Value & Impact 25% · Presentation & Documentation 15%** |
| Target bar to exceed | **> 9.5 / 10** |
| Current judged score | **~8.6 / 10** (lifted by merged PRs #48–#52) |

## 2. Current judge score — per criterion

| Criterion (weight) | Score | Basis |
|---|---|---|
| **Technical Depth & Engineering (30%)** | **9** | Real Qwen `text-embedding-v4` embeddings + `qwen-plus` narration on Alibaba Cloud ECS with a self-hosted `pgvector` container; read-only self-auditing consistency engine (rule-based + semantic); 183 `node:test` tests at 97.75% coverage; CI + docs-consistency fitness functions. |
| **Innovation & AI Creativity (30%)** | **8.5–9** | Read-only, deterministic contradiction recommender (never mutates memory) vs Mem0/Zep silent mutation, now extended with a **NEW semantic contradiction detector** for meaning-level opposition the rule-based audit is blind to. Ceiling on this axis is capped until the semantic detector is *measured* (see §4). |
| **Problem Value & Impact (25%)** | **7.5–8** | Cross-session financial-intelligence memory with self-audit for missing/inconsistent data. Weakest axis: the impact is demonstrated but not yet quantified with a hard number (cost/hours saved or catch-rate vs a silent-mutation baseline). |
| **Presentation & Documentation (15%)** | strong | README foregrounds self-audit + benchmark + MCP; JUDGE-GUIDE 2-minute click path; mermaid architecture guarded by CI; demo video re-rendered. Remaining action = user uploads video + submits Devpost form. |

## 3. Discrepancies fixed this session (merged PRs)

All five confirmed merged to `main` (verified via `gh pr list --state merged`):

| PR | Title | What it resolved |
|---|---|---|
| **#48** | Judge-credibility polish | Aligned `demo/ALIBABA_PROOF.md`, removed the stale `~28%` gap figure, made the Demo Video badge honest (`pending upload`, not a false live claim). |
| **#49** | README score boost | README now foregrounds the read-only self-audit, the head-to-head benchmark, and the MCP server for judges. |
| **#50** | Semantic self-audit detector | Added `src/memory/semantic-consistency.ts` — meaning-level contradiction detection (opposite facts sharing no comparable metadata key). Read-only, offline-testable; closes the self-flagged Innovation limitation. |
| **#51** | Judgment-review harmony | Resolved the "semantic engine missing" critique; exposed the semantic audit over MCP (`audit_memory` tool, `semantic: true` flag) and over REST (`POST /consistency/semantic`); re-rendered the demo video. |
| **#52** | Re-rendered demo video | Semantic + MCP beats, live `qwen-plus`, A/V/caption sync-gate green. |

## 4. Path to exceed the target (> 9.5) — ranked

Excludes the demo video and the blog/Devpost story (done / user-owned). Ranked by expected axis lift.

1. **[CODE / buildable] Measure the semantic detector on a labelled fixture — a `bench:semantic` gate.**
   This project's brand is *"measured, not vibes."* The semantic detector currently ships
   **method-only**: it has unit tests (`tests/unit/semantic-consistency.test.ts`) but **no
   labelled precision/recall benchmark** — `bench/` has `bench:consistency` and
   `bench:resolution` datasets for the *rule-based* audit, but no semantic labelled fixture
   and no `bench:semantic` script (verified). A small labelled contradiction/agreement set
   + a benchmark gate reporting **precision / recall / F1** turns the headline Innovation
   feature from *asserted* → *measured*, directly lifting the **Innovation (30%)** axis.
   **This is the single biggest CODE lever.**

2. **[CODE / analysis] Quantify the Problem-Value impact with a real number.**
   Produce a hard figure — cost/hours saved, or contradiction-catch-rate vs a
   silent-mutation baseline — to lift the **Problem Value & Impact (25%)** axis, currently
   the weakest. Reuse the existing benchmark harness (`bench/consistency-run.ts`,
   `bench/resolution-run.ts`) as the measurement scaffold.

3. **[USER-only creds/deploy] Publish the demo video + submit the Devpost form.**
   Video is re-rendered and committed; the remaining steps (YouTube upload, make the README
   badge a link, complete the Devpost submission) require user credentials.

> **Note — ECS `/consistency/semantic` is already live (DONE, not pending).** A probe of the
> production endpoint (`POST https://memory.43.106.13.19.sslip.io/consistency/semantic`)
> returned a valid semantic-audit schema (`{"audited":…,"compared":…,"semanticContradictions":[…],"ok":true}`),
> which a stale pre-#50/#51 image could not — so the deployed container already carries the
> semantic route. No ECS redeploy is needed for the endpoint to be reachable.

## 5. Verified-harmonized (no action needed)

- **Semantic audit is threaded through the docs + benchmark surface** — README foregrounds
  it, the mermaid architecture and JUDGE-GUIDE reference it, and it sits alongside the
  rule-based consistency benchmark story.
- **MCP exposes the semantic audit** — the `audit_memory` MCP tool carries a `semantic: true`
  flag (`src/skills/schemas.ts`), dispatched through the shared `SkillDispatcher` so the MCP
  layer never duplicates memory logic.
- **Honest badges** — the Demo Video badge reads `pending upload` rather than claiming a live
  video; Tests (183) and Coverage (97.75%) badges match the repo state.
- **`ALIBABA_PROOF` aligned** — the proof recording and model-id claims are consistent with
  the deployed ECS instance; the stale `~28%` gap figure is removed.
