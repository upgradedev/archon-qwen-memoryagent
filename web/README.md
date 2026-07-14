# Archon MemoryAgent — demo dashboard

A minimal single-page dashboard for the **Archon MemoryAgent**: an agent with
persistent, queryable, cross-session memory that **audits itself** for
contradictions. Vite + React + TypeScript, dark theme, live-first with an explicit
offline demo mode.

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

## Live default + explicit Demo toggle

- **Live mode is the default.** It calls the HTTPS judge deployment (or
  `VITE_API_URL`) and labels the result as live only after a successful response.
- **Demo mode is explicit.** The dashboard can render with canned data and
  **zero backend** — a ByteCraft Studios recall with citations, and the
  €18,000-vs-€19,000 cross-session contradiction that the audit resolves to
  €19,000 by recency. Health shows `text-embedding-v4` + `qwen-plus`, dim 1024.
- The default API is `https://memory.43.106.13.19.sslip.io`. Every call has a
  5-second timeout (`AbortController`). On an error the panel may retain a canned
  result, but it displays a prominent **DEMO FALLBACK** notice and never represents
  that data as a successful live response.

### HTTPS / CORS note

The API is HTTPS. Cross-origin access must be explicitly allowed by the backend's
`CORS_ORIGIN` allowlist; the production configuration should list only the static
dashboard origin and the same-origin backend UI. Do not use an HTTP API URL from
an HTTPS page and do not configure wildcard credentialed CORS.

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
