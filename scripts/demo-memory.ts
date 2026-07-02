// End-to-end demo of the persistent agent-memory round trip on pgvector.
//
//   npm run db:schema      # once, to create tables + vector index
//   npm run memory:demo
//
// Uses real Qwen (text-embedding-v4 + qwen-plus) when DASHSCOPE_API_KEY is set,
// otherwise the deterministic FakeEmbedder + FakeNarrator — either way it
// exercises the SAME write + vector recall + narrate path against a live pgvector
// database. It shows an agent (a) ingesting a business's WHOLE financial picture
// into memory — sales & purchase invoices, payments, bank statements, P&L, cash,
// cross-check findings, and workforce cost as one aspect among many — then (b)
// recalling relevant facts by meaning and (c) writing grounded, citing answers to
// questions it was never handed the keys for.

import { defaultEmbedder } from "../src/memory/embeddings.js";
import { defaultNarrator } from "../src/agents/narrator.js";
import { PgVectorStore } from "../src/memory/store.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import type { MemoryKind } from "../src/memory/store.js";
import { closePool } from "../src/db/client.js";
import type { PayrollEvent } from "../src/types.js";

// A diverse slice of a small business's financial memory — the FULL picture, not
// just one document type. Each is a fact the pipeline's agents have committed for
// future sessions to recall. (Workforce cost is added separately below, as one
// example among these.)
const FACTS: Array<{
  kind: MemoryKind;
  content: string;
  company?: string;
  period?: string;
  sourceRef?: string;
  importance?: number;
}> = [
  { kind: "document", company: "Acme Foods", period: "2026-03", sourceRef: "INV-2043",
    content: "Sales invoice INV-2043 issued by Acme Foods to Northwind Traders on 2026-03: €18,400 for a wholesale grocery order, payable within 30 days." },
  { kind: "document", company: "Acme Foods", period: "2026-03", sourceRef: "PINV-802",
    content: "Purchase invoice PINV-802 from wholesaler GrainCo to Acme Foods on 2026-03: €12,900 for raw materials." },
  { kind: "document", company: "Helios Retail", period: "2026-02", sourceRef: "stmt-helios-2026-02",
    content: "Bank statement for Helios Retail, 2026-02: opening balance €31,200, closing balance €19,700, across 14 transactions." },
  { kind: "document", company: "ByteCraft Software", period: "2026-05", sourceRef: "pnl-bytecraft-2026-05",
    content: "P&L for ByteCraft Software in 2026-05: revenue €210,000, operating profit €41,200, EBITDA €38,400 (18.3% margin)." },
  { kind: "document", company: "Acme Foods", period: "2026-04", sourceRef: "cash-acme-2026-04",
    content: "Cash position for Acme Foods at the end of 2026-04: €27,600 across two bank accounts, down €3,400 from the prior month." },
  // Completeness anomaly — surfaced on equal footing with the numbers, and kept
  // as a high-importance memory so it survives forgetting.
  { kind: "validation", company: "Helios Retail", period: "2026-02", sourceRef: "check-helios-2026-02", importance: 0.9,
    content: "Completeness check for Helios Retail 2026-02: a €3,200 bank payment to Pallas Freight has no matching purchase invoice (high severity) — either the supplier never sent it, the accountant never recorded it, or the payment is wrong." },
  // Remembered user preference (the MemoryAgent track's "remembers preferences").
  { kind: "insight", sourceRef: "pref-report-layout", importance: 0.8,
    content: "User preference: every summary should open with the consolidated P&L and cash position, then flag any missing or inconsistent documents." },
];

// Workforce cost — ONE business aspect among the many above, ingested through the
// typed PayrollEvent path that fuses a bank confirmation, a register, and payslips.
const WORKFORCE_EVENT: PayrollEvent = {
  event_id: "evt-acme-2026-03",
  company: "Acme Foods",
  period: "2026-03",
  employee_count: 3,
  bank_net_total: 41000,
  gross_total: 52000,
  employer_ika_total: 11800,
  employee_ika_total: 4200,
  tax_withheld_total: 6800,
  employer_cost_total: 63800,
  cost_gap_amount: 11800,
  cost_gap_pct: 28.8,
  hidden_total: 22800,
  employees: [
    { employee_id: "E-01", name: "Ana Ruiz", gross: 22000, employee_ika: 1800, tax: 3000, net: 17200, employer_ika: 5000, employer_cost: 27000 },
    { employee_id: "E-02", name: "Tom Becker", gross: 18000, employee_ika: 1500, tax: 2400, net: 14100, employer_ika: 4100, employer_cost: 22100 },
    { employee_id: "E-03", name: "Lena Weber", gross: 12000, employee_ika: 900, tax: 1400, net: 9700, employer_ika: 2700, employer_cost: 14700 },
  ],
  linked_docs: ["doc-bank-1", "doc-reg-1"],
};

async function main() {
  const embedder = defaultEmbedder();
  const narrator = defaultNarrator();
  const store = new PgVectorStore();
  console.log(`Embedder: ${embedder.modelId} (${embedder.dim} dims)`);
  console.log(`Narrator: ${narrator.modelId}\n`);
  const agent = new MemoryAgent(embedder, store, narrator);

  // Clean slate for a repeatable demo.
  await store.clear();

  // ── WRITE: agent commits the full financial picture to memory ──────────────
  for (const f of FACTS) {
    const { kind, content, ...opts } = f;
    await agent.remember(kind, content, opts);
  }
  console.log(`WROTE ${FACTS.length} memories across the financial picture (invoices, bank, P&L, cash, a completeness check, a preference)`);
  const ids = await agent.ingestEvent(WORKFORCE_EVENT);
  console.log(`WROTE ${ids.length} more for the ${WORKFORCE_EVENT.company} ${WORKFORCE_EVENT.period} workforce-cost event (one aspect among many)`);
  console.log(`Total memories in pgvector: ${await store.count()}\n`);

  // ── READ: agent recalls by MEANING, then NARRATES a grounded, cited answer ─
  // Lead with the broad picture; workforce cost is just one of the questions.
  const questions: { q: string; company?: string }[] = [
    { q: "How profitable was the software company last month?", company: "ByteCraft Software" },
    { q: "Is any money leaving the account without a matching invoice?" }, // completeness, cross-company
    { q: "How much cash did we hold at the end of last month?", company: "Acme Foods" },
    { q: "What does it really cost us to employ the team?", company: "Acme Foods" }, // workforce, one aspect
  ];
  for (const { q, company } of questions) {
    const { answer, citations, modelId } = await agent.recallAnswer(q, { company, limit: 3 });
    console.log(`Q: ${q}${company ? `  [company=${company}]` : "  [all companies]"}`);
    console.log(`A (${modelId}): ${answer}`);
    console.log(
      `Grounded in ${citations.length} recalled memory item(s): ` +
        citations.map((c) => `${c.marker} ${c.kind}`).join(", ") +
        "\n"
    );
  }

  await closePool();
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
