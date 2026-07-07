# Archon MemoryAgent — Devpost submission description

*Paste the body below into the Devpost "description" field. Track 1 (MemoryAgent).
~330 words.*

---

## Archon MemoryAgent — a memory that audits itself

**AI agents and assistants forget the moment a session ends** — and when they *do*
carry facts forward, they silently contradict themselves. One session records a
figure as €18,000; a later session records €19,000 for the same record; plain vector
recall just returns whichever ranked higher and stays quiet. Anyone building agents
that must stay consistent over time — support copilots, research assistants,
financial-document pipelines — inherits a memory they can't trust. **Archon
MemoryAgent** is a persistent, queryable, cross-session memory that recalls grounded,
cited answers **and audits its own memory for contradictions** — recommending which
value to trust **without ever mutating** what it holds.

### What it does

- **Cross-session recall**: memories are embedded with `text-embedding-v4` and stored
  in **pgvector**; a fresh process recalls prior facts by meaning and grounds a
  `qwen-plus` answer in them. A cross-session e2e test proves session B recalls what
  session A wrote and tore down.
- **Self-auditing memory (the headline)**: `POST /consistency` is a pure,
  domain-neutral engine that flags cross-session contradictions and dangling
  references, then **recommends** which value to trust over a fixed
  importance → source-authority → recency ladder — read-only, never mutating.
  Measured: **5/5 detected, 0 false positives; 4/4 correct resolutions.**
- **Strong retrieval**: hybrid dense + lexical (RRF) with a `qwen-plus` cross-encoder
  re-rank. Reranked-hybrid beats a strong dense baseline — MRR 0.883 → 0.911,
  Recall@3 90.0% → 96.7% — on a frozen labelled benchmark, gated in CI.
- **Honest positioning**: a run head-to-head vs Mem0 (retrieval parity; no
  contradiction API) with Zep cited — the differentiator is *recommend without
  mutating, explainably and portably*.

### Qwen Cloud usage

`text-embedding-v4` (embeddings) · `qwen-plus` (RAG narration + cross-encoder rerank)
· `qwen-vl-max` (document-ingestion vision extractor) — via the OpenAI-compatible
DashScope endpoint.

**Live:** https://memory.43.106.13.19.sslip.io · **Track 1 (MemoryAgent)** · Repo:
https://github.com/upgradedev/archon-qwen-memoryagent

---

**Alibaba Cloud proof:** the DashScope OpenAI-compatible client (base URL + Qwen
instantiation) is
[`src/qwen/client.ts`](https://github.com/upgradedev/archon-qwen-memoryagent/blob/main/src/qwen/client.ts);
proof recording: [`demo/alibaba-proof.mp4`](./alibaba-proof.mp4).
