# YouTube publication packet: Archon MemoryAgent

Use this packet only after the exact-release, media, duration, rights and signed-out
gates are green and the canonical
[`REAL_MOTION_VIDEO.md`](./REAL_MOTION_VIDEO.md) manifest + QA + final
`--verify-only` pass are unchanged. It prepares the public upload; it does not
authorize or perform publication.

## Upload fields

**Title**

> Archon MemoryAgent: Qwen Memory That Audits Its Own Contradictions

**Description**

> An agent can remember and still be confidently wrong when two sessions store
> different versions of the same fact. Archon MemoryAgent makes that conflict visible.
>
> This demo shows fresh-session Qwen recall with citations, field-level and
> meaning-level self-audits, persisted feedback, safe forgetting, and the live
> Alibaba Cloud deployment. The audit stays read-only until a human chooses to
> accept, override, or defer. Feedback updates stored state, not model weights.
>
> Built with Qwen text-embedding-v4, qwen-plus, qwen-vl-max, PostgreSQL, and
> pgvector. Benchmark panels are developer-labelled fixtures, not production
> accuracy or universal superiority claims.
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
> Audio disclosure: English narration was generated with the entrant-approved
> ElevenLabs synthetic voice `pNInz6obpgDQGcFmaJgB` and `eleven_multilingual_v2`.
> No human voice, music, or fallback voice is used. Burned English
> captions and the downloadable SRT mirror the same ten beats.
>
> Track 1: MemoryAgent | Qwen Cloud | Alibaba Cloud | pgvector | MCP | MIT

**Tags**

> Qwen, Qwen Cloud, Alibaba Cloud, MemoryAgent, AI agents, agent memory, pgvector,
> PostgreSQL, Model Context Protocol, MCP, RAG, semantic search, human in the loop,
> explainable AI, TypeScript, open source, hackathon

**Public video URL after upload**

> `[PUBLIC_VIDEO_URL]`

## Chapters

These timestamps are the exact transitions of the canonical 5,160-frame narrated,
captioned real-motion final. Verify them against the final muxed MP4 and again after platform processing;
do not reuse them for a different edit. YouTube chapter times must be strictly
increasing and each chapter must last at least ten seconds.

```text
00:00 Why persistent memory must challenge itself
00:13 Exact runtime, Qwen readiness and vision canary
00:32 Architecture and trust boundaries
00:51 Fresh-session cited recall
01:13 Read-only field contradiction and Defer boundary
01:35 Feedback persists into a fresh session
01:53 Qwen meaning-level self-audit and MCP
02:10 One-row safe forgetting
02:22 Reproducible evaluation evidence
02:42 Alibaba ECS, public MIT source and close
```

The real-motion manifest and QA must still report those transitions, 172.000 measured
seconds and 5,160 frames, and `--verify-only` must pass immediately before upload.
Recheck the chapters after YouTube finishes processing.

Do not upload publicly until the user explicitly confirms that the exact ElevenLabs
synthetic narration may be used and publicly published for this release.

## Thumbnail and captions

- Upload `demo/final-media/youtube-thumbnail.png`:
  exactly 1280×720, original project imagery, no token/account identifiers, readable
  at small card size.
- Set the video language to **English**.
- Upload `demo/final-media/memoryagent-demo.en.srt`
  as English subtitles. It must be byte-identical to the SHA-bound ten-entry file
  mirrored by the burned captions and final real-motion manifest.
- Do not publish an SRT whose capture review says
  `canonical-unmeasured-draft`.
- Do not enable YouTube auto-dubbing or replace the reviewed audio. The canonical
  track already contains disclosed ElevenLabs narration. Its exact
  voice, WAV, manifest, clipping/silence checks and rights review must remain bound
  to the final manifest.

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
- [ ] 1080p is available, text is readable at normal playback size, the narrated AAC
      track is audible, unclipped and synchronized, and no frame is blank, stale or
      from another release.
- [ ] The thumbnail is the reviewed 1280×720 file and survives YouTube's small-card
      crop.
- [ ] English subtitles load, match the burned captions byte-for-byte, and stay
      synchronized through all ten beats.
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
