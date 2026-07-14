// k6 load / performance test for the Archon MemoryAgent HTTP service.
//
// This is the LOAD tier of the testing pyramid (unit / integration / e2e /
// benchmark already exist). It exercises the LIVE service over HTTP and holds
// its latency + error-rate SLOs to per-endpoint thresholds.
//
// ── Read-dominant by design ────────────────────────────────────────────────
// The live target is a real pgvector database and every /recall is a real
// embedding + narrator (qwen-plus) completion — i.e. real spend and real DB
// load. So the default profile is READ-ONLY: it hits /health (cheap liveness)
// and /recall (the expensive read path), weighted heavily toward /health so we
// stress the HTTP/service layer without a wall of concurrent LLM calls. It
// NEVER writes unless WRITE_LOAD=true is set explicitly, and when it does the
// writes are stamped with an isolable test identity so they can be found and
// purged.
//
// ── Run ────────────────────────────────────────────────────────────────────
//   k6 run load/recall-load.js                     # smoke, read-only, live box
//   TARGET_URL=http://host:9000 k6 run load/recall-load.js
//   RUN_RAMP=true  k6 run load/recall-load.js       # add the rate-bounded live ramp
//   WRITE_LOAD=true k6 run load/recall-load.js       # opt-in write load (spend!)
//
// ── Offline vs live profile ─────────────────────────────────────────────────
// OFFLINE=true is the CI smoke profile: it targets a locally-booted server that
// runs the deterministic Fakes (no DashScope key, no spend) against a real
// pgvector, so every read path — /recall AND /consistency — can be exercised on
// EVERY iteration with no LLM cost, and the SLOs are the tighter local ones. With
// OFFLINE unset (the default) the script keeps its live-box behavior: read-weighted
// toward /health, the looser real-Qwen latency SLOs, and no consistency load.
//
// ── Env knobs ──────────────────────────────────────────────────────────────
//   TARGET_URL        base URL        (default https://memory.43.106.13.19.sslip.io)
//   OFFLINE           'true' → CI Fake-path profile (tight SLOs, hit /consistency)
//   RUN_RAMP          'true' → run the ramping-vus scenario after the smoke
//   WRITE_LOAD        'true' → include /ingest writes (default OFF)
//   READ_RATIO        0..1, share of iterations that hit /recall (default 0.15
//                     live, 1.0 offline) — the rest hit /health
//   CONSISTENCY_RATIO 0..1, share of iterations that hit /consistency (default 0
//                     live, 1.0 offline) — the read-only self-audit path
//   RECALL_COMPANY    company filter used for /recall + /consistency queries
//   WRITE_COMPANY     company stamped on /ingest writes when WRITE_LOAD=true

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

const BASE = (__ENV.TARGET_URL || "https://memory.43.106.13.19.sslip.io").replace(/\/+$/, "");
const OFFLINE = (__ENV.OFFLINE || "").toLowerCase() === "true";
const RUN_RAMP = (__ENV.RUN_RAMP || "").toLowerCase() === "true";
const WRITE_LOAD = (__ENV.WRITE_LOAD || "").toLowerCase() === "true";
const READ_RATIO = clamp01(parseFloat(__ENV.READ_RATIO || (OFFLINE ? "1.0" : "0.15")), OFFLINE ? 1.0 : 0.15);
const CONSISTENCY_RATIO = clamp01(parseFloat(__ENV.CONSISTENCY_RATIO || (OFFLINE ? "1.0" : "0")), OFFLINE ? 1.0 : 0);
// Offline the seed company is DEMO_COMPANY ("Northwind Trading") — no "Ltd" — so
// the recall + consistency queries actually hit the seeded memories.
const RECALL_COMPANY = __ENV.RECALL_COMPANY || (OFFLINE ? "Northwind Trading" : "Northwind Trading Ltd");
const WRITE_COMPANY = __ENV.WRITE_COMPANY || "k6-load-test";

// The public service deliberately enforces 300 HTTP requests/minute per client
// and 200 recall requests/day per subject. Keep the live ramp inside both
// production safety controls. Writes remain available in the one-VU smoke, but
// never in the ramp: at load-test rates they would exhaust the write quota and
// pollute the judge dataset. Offline CI is isolated and uses explicitly raised
// test limits, so these live-only guards do not apply there.
if (!OFFLINE && RUN_RAMP) {
  if (WRITE_LOAD) {
    throw new Error("WRITE_LOAD cannot be combined with the live ramp; rerun with RUN_RAMP=false");
  }
  if (READ_RATIO + CONSISTENCY_RATIO > 0.4) {
    throw new Error("live ramp READ_RATIO + CONSISTENCY_RATIO must be <= 0.4");
  }
}

function clamp01(n, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const JSON_HEADERS = { "Content-Type": "application/json" };

// Custom rate: share of /recall responses that came back with a real hits array.
// Lets us see grounding health independent of the pass/fail check aggregate.
const recallGrounded = new Rate("recall_grounded");

// Custom rate: share of /consistency responses that returned a well-formed audit
// report (a `contradictions` array). Tracks read-only self-audit health.
const auditWellFormed = new Rate("audit_well_formed");

// Realistic, universal finance-intelligence questions (no country/authority terms).
const QUESTIONS = [
  "What was the true cost of employing our team last month compared with what actually left the bank account?",
  "How much of last month's payroll cost was off-bank employer contribution?",
  "What was the total cost of employing Elena last month?",
  "Which payroll event had the largest gap between bank net and employer cost?",
  "Summarise the most recent payroll event for this company.",
];

// ── Scenarios ───────────────────────────────────────────────────────────────
// smoke: 1 VU for ~30s — a fast, cheap sanity pass that always runs.
// ramp:  0→1→2→0 iterations/s over ~3.5 min — opt-in (RUN_RAMP=true), starts
//        AFTER the smoke. Arrival-rate control, rather than a fixed VU count,
//        bounds one runner IP below the live 300-request/minute HTTP cap while
//        maxVUs still permits concurrency when real Qwen calls are slow.
const scenarios = {
  smoke: {
    executor: "constant-vus",
    vus: 1,
    duration: "30s",
    tags: { scenario: "smoke" },
  },
};
if (RUN_RAMP) {
  scenarios.ramp = {
    executor: "ramping-arrival-rate",
    startRate: 0,
    timeUnit: "1s",
    startTime: "32s", // begin just after the 30s smoke finishes
    preAllocatedVUs: 5,
    maxVUs: 50,
    stages: [
      { duration: "45s", target: 1 },
      { duration: "60s", target: 2 },
      { duration: "60s", target: 2 },
      { duration: "45s", target: 0 },
    ],
    gracefulStop: "10s",
    tags: { scenario: "ramp" },
  };
}

// ── Thresholds (SLOs) ────────────────────────────────────────────────────────
// Per-endpoint tagged thresholds are the real SLOs. /health is a trivial
// in-process liveness handler; /recall does an embedding + a narrator completion +
// a pgvector search, so it is legitimately slower. The offline (Fake-path) profile
// removes the qwen-plus network latency, so its SLOs are much tighter — a
// regression in the pure service/DB/RRF path is caught even without a live model.
const thresholds = OFFLINE
  ? {
      http_req_failed: ["rate<0.01"], // <1% of all requests may fail
      checks: ["rate>0.99"], // >99% of assertions must pass
      "http_req_duration{endpoint:health}": ["p(95)<300", "p(99)<600"],
      "http_req_duration{endpoint:recall}": ["p(95)<1500", "p(99)<2500"],
      "http_req_duration{endpoint:consistency}": ["p(95)<1500", "p(99)<2500"],
      http_req_duration: ["p(95)<1500"],
      recall_grounded: ["rate>0.95"],
      audit_well_formed: ["rate>0.95"],
    }
  : {
      http_req_failed: ["rate<0.01"], // <1% of all requests may fail
      checks: ["rate>0.99"], // >99% of assertions must pass
      "http_req_duration{endpoint:health}": ["p(95)<500", "p(99)<800"],
      "http_req_duration{endpoint:recall}": ["p(95)<2500", "p(99)<4000"],
      // Loose global ceiling; the tagged SLOs above are the meaningful ones.
      http_req_duration: ["p(95)<2500"],
      recall_grounded: ["rate>0.95"],
    };
if (CONSISTENCY_RATIO > 0 && !OFFLINE) {
  thresholds["http_req_duration{endpoint:consistency}"] = ["p(95)<2500"];
  thresholds["audit_well_formed"] = ["rate>0.95"];
}
if (WRITE_LOAD) {
  // /ingest embeds every memory it writes, so it is the heaviest path; only add
  // its threshold when writes are actually exercised (avoids empty-sample noise).
  thresholds["http_req_duration{endpoint:ingest}"] = ["p(95)<3500"];
}

export const options = {
  scenarios,
  thresholds,
};

// ── Test body ────────────────────────────────────────────────────────────────
export default function () {
  // Always probe liveness first — cheap and read-only.
  health();

  // A bounded share of iterations exercise the expensive read path.
  if (Math.random() < READ_RATIO) {
    recall();
  }

  // The read-only self-audit path (offline profile exercises it every iteration).
  if (Math.random() < CONSISTENCY_RATIO) {
    consistency();
  }

  // Writes are strictly opt-in and clearly isolable.
  if (WRITE_LOAD && Math.random() < 0.25) {
    ingest();
  }

  sleep(1);
}

function health() {
  const res = http.get(`${BASE}/health`, { tags: { endpoint: "health" } });
  check(
    res,
    {
      "health: 200": (r) => r.status === 200,
      "health: status ok": (r) => safeJson(r)?.status === "ok",
      "health: reports embedder": (r) => typeof safeJson(r)?.embedder === "string",
    },
    { endpoint: "health" }
  );
}

function recall() {
  const body = JSON.stringify({
    question: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)],
    company: RECALL_COMPANY,
    kind: "payroll_event",
    limit: 3,
    hybrid: true,
  });
  const res = http.post(`${BASE}/recall`, body, {
    headers: JSON_HEADERS,
    tags: { endpoint: "recall" },
  });
  const json = safeJson(res);
  const grounded = Array.isArray(json?.hits);
  recallGrounded.add(grounded);
  check(
    res,
    {
      "recall: 200": (r) => r.status === 200,
      "recall: has answer string": () => typeof json?.answer === "string",
      "recall: hits is array": () => Array.isArray(json?.hits),
      "recall: citations is array": () => Array.isArray(json?.citations),
      "recall: reports modelId": () => typeof json?.modelId === "string",
    },
    { endpoint: "recall" }
  );
}

// Read-only self-audit load. Hits POST /consistency (the cross-session
// contradiction scan) — a pure DB read + in-process rule engine, no model call.
function consistency() {
  const body = JSON.stringify({ company: RECALL_COMPANY });
  const res = http.post(`${BASE}/consistency`, body, {
    headers: JSON_HEADERS,
    tags: { endpoint: "consistency" },
  });
  const json = safeJson(res);
  const wellFormed = Array.isArray(json?.contradictions);
  auditWellFormed.add(wellFormed);
  check(
    res,
    {
      "consistency: 200": (r) => r.status === 200,
      "consistency: contradictions is array": () => Array.isArray(json?.contradictions),
      "consistency: reports ok flag": () => typeof json?.ok === "boolean",
    },
    { endpoint: "consistency" }
  );
}

// Opt-in only (WRITE_LOAD=true). Every event is stamped with the isolable
// WRITE_COMPANY + a unique, greppable event_id so the writes can be purged.
function ingest() {
  const id = `k6-load-${Date.now()}-${__VU}-${__ITER}`;
  const event = {
    event_id: id,
    company: WRITE_COMPANY,
    period: "2026-05",
    employee_count: 1,
    bank_net_total: 5800,
    gross_total: 8000,
    employer_social_security_total: 1800,
    employee_social_security_total: 600,
    tax_withheld_total: 1600,
    employer_cost_total: 9800,
    cost_gap_amount: 4000,
    cost_gap_pct: 68.97,
    off_bank_cost: 4000,
    employees: [
      {
        employee_id: "E-01",
        name: "Load Test",
        gross: 8000,
        employee_social_security: 600,
        tax: 1600,
        net: 5800,
        employer_social_security: 1800,
        employer_cost: 9800,
      },
    ],
    linked_docs: ["k6-doc-1"],
  };
  const res = http.post(`${BASE}/ingest`, JSON.stringify({ event }), {
    headers: JSON_HEADERS,
    tags: { endpoint: "ingest" },
  });
  const json = safeJson(res);
  check(
    res,
    {
      "ingest: 200": (r) => r.status === 200,
      "ingest: wrote memories": () => typeof json?.written === "number" && json.written >= 1,
      "ingest: returns ids array": () => Array.isArray(json?.ids),
    },
    { endpoint: "ingest" }
  );
}

function safeJson(res) {
  try {
    return res.json();
  } catch (_e) {
    return null;
  }
}

// ── Summary artifact ─────────────────────────────────────────────────────────
// Emit both a human-readable stdout summary and a machine-readable JSON file
// (uploaded as a CI artifact by .github/workflows/load-test.yml).
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "load-summary.json": JSON.stringify(data, null, 2),
  };
}
