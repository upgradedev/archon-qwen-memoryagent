// End-to-end demo of the persistent agent-memory round trip on pgvector.
//
//   npm run db:schema      # once, to create tables + vector index
//   npm run memory:demo
//
// Uses real Qwen (text-embedding-v4 + qwen-plus) when DASHSCOPE_API_KEY is set,
// otherwise the deterministic FakeEmbedder + FakeNarrator — either way it
// exercises the SAME write + vector recall + narrate path against a live pgvector
// database. Shows an agent (a) ingesting fused financial events into memory, then
// (b) recalling relevant facts by meaning and (c) writing a grounded, citing
// answer to a question it was never given the keys for.

import { defaultEmbedder } from "../src/memory/embeddings.js";
import { defaultNarrator } from "../src/agents/narrator.js";
import { PgVectorStore } from "../src/memory/store.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { closePool } from "../src/db/client.js";
import type { PayrollEvent } from "../src/types.js";

const EVENTS: PayrollEvent[] = [
  {
    event_id: "evt-acme-2026-03",
    company: "Acme Foods AE",
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
      { employee_id: "E-01", name: "Maria Papadopoulou", gross: 22000, employee_ika: 1800, tax: 3000, net: 17200, employer_ika: 5000, employer_cost: 27000 },
      { employee_id: "E-02", name: "Nikos Georgiou", gross: 18000, employee_ika: 1500, tax: 2400, net: 14100, employer_ika: 4100, employer_cost: 22100 },
      { employee_id: "E-03", name: "Elena Dimitriou", gross: 12000, employee_ika: 900, tax: 1400, net: 9700, employer_ika: 2700, employer_cost: 14700 },
    ],
    linked_docs: ["doc-bank-1", "doc-reg-1"],
  },
  {
    event_id: "evt-helios-2026-02",
    company: "Helios Retail EPE",
    period: "2026-02",
    employee_count: 2,
    bank_net_total: 22000,
    gross_total: 28000,
    employer_ika_total: 6300,
    employee_ika_total: 2200,
    tax_withheld_total: 3800,
    employer_cost_total: 34300,
    cost_gap_amount: 6300,
    cost_gap_pct: 28.6,
    hidden_total: 12300,
    employees: [
      { employee_id: "H-01", name: "Georgios Alexiou", gross: 16000, employee_ika: 1300, tax: 2200, net: 12500, employer_ika: 3600, employer_cost: 19600 },
      { employee_id: "H-02", name: "Sofia Ioannou", gross: 12000, employee_ika: 900, tax: 1600, net: 9500, employer_ika: 2700, employer_cost: 14700 },
    ],
    linked_docs: ["doc-bank-2", "doc-reg-2"],
  },
];

async function main() {
  const embedder = defaultEmbedder();
  const narrator = defaultNarrator();
  const store = new PgVectorStore();
  console.log(`Embedder: ${embedder.modelId} (${embedder.dim} dims)`);
  console.log(`Narrator: ${narrator.modelId}\n`);
  const agent = new MemoryAgent(embedder, store, narrator);

  // Clean slate for a repeatable demo.
  await store.clear();

  // ── WRITE: agent commits fused events to memory ──────────────────────────
  for (const ev of EVENTS) {
    const ids = await agent.ingestEvent(ev);
    console.log(`WROTE ${ids.length} memories for ${ev.company} ${ev.period}`);
  }
  console.log(`Total memories in pgvector: ${await store.count()}\n`);

  // ── READ: agent recalls by MEANING, then NARRATES a grounded, cited answer ─
  const questions: { q: string; company?: string }[] = [
    { q: "What was our real employer payroll cost last month?", company: "Acme Foods AE" },
    { q: "How much payroll cost is hidden from the bank statement?", company: "Acme Foods AE" },
    { q: "Which social-security contributions does the employer pay?" }, // cross-company
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
