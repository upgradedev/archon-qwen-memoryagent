# Exceptional submission video — judge-first script

Target **2:45–2:52**. Hard publication limit: **strictly below 175 seconds**, leaving
margin below the official `<3:00` rule. This file is the canonical final editorial
and claim-boundary script. The preferred rights-safe final is the 172-second,
no-voice caption-led build in [`CAPTION_VIDEO_BUILD.md`](./CAPTION_VIDEO_BUILD.md);
its concise burned captions preserve all material boundaries below. The optional
authenticated renderer speaks
[`../docs/narration.txt`](../docs/narration.txt) and produces useful live source
footage, but its assembled MP4 is only a candidate: it does not replace the exact-SHA,
architecture, evidence, and Alibaba proof beats required below.

Do not record until [`../deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) changes
from **REDEPLOY REQUIRED** to final verified and replaces `<FINAL_RUNTIME_SHA>` with
the real 40-character post-merge SHA recorded as exact-deployed. A later repository
HEAD is acceptable only when every change
after that candidate stays inside the stated submission-pack allowlist. At authoring
time the candidate is not claimed as deployed and the recording gate is red.

| Beat | Target | What judges see | Narration job |
|---|---:|---|---|
| 1 · Stakes + track | 0:00–0:13 | Product name, **Track 1 — MemoryAgent**, live HTTPS URL | Lead with the conflict problem, not the stack. |
| 2 · Exact live + vision | 0:13–0:32 | Sanitized exact-SHA release card, `/health`, `/ready`, then the qwen-vl canary card | Keep commit provenance separate from endpoint/model readiness. Show the original synthetic two-PNG dry-run, response-reported model, zero writes and exact-marker absence. |
| 3 · Architecture + scale path | 0:32–0:51 | [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg), held long enough to read | Trace evidence → trust edge → Qwen → pgvector → hybrid cited answer → read-only audit/human decision; point to tenant-scoped REST/MCP and pg-wire portability without claiming unmeasured scale. |
| 4 · Cross-session memory | 0:51–1:13 | Live Explorer plus generated Session A/Session B proof | Fresh Session B receives a grounded cited answer from Session A. Product default is hybrid; the proof exposes pure cosine only for readable similarity. |
| 5 · Headline differentiator | 1:13–1:35 | Original synthetic `INV-5521`, field self-audit, then human-control frame | Show `€8,400` vs `€8,900`, provenance, `recency`, no silent mutation. The live frame exercises **Defer only** with zero API call/write; Accept/Override remain visibly unexercised. |
| 6 · Feedback persistence | 1:35–1:53 | Session-A correction beside separately authenticated fresh Session-B recall/application | Prove durable stored feedback with a citation. Explicitly say this is persistence, not autonomous training or model-weight learning. |
| 7 · Meaning + MCP | 1:53–2:10 | “always pays on time” vs “chronically late”, Qwen result, four-tool MCP card | Separate the working live semantic mechanism from the offline 90% fixture and distinguish authenticated HTTP from trusted-local stdio. |
| 8 · Timely forgetting | 2:10–2:22 | Authenticated lifecycle preview followed by confirmed result | Show exactly one feedback-superseded candidate previewed, exactly one audited deletion, protected state unchanged and exact-marker residue zero. |
| 9 · Evidence, not hype | 2:22–2:42 | One clean evidence card | Field **5/5, 0 FP**; policy **4/4**; deterministic semantic **90% recall, 100% precision, 0 FP**; MRR **0.883→0.911**, Recall@3 **90.0%→96.7%**. Keep fixture labels visible; do not show historical dirty-tree v1.1 as release evidence. |
| 10 · Alibaba + close | 2:42–2:52 | Sanitized ECS/container proof, then repo/MIT/live end card | Active topology is Alibaba ECS + self-hosted pgvector. Close on the portable, working product; keep Function Compute/RDS alternative-only. |

## Optional exact final narration

Use this only if a rights-cleared narrated final is deliberately chosen. Read it at a
measured **137–140 words per minute**. Make a scratch recording
before editing and require `ffprobe` duration **≤168 seconds**; this is the real timing
gate, not a word-count estimate. Pause briefly on architecture, contradiction, and
evidence. If the scratch voice is longer, tighten wording—not merely visual holds—and
never remove a claim caveat.

> Persistent memory fails when it silently chooses between conflicting facts.
> Archon MemoryAgent is our Track 1 answer: Qwen memory that recalls, cites, audits,
> corrects, and forgets across sessions.
>
> First, release proof. This card attests exact Alibaba runtime source; health and
> readiness independently show real models. An original synthetic payroll and
> bank-image pair crosses protected qwen-vl-max dry-run. The response reports
> qwen-vl-max and one fused event; zero writes, unchanged count, and marker absence
> prove no residue.
>
> Evidence crosses a deterministic trust boundary, is embedded by Qwen, and persists
> in pgvector. Default recall combines dense and lexical retrieval, rank fusion, one
> bounded listwise qwen-plus rerank, and a grounded cited answer. Read-only audit and
> explicit human control sit behind tenant-scoped REST and MCP.
>
> Session A commits financial facts and disconnects. A fresh Session B asks by
> meaning. Qwen returns 15,800 euros true workforce cost against 10,000 euros bank
> outflow, with citations. This proof exposes cosine scores for readability; product
> default stays hybrid.
>
> Now the differentiator. Original synthetic sessions record 8,400 and 8,900 euros
> for `INV-5521.amount`. Archon preserves both and recommends the newer value under
> declared recency; it never rewrites silently. The live human frame exercises Defer
> only: zero API call, zero write. Accept and Override are protected actions, not
> claimed here.
>
> Separately, Session-A reviewer feedback stores a correction. A fresh Session B
> recalls, cites, and applies it: durable memory state, not training or model-weight
> change.
>
> “Always pays on time” and “chronically late” share no number, so the configured
> Qwen judge checks their opposed meaning. The same core exposes exactly four typed
> MCP operations through authenticated HTTP and bounded trusted-local stdio.
>
> Forgetting is equally concrete. Preview selects exactly one feedback-superseded
> retention candidate; confirmation deletes exactly one with an audit. Protected
> memories stay unchanged and cleanup leaves zero marker residue.
>
> The labelled evidence is not production accuracy: five of five field issues with
> zero false positives; four of four policy cases; deterministic semantic recall 90
> percent, precision 100 percent, zero false positives. On the disclosed retrieval
> fixture, MRR rises 0.883 to 0.911 and Recall at three 90.0 to 96.7 percent.
>
> The verified live topology is Alibaba ECS in Singapore with self-hosted pgvector
> and real Qwen. Archon is live and MIT-licensed: portable memory that recalls,
> cites, and challenges its own contradictions.

## Voiceover and visual lock

- Use [`../docs/narration.txt`](../docs/narration.txt) verbatim only for the automated
  source-footage candidate. A narrated final uses the exact narration above; the
  preferred caption-led final uses the exact captions encoded in the builder. Any
  human voice must preserve every claim boundary and caveat.
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
- The human-control live frame proves **Defer only**, with zero API call and zero
  mutation. Do not imply that frame exercised Accept or Override; those are
  protected product actions with separate test evidence.
- Describe Session-A feedback → fresh Session-B application as durable persisted
  state. Never call it autonomous learning, training, adaptation, or a model-weight
  update.
- The vision canary is an original synthetic payroll-register + bank-confirmation
  PNG pair through protected `dryRun`; it proves response-reported `qwen-vl-max`,
  one fused event and zero residue. It does not prove raw-PDF-byte parsing.
- The lifecycle row is feedback-superseded and therefore retention-eligible; do not
  call it age-expired. Require the visible one-preview/one-delete/protected-state/
  zero-marker gates together.
- Do not claim every recall shown in the generated proof is hybrid: that capture
  deliberately selects dense cosine recall so the displayed score is meaningful.
- Do not claim Function Compute/RDS is the live topology.
- Label `INV-5521` and all other displayed business records as original synthetic
  demo data. Use the same canonical `€8,400`/`€8,900` pair in the story, thumbnail,
  public Explorer, screenshots, captions, and final video.
- Do not publish a candidate whose duration is `>=175` seconds, whose voice rights
  are unverified, or whose frames contain third-party material without permission.

Build and acceptance steps are in [`BUILD_RECORDING.md`](./BUILD_RECORDING.md); the
frame-by-frame human gate is [`VIDEO_RECORDING_CHECKLIST.md`](./VIDEO_RECORDING_CHECKLIST.md).
