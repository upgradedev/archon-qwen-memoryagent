# YouTube publication packet — Archon MemoryAgent

Use this packet only after the exact-release, media, duration, rights and signed-out
gates are green. It prepares the public upload; it does not authorize or perform
publication.

## Upload fields

**Title**

> Archon MemoryAgent: Qwen Memory That Audits Its Own Contradictions

**Description**

> Persistent memory becomes dangerous when it silently chooses between conflicting
> facts. Archon MemoryAgent is our Qwen Cloud Hackathon Track 1 entry: durable,
> queryable memory that recalls across sessions, grounds answers in citations,
> surfaces field-level and meaning-level contradictions, and keeps resolution and
> forgetting under explicit human control.
>
> The demo shows one verified Alibaba Cloud ECS deployment using real Qwen models:
> text-embedding-v4 for 1,024-dimensional memory embeddings, qwen-plus for grounded
> narration and one bounded listwise rerank, a separately health-visible configured
> Qwen semantic judge, and qwen-vl-max for protected document vision. PostgreSQL +
> pgvector stores durable memory. `/health` and `/ready` prove models and readiness
> independently; the exact runtime source is attested by the release record shown
> in the video. The vision canary is an original synthetic dry-run with zero writes;
> explicit feedback is persisted state, not model-weight learning.
>
> Live app: https://memory.43.106.13.19.sslip.io
>
> Public MIT source: https://github.com/upgradedev/archon-qwen-memoryagent
>
> Architecture: https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/demo/final-media/judge-architecture.jpg
>
> Qwen integration: https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts
>
> Reproducible deployment path: https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/deploy/redeploy.sh
>
> Evaluation numbers shown in the video are frozen, developer-labelled fixtures—not
> production-traffic accuracy or universal superiority: field audit 5/5 with 0
> false positives; declared resolution policy 4/4; deterministic semantic fixture
> 90% recall, 100% precision and 0 false positives; disclosed retrieval fixture MRR
> 0.883→0.911 and Recall@3 90.0%→96.7%.
>
> Track 1 — MemoryAgent · Qwen Cloud · Alibaba Cloud · pgvector · MCP · MIT

**Tags**

> Qwen, Qwen Cloud, Alibaba Cloud, MemoryAgent, AI agents, agent memory, pgvector,
> PostgreSQL, Model Context Protocol, MCP, RAG, semantic search, human in the loop,
> explainable AI, TypeScript, open source, hackathon

**Public video URL after upload**

> `[PUBLIC_VIDEO_URL]`

## Chapters

Do not paste target/script times. Replace every bracketed timestamp below with the
measured transition in the final uploaded MP4; `00:00` is intentionally fixed.
YouTube chapter times must be strictly increasing and each chapter must last at
least ten seconds.

```text
00:00 Why persistent memory must challenge itself
[MEASURED_TIME_02] Exact runtime, Qwen readiness and vision canary
[MEASURED_TIME_03] Architecture and trust boundaries
[MEASURED_TIME_04] Fresh-session cited recall
[MEASURED_TIME_05] Read-only field contradiction and Defer boundary
[MEASURED_TIME_06] Feedback persists into a fresh session
[MEASURED_TIME_07] Qwen meaning-level self-audit and MCP
[MEASURED_TIME_08] One-row safe forgetting
[MEASURED_TIME_09] Reproducible evaluation evidence
[MEASURED_TIME_10] Alibaba ECS, public MIT source and close
```

Measure against the final muxed file, not the edit timeline or narration estimate.
Recheck the chapters after YouTube finishes processing.

## Thumbnail and captions

- Upload [`final-media/youtube-thumbnail.png`](./final-media/youtube-thumbnail.png):
  exactly 1280×720, original project imagery, no token/account identifiers, readable
  at small card size.
- Set the video language to **English**.
- Upload [`final-media/memoryagent-demo.en.srt`](./final-media/memoryagent-demo.en.srt)
  as English subtitles. The final file must have been generated from the measured
  `caption_windows.json`; when the browser narration beat exists, it must also use
  the measured `video_manifest.json` and exact `narration_web.txt`.
- Do not publish an SRT whose capture review says
  `canonical-unmeasured-draft`.
- Do not enable a synthetic voice or make a voice-rights claim here. Voice and all
  third-party material require the separate human rights sign-off.

## Visibility and metadata

- Visibility: **Public**; no scheduled embargo, login, password, access request or
  age restriction that prevents ordinary judging.
- Category: **Science & Technology**.
- Audience: select the truthful setting; do not infer it from this repository.
- License setting: keep the platform setting selected by the authorized entrant;
  the source code itself is MIT.
- Do not add account ids, instance ids, raw IP metadata, reviewer credentials,
  private testing instructions or unverified performance claims to title,
  description, tags, chapters, captions, cards, comments or filename metadata.

## Signed-out acceptance before using the URL

- [ ] The processed public video opens in a signed-out/private window without a
      Google login or access request.
- [ ] The player reports a duration strictly below 3:00 and the local release gate
      remains below the stricter 175-second publication ceiling.
- [ ] 1080p is available, text is readable at normal playback size, audio is clear,
      and no frame is blank, stale or from another release.
- [ ] The thumbnail is the reviewed 1280×720 file and survives YouTube's small-card
      crop.
- [ ] English subtitles load, match the spoken content, and stay synchronized
      through the separate browser beat.
- [ ] Every measured chapter seeks to the correct final-frame transition and meets
      YouTube's minimum chapter duration.
- [ ] Live app, repository, architecture, Qwen-integration and deployment links all
      open signed out.
- [ ] No credential, email, cloud/account/instance identifier, browser profile or
      private customer data appears in pixels, audio, subtitles, description or
      metadata.
- [ ] Claims match [`../docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md),
      especially the fixture caveats and the separation of exact-deploy evidence
      from `/health`/`/ready`.
- [ ] [`RIGHTS_RELEASE_CHECKLIST.md`](./RIGHTS_RELEASE_CHECKLIST.md) is signed by the
      authorized entrant for every voice, font, image, mark, music and clip actually
      used.
- [ ] The resulting public URL is pasted into the Devpost draft and tested again
      from Devpost's signed-out preview.

Stop after the upload and signed-out checks if final submission has not been
authorized. This packet does not authorize clicking Devpost's **Submit project**.
