# Exceptional submission video — judge-first script

Target **2:45–2:52**. Hard publication limit: **strictly below 175 seconds**, leaving
margin below the official `<3:00` rule. This file is the canonical final editorial
script. The authenticated renderer currently speaks
[`../docs/narration.txt`](../docs/narration.txt) and produces useful live source
footage, but its assembled MP4 is only a candidate: it does not replace the exact-SHA,
architecture, evidence, and Alibaba proof beats required below.

Record only while [`../deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) identifies
final verified runtime-source commit
[`e4b208a63e1768409e5b94fe305a3672c4c96dcd`](https://github.com/upgradedev/archon-qwen-memoryagent/commit/e4b208a63e1768409e5b94fe305a3672c4c96dcd)
and the public release checks remain green. A later repository HEAD is acceptable
only when every descendant change is documentation, sanitized submission media, or
non-runtime recording tooling.

| Beat | Target | What judges see | Narration job |
|---|---:|---|---|
| 1 · Stakes + track | 0:00–0:14 | Product name, **Track 1 — MemoryAgent**, live HTTPS URL | Lead with the conflict problem, not the stack. |
| 2 · Exact live proof | 0:14–0:29 | Sanitized exact-SHA release card, `/health`, then `/ready` | Keep commit provenance separate from endpoint/model readiness. Never imply `/health` attests the Git commit. |
| 3 · Architecture + scale path | 0:29–0:53 | [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg), held long enough to read | Trace evidence → trust edge → Qwen → pgvector → hybrid cited answer → read-only audit/human decision; point to tenant-scoped REST/MCP and pg-wire portability without claiming unmeasured scale. |
| 4 · Cross-session memory | 0:53–1:19 | Live Explorer plus generated Session A/Session B proof | Fresh Session B receives a grounded cited answer from Session A. Product default is hybrid; the proof exposes pure cosine only for readable similarity. |
| 5 · Headline differentiator | 1:19–1:40 | Two writes, field self-audit, both values and recommendation | Show `€18,000` vs `€19,000`, provenance, `recency`, no silent mutation, and separate human Accept / Override / Defer. |
| 6 · Meaning + MCP | 1:40–1:58 | “always pays on time” vs “chronically late”, Qwen result, four-tool MCP card | Separate the working live semantic mechanism from the offline 90% fixture and distinguish authenticated HTTP from trusted-local stdio. |
| 7 · Timely forgetting | 1:58–2:10 | Authenticated lifecycle preview followed by confirmed result | Show dry-run first, explicit reason + confirmation, tenant scope, and auditable transition; no surprise deletion. |
| 8 · Evidence, not hype | 2:10–2:35 | One clean evidence card | Field **5/5, 0 FP**; policy **4/4**; deterministic semantic **90% recall, 100% precision, 0 FP**; MRR **0.883→0.911**, Recall@3 **90.0%→96.7%**. Keep fixture labels visible; do not show historical dirty-tree v1.1 as release evidence. |
| 9 · Alibaba + close | 2:35–2:49 | Sanitized ECS/container proof, then repo/MIT/live end card | Active topology is Alibaba ECS + self-hosted pgvector. Close on the portable, working product; keep Function Compute/RDS alternative-only. |

## Exact final narration

Read the following at a measured **137–140 words per minute**. Make a scratch recording
before editing and require `ffprobe` duration **≤168 seconds**; this is the real timing
gate, not a word-count estimate. Pause briefly on architecture, contradiction, and
evidence. If the scratch voice is longer, tighten wording—not merely visual holds—and
never remove a claim caveat.

> Persistent memory is untrustworthy if it silently chooses between conflicting
> facts. Archon MemoryAgent is our Track 1 answer: Qwen memory that
> recalls, cites, audits, corrects, consolidates, and forgets across sessions.
>
> First, release proof. This card identifies the exact Alibaba runtime source.
> Independently, live health and readiness show text-embedding-v4, qwen-plus,
> 1,024-dimensional vectors, and database, Qwen, and authentication ready. Health
> alone is not commit attestation.
>
> Evidence crosses a deterministic trust boundary, is embedded by Qwen, and persists
> in pgvector. Default recall is hybrid: dense and lexical
> retrieval, reciprocal-rank fusion, reranking, then a grounded qwen-plus answer with
> citations. Self-audit is read-only, human resolution is explicit, and tenant-scoped
> REST, MCP, and pg-wire seams make the MIT core reusable beyond this finance demo.
>
> In Session A, an agent commits fused financial facts and disconnects. Session B is
> a fresh client with only a question. Qwen searches durable memory by meaning and
> returns the true workforce cost—15,800 euros—against 10,000 euros that left the
> bank, with citations. This proof view deliberately exposes pure cosine scores for
> readability; the product default remains hybrid.
>
> Now the differentiator. Two sessions write 18,000 and 19,000 euros for the same
> field. Archon preserves both values and provenance, detects the disagreement,
> and recommends the newer value under the declared recency policy. It does not
> silently rewrite memory. Accept, Override, or Defer is a separate human action.
>
> It also audits meaning. “Always pays on time” and “chronically late” share no number,
> so the configured Qwen judge performs an authenticated check. The same
> memory core exposes exactly four typed MCP operations, with authenticated,
> tenant-scoped HTTP and bounded trusted-local stdio.
>
> Outdated memory is never deleted by surprise. Consolidation and forgetting preview
> first, then require tenant-scoped authentication, explicit confirmation, and a
> reason, while preserving an auditable state transition.
>
> The evidence is frozen and labelled, not production accuracy: five of five
> developer-labelled field issues detected with zero false positives; four of
> four declared-policy cases conform; the deterministic semantic set records 90%
> recall, 100% precision, and zero false positives. On the disclosed retrieval fixture,
> MRR rises from 0.883 to 0.911 and Recall at three from 90.0% to 96.7%.
>
> The verified live topology is Alibaba Cloud ECS in Singapore with self-hosted
> pgvector and real Qwen. Archon is live and MIT-licensed: portable memory that
> recalls, cites—and challenges its own contradictions.

## Voiceover and visual lock

- Use [`../docs/narration.txt`](../docs/narration.txt) verbatim only for the automated
  source-footage candidate. The final edit uses the exact narration above. A human
  voice may improve pacing, but must preserve every claim boundary and caveat.
- The automated live transcript is generated from real responses by
  [`../scripts/capture_live.sh`](../scripts/capture_live.sh); never replace its
  answers, scores, model ids, or contradiction result with hand-authored values.
- The canonical hero is the 16:9 judge architecture. The dense Mermaid render is a
  technical appendix, not the primary video slide.
- Keep the dedicated reviewer credential out of pixels, captions, request headers, terminal
  history, browser developer tools, filenames, metadata, and the public description.
- Use English narration and captions. Text must remain readable at normal playback
  size, not only when paused at full resolution.

## Claim lock

- Do not call a synthetic/developer-labelled set held-out production traffic,
  independent expert evaluation, or general live-Qwen accuracy.
- Do not claim universal superiority over Mem0 or Zep. The supported observation is
  limited to the pinned disclosed probe.
- Do not say the audit discovers ground truth. It detects disagreement and returns a
  policy recommendation; a human decision is separate.
- Do not claim every recall shown in the generated proof is hybrid: that capture
  deliberately selects dense cosine recall so the displayed score is meaningful.
- Do not claim Function Compute/RDS is the live topology.
- Label the two intentional contradiction fixtures instead of intercutting them as
  one record: authenticated fresh-capture footage uses `€18,000`/`€19,000`; the
  fixed public Explorer demo and gallery screenshot use `INV-5521` `8400`/`8900`.
- Do not publish a candidate whose duration is `>=175` seconds, whose voice rights
  are unverified, or whose frames contain third-party material without permission.

Build and acceptance steps are in [`BUILD_RECORDING.md`](./BUILD_RECORDING.md); the
frame-by-frame human gate is [`VIDEO_RECORDING_CHECKLIST.md`](./VIDEO_RECORDING_CHECKLIST.md).
