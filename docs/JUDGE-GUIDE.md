# Judge guide — see it work in ~2 minutes

A click-by-click path through the live MemoryAgent. No install, no login, no key needed for the hosted demo. (The README's *"How this maps to the judging rubric"* table says which capability answers which criterion; this guide is the **click path** to watch each one happen.)

**Live:** <https://memory.43.106.13.19.sslip.io>

The one thing to watch for: **a memory agent that audits its own memory and resolves a cross-session contradiction** — the headline capability — visible in under a minute below.

---

## 60 seconds: a contradiction, recalled and resolved

1. **Open the live URL.** The memory explorer loads (recall box + a few one-click question chips + a live `memories N` count badge).
2. **Click `Run demo`.** This seeds a realistic sample through the *same* ingestion pipeline (with the free offline extractor — no Qwen spend, not rate-limited) plus one deliberate cross-session contradiction, then auto-runs a recall. You immediately see a **grounded answer with `[n]` citations** back to the exact memories it used. (Idempotent — clicking twice does not double-seed.)
3. **Click a question chip**, e.g. *"What did it really cost to employ the team?"* → the agent recalls the relevant memories by meaning and grounds a cited answer in them. Each citation is a real stored memory, shown beneath the answer.
4. **Click `Run self-audit`.** The agent scans its *own* stored memories and flags the planted contradiction:
   > **INV-5521 · amount** recorded as **8400** *and* **8900** across two write events.
   > **Recommended: trust 8900 (recency)** — the later write supersedes the earlier value.

   That is the whole thesis in one screen: **memory that checks itself, and recommends which value to trust, read-only — it never silently rewrites memory.** A contradiction surfaced and resolved in ~60 seconds.

---

## The rest of the surface (optional, ~1 minute)

- **`GET /docs`** — the interactive Swagger UI. Every route is documented; try `POST /recall` or `POST /consistency` straight from the browser. <https://memory.43.106.13.19.sslip.io/docs>
- **`GET /health`** — liveness + the live model ids. A real key is configured, so you should see `"narrator":"qwen-plus"` and `"embedder":"text-embedding-v4"` (not a fake). <https://memory.43.106.13.19.sslip.io/health>

### Same three steps from a terminal (curl)

```bash
BASE=https://memory.43.106.13.19.sslip.io

# 1. Seed the demo (idempotent)
curl -s -X POST $BASE/demo/seed

# 2. Recall a grounded, cited answer
curl -s -X POST $BASE/recall -H 'content-type: application/json' \
  -d '{"question":"What did it really cost to employ the team?"}'

# 3. Self-audit: find + resolve the cross-session contradiction
curl -s -X POST $BASE/consistency -H 'content-type: application/json' \
  -d '{"company":"Northwind Trading"}'
#    → contradictions[].subject "INV-5521", values 8400 vs 8900,
#      resolution.recommendedValue 8900 (rule: recency)
```

---

## Reproduce the quality numbers yourself (~2 minutes, offline)

The retrieval and grounding metrics in the README are backed by a committed real-embedding fixture and a golden snapshot — they replay with **no key and no database**:

```bash
git clone https://github.com/upgradedev/archon-qwen-memoryagent && cd archon-qwen-memoryagent
npm ci
npm run bench             # hybrid retrieval vs the naive-vector baseline (MRR / nDCG@5 / Recall@3)
npm run bench:consistency # self-audit detection: 100% detection, 0 false positives on the fixture
npm run test:unit         # the offline unit suite (no key, no database)
npm run test:docs         # doc-consistency: the README's claims + metrics match the code
```

Everything a judge sees on the live box is the same code these tests exercise — the offline Fakes swap in for Qwen and pgvector so all of the above runs on a laptop with zero credentials. (The integration + e2e suites additionally run against a real pgvector container in CI.)
