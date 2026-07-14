# Judge guide — see the differentiator in about 2 minutes

**Live:** <https://memory.43.106.13.19.sslip.io>

The public click path below needs **no login or API key**. It is intentionally limited to the fixed demo payload and public-tenant reads. Protected writes, feedback, lifecycle operations, and the Qwen semantic audit use the reviewer credential supplied privately in the Devpost testing instructions; no credential is committed to this repository.

Before judging, [`GET /ready`](https://memory.43.106.13.19.sslip.io/ready) should return `200` with database, Qwen, and judge-auth checks ready. [`GET /health`](https://memory.43.106.13.19.sslip.io/health) should identify `text-embedding-v4` and `qwen-plus`, not Fake providers.

## 60 seconds: seed, recall, self-audit

1. Open the [Memory Explorer](https://memory.43.106.13.19.sslip.io).
2. Click **Run demo**. The server idempotently seeds only its fixed payroll evidence plus planted field-level and meaning-level contradictions. It accepts no caller-controlled content. The seed is public but quota-bounded.
3. Click **What did it really cost to employ the team?** The agent retrieves a bounded slice of the public tenant's memories and returns a grounded answer with numbered citations. Recall is also protected by per-IP plus global daily quotas.
4. Click **Run self-audit**. The deterministic, read-only audit should show `INV-5521 · amount` recorded as `8400` and `8900`, then recommend `8900` under the recency rule. It reports the disagreement; it does not overwrite either memory.

That screen demonstrates the Track 1 core: persistent, queryable memory across writes, bounded recall for limited context windows, and an explicit consistency mechanism.

## Public curl path

```bash
BASE=https://memory.43.106.13.19.sslip.io

curl -fsS "$BASE/ready"
curl -fsS -X POST "$BASE/demo/seed"
curl -fsS -X POST "$BASE/recall" \
  -H 'content-type: application/json' \
  -d '{"question":"What did it really cost to employ the team?","company":"Northwind Trading"}'
curl -fsS -X POST "$BASE/consistency" \
  -H 'content-type: application/json' \
  -d '{"company":"Northwind Trading"}'
```

Expected field-level result: a contradiction for `INV-5521`, values `8400` and `8900`, with `resolution.recommendedValue = 8900` and `rule = "recency"`.

## 30 seconds more: authenticated meaning-level audit

The semantic route is intentionally protected because it invokes the heavier Qwen judge. In the Explorer, paste the private Devpost reviewer token into the password-type **Judge token (protected audit/lifecycle)** field, keep the demo company selected, and click **Run semantic audit**. The field is for the private judge path only: do not publish or screenshot the token. Swagger's **Authorize** control is an alternative. From a terminal:

```bash
BASE=https://memory.43.106.13.19.sslip.io
TOKEN='<token from private Devpost testing instructions>'

curl -fsS -X POST "$BASE/consistency/semantic" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"company":"Northwind Trading","kind":"insight"}'
```

The fixed demo contains *"always pays on time"* and *"chronically late"*. The response should expose a read-only semantic contradiction with model/completion provenance. The committed offline labelled benchmark measures the deterministic offline judge at **90% recall, 100% precision, and 0 false positives**; those figures are not presented as live-Qwen accuracy.

The same credential may be used to inspect authenticated tenant-scoped mutations such as `/ingest/invoice`, `/feedback`, `/consolidate`, and `/forget`. Lifecycle endpoints preview by default and require `confirm=true` before changing state.

## Reproduce the evidence locally

The benchmarks replay committed fixtures with no API key or database. The full test command also includes real-DB slices, which skip explicitly when no integration database is supplied.

```bash
git clone https://github.com/upgradedev/archon-qwen-memoryagent
cd archon-qwen-memoryagent
npm ci
npm run bench -- --gate
npm run bench:consistency -- --gate
npm run bench:semantic -- --gate
npm run bench:resolution -- --gate
npm run test:docs
npm test
npm run coverage
```

Verified full result: **300 total, 285 pass, 0 fail, 15 real-DB skips**; coverage **91.96% statements, 84.96% branches, 91.25% functions, 91.96% lines**. Model seams use deterministic Fakes in local/CI runs, while production is configured to fail closed without real Qwen.
