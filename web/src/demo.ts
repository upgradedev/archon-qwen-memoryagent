// Canned demo data — the DEFAULT the dashboard renders with zero backend.
//
// Everything here is typed against the real API contract in ./types, so the demo
// path and the live path render through the exact same components. The scenario
// is a fictional studio, "ByteCraft Studios", framed in universal financial terms
// (gross, employer cost, bank transfer, employer social-security) — no jurisdiction.

import type { Health, MemoryCount, RecallResponse, ConsistencyReport } from "./types";

export const DEMO_HEALTH: Health = {
  status: "ok",
  embedder: "text-embedding-v4",
  narrator: "qwen-plus",
  embedDim: 1024,
};

export const DEMO_COUNT: MemoryCount = { count: 128 };

// The €18,000-vs-€19,000 cross-session contradiction, surfaced by the audit over
// the memories JUST recalled. The later write (€19,000) is recommended by recency.
const DEMO_RECALL_CONSISTENCY: ConsistencyReport = {
  audited: 3,
  subjects: 1,
  ok: false,
  absences: [],
  contradictions: [
    {
      type: "contradiction",
      subject: "evt-bytecraft-2026-05",
      attribute: "employer_cost_total",
      values: [
        {
          memoryId: "b3e1a0c2-0001-4a10-9f21-earlier0write0",
          sourceRef: "evt-bytecraft-2026-05",
          value: 18000,
          createdAt: "2026-05-03T09:12:00.000Z",
        },
        {
          memoryId: "b3e1a0c2-0002-4a10-9f21-later00write00",
          sourceRef: "evt-bytecraft-2026-05",
          value: 19000,
          createdAt: "2026-05-04T14:30:00.000Z",
        },
      ],
      resolution: {
        recommendedMemoryId: "b3e1a0c2-0002-4a10-9f21-later00write00",
        recommendedValue: 19000,
        rule: "recency",
        confidence: 0.5,
        rationale:
          "Later write (2026-05-04) supersedes the earlier value 18000 (2026-05-03); " +
          "recency is the default tie-breaker.",
      },
    },
  ],
};

export const DEMO_RECALL: RecallResponse = {
  modelId: "qwen-plus",
  answer:
    "ByteCraft Studios' true workforce cost for 2026-05 is €19,000 [1] — the full " +
    "employer cost of the four-person team, well above the €10,000 net salary that " +
    "actually left the bank account [1]. The €9,000 gap is hidden workforce cost, " +
    "mostly employer social-security contributions of €6,000 [2], so the bank " +
    "transfer alone understates the true cost of employing the team by 90% [2]. " +
    "Note: an earlier session recorded the employer cost as €18,000 [3]; that value " +
    "conflicts with [1] and should be reviewed — the audit recommends trusting the " +
    "later €19,000 figure.",
  citations: [
    {
      marker: "[1]",
      kind: "payroll_event",
      score: 0.634,
      sourceRef: "evt-bytecraft-2026-05",
      content:
        "Workforce cost for ByteCraft Studios in 2026-05: 4 employees, gross €13,000, " +
        "true employer cost €19,000, net paid from bank €10,000.",
    },
    {
      marker: "[2]",
      kind: "insight",
      score: 0.588,
      sourceRef: "evt-bytecraft-2026-05",
      content:
        "Hidden workforce cost at ByteCraft Studios for 2026-05: the bank salary " +
        "transfer of €10,000 understates the true cost of employing the team by €9,000 " +
        "(90.0%), mostly employer social-security contributions of €6,000.",
    },
    {
      marker: "[3]",
      kind: "payroll_event",
      score: 0.551,
      sourceRef: "evt-bytecraft-2026-05",
      content:
        "Workforce cost for ByteCraft Studios in 2026-05 (earlier session): 4 employees, " +
        "gross €13,000, true employer cost €18,000, net paid from bank €10,000.",
    },
  ],
  hits: [
    {
      id: "b3e1a0c2-0002-4a10-9f21-later00write00",
      kind: "payroll_event",
      company: "ByteCraft Studios",
      period: "2026-05",
      sourceRef: "evt-bytecraft-2026-05",
      content:
        "Workforce cost for ByteCraft Studios in 2026-05: 4 employees, gross €13,000, " +
        "true employer cost €19,000, net paid from bank €10,000.",
      metadata: {
        employee_count: 4,
        gross_total: 13000,
        employer_cost_total: 19000,
        bank_net_total: 10000,
      },
      createdAt: "2026-05-04T14:30:00.000Z",
      distance: 0.366,
      score: 0.634,
      rrfScore: 0.0164,
    },
    {
      id: "c9f2b1d3-0003-4b20-8e32-insight0write00",
      kind: "insight",
      company: "ByteCraft Studios",
      period: "2026-05",
      sourceRef: "evt-bytecraft-2026-05",
      content:
        "Hidden workforce cost at ByteCraft Studios for 2026-05: the bank salary " +
        "transfer of €10,000 understates the true cost of employing the team by €9,000 " +
        "(90.0%), mostly employer social-security contributions of €6,000.",
      metadata: {
        hidden_total: 9000,
        cost_gap_pct: 90.0,
        employer_social_security_total: 6000,
      },
      createdAt: "2026-05-04T14:30:01.000Z",
      distance: 0.412,
      score: 0.588,
      rrfScore: 0.0161,
    },
    {
      id: "b3e1a0c2-0001-4a10-9f21-earlier0write0",
      kind: "payroll_event",
      company: "ByteCraft Studios",
      period: "2026-05",
      sourceRef: "evt-bytecraft-2026-05",
      content:
        "Workforce cost for ByteCraft Studios in 2026-05 (earlier session): 4 employees, " +
        "gross €13,000, true employer cost €18,000, net paid from bank €10,000.",
      metadata: {
        employee_count: 4,
        gross_total: 13000,
        employer_cost_total: 18000,
        bank_net_total: 10000,
      },
      createdAt: "2026-05-03T09:12:00.000Z",
      distance: 0.449,
      score: 0.551,
      rrfScore: 0.0159,
    },
  ],
  consistency: DEMO_RECALL_CONSISTENCY,
};

// The exhaustive self-audit report (POST /consistency) — the full-scope scan.
// Two cross-session contradictions on the same event: the headline employer-cost
// disagreement (€18,000 vs €19,000) and a knock-on cost-gap-percentage drift.
export const DEMO_CONSISTENCY: ConsistencyReport = {
  audited: 128,
  subjects: 61,
  ok: false,
  absences: [],
  contradictions: [
    {
      type: "contradiction",
      subject: "evt-bytecraft-2026-05",
      attribute: "employer_cost_total",
      values: [
        {
          memoryId: "b3e1a0c2-0001-4a10-9f21-earlier0write0",
          sourceRef: "evt-bytecraft-2026-05",
          value: 18000,
          createdAt: "2026-05-03T09:12:00.000Z",
        },
        {
          memoryId: "b3e1a0c2-0002-4a10-9f21-later00write00",
          sourceRef: "evt-bytecraft-2026-05",
          value: 19000,
          createdAt: "2026-05-04T14:30:00.000Z",
        },
      ],
      resolution: {
        recommendedMemoryId: "b3e1a0c2-0002-4a10-9f21-later00write00",
        recommendedValue: 19000,
        rule: "recency",
        confidence: 0.5,
        rationale:
          "Later write (2026-05-04) supersedes the earlier value 18000 (2026-05-03); " +
          "recency is the default tie-breaker.",
      },
    },
    {
      type: "contradiction",
      subject: "evt-bytecraft-2026-05",
      attribute: "cost_gap_pct",
      values: [
        {
          memoryId: "d7a4c8e5-0004-4c30-9d43-earlier0gap000",
          sourceRef: "evt-bytecraft-2026-05",
          value: 80.0,
          createdAt: "2026-05-03T09:12:00.000Z",
        },
        {
          memoryId: "d7a4c8e5-0005-4c30-9d43-later00gap0000",
          sourceRef: "evt-bytecraft-2026-05",
          value: 90.0,
          createdAt: "2026-05-04T14:30:00.000Z",
        },
      ],
      resolution: {
        recommendedMemoryId: "d7a4c8e5-0005-4c30-9d43-later00gap0000",
        recommendedValue: 90.0,
        rule: "recency",
        confidence: 0.5,
        rationale:
          "Later write (2026-05-04) supersedes the earlier value 80 (2026-05-03); " +
          "recency is the default tie-breaker.",
      },
    },
  ],
};
