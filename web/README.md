# Archon MemoryAgent — demo dashboard

A minimal single-page dashboard for the **Archon MemoryAgent**: an agent with
persistent, queryable, cross-session memory that **audits itself** for
contradictions. Vite + React + TypeScript, dark theme, zero backend required.

## Three panels

1. **Ask — grounded recall.** A question box → `POST /recall {question, hybrid:true}`.
   Renders the grounded, cited answer (inline `[n]` markers), the recalled
   memories (content + cosine similarity), and the best-effort self-audit over
   those memories when the response carries one.
2. **Self-audit — memory consistency.** A button → `POST /consistency`. Renders
   each cross-session contradiction (record + attribute + conflicting values with
   their write events) and its resolution recommendation (`recommendedValue`,
   `rule`, `confidence`, `rationale`). The panel is explicit that the audit
   **never mutates memory — it recommends**.
3. **Status bar.** `GET /health` (live embedder / narrator model ids + embedding
   dimension) and `GET /memory/count` (current memory size).

## Demo default + Live toggle

- **Demo mode is the default.** The dashboard renders fully with canned data and
  **zero backend** — a ByteCraft Studios recall with citations, and the
  €18,000-vs-€19,000 cross-session contradiction that the audit resolves to
  €19,000 by recency. Health shows `text-embedding-v4` + `qwen-plus`, dim 1024.
- **Flip the "Live" toggle** to call the real API at `VITE_API_URL`
  (default `http://43.106.13.19:9000`). Every call has a 5-second timeout
  (`AbortController`). On **any** error or timeout the UI falls back to the demo
  data with a small "live API unavailable — showing demo" notice. It never goes
  blank or broken.

### Mixed-content / CORS note

The OSS static-hosting endpoint is **HTTP** and the MemoryAgent API is **HTTP**,
so there is **no mixed-content block** when the Live toggle calls the API from the
hosted page. Separately, the API server does not currently send CORS headers, so
a cross-origin browser call may be **refused by CORS** even though the same
request succeeds from `curl`. That is exactly why the graceful demo fallback is
the product's normal path, not just an error case: Live *attempts* real calls and
degrades cleanly. (For guaranteed Live success from a browser, the API would need
to send `Access-Control-Allow-Origin`.)

## Develop

```bash
cd web
npm install
npm run dev          # http://localhost:5173  (demo data by default)
```

To point the Live toggle at a different API, copy `.env.example` to `.env` and set
`VITE_API_URL`.

## Build

```bash
cd web
npm install
npm run build        # type-checks (tsc) then emits web/dist/
npm run preview      # serve the production build locally
```

`vite.config.ts` sets `base: "./"` so the built bundle uses **relative** asset
paths and loads correctly from an object-storage static-hosting endpoint host.

## Deploy (Alibaba Cloud OSS static website hosting)

From the repo root, after building:

```bash
bash deploy/oss-deploy.sh
```

Idempotent: ensures the bucket (`BUCKET`, default `archon-memoryagent-web`),
applies public-read + static-website config (`index.html` as index **and** error
document), syncs `web/dist/`, and prints the public website endpoint
(`http://<bucket>.oss-website-<zone>.aliyuncs.com/`).

Overrides: `BUCKET`, `REGION` (default `oss-ap-southeast-1`), `PROFILE`, `ALIYUN`
(path to the `aliyun` binary). The script is **user-gated** — it needs a working
Alibaba Cloud AccessKey on the `aliyun` CLI and is not run in CI.
