// Export the FROZEN benchmark data the external head-to-head (Mem0) consumes, so
// the Python harness and the TypeScript benchmark read the SAME corpus, queries
// and conflict pairs — one source of truth, no drift.
//
//   npm run bench:export        # writes bench/external/data.json
//
// The conflict pairs mirror the labelled consistency dataset
// (bench/consistency-dataset.ts) so the "detect + resolve" head-to-head runs on
// the exact records our own audit is measured on. The retrieval probe reuses the
// frozen retrieval corpus/queries (bench/dataset.ts). Numbers are graded
// objectively (figure present), never by subjective token soup.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS, QUERIES } from "../dataset.js";

const here = dirname(fileURLToPath(import.meta.url));

// ── Conflict pairs (same records as the consistency dataset) ──────────────────
// Each pair is TWO cross-session write events about ONE record that disagree on
// ONE attribute. Natural-language content so Mem0's LLM fact-extractor has real
// text to ingest; the structured fields let both systems be graded identically.
const conflictPairs = [
  {
    record: "INV-2043",
    attribute: "total",
    a: { content: "Invoice INV-2043 total is 18400 euros.", value: 18400 },
    b: { content: "Invoice INV-2043 total is 18900 euros.", value: 18900 },
  },
  {
    record: "CUST-77",
    attribute: "credit_limit",
    a: { content: "Customer CUST-77 has a credit limit of 5000 euros.", value: 5000 },
    b: { content: "Customer CUST-77 has a credit limit of 8000 euros.", value: 8000 },
  },
  {
    record: "PO-5590",
    attribute: "quantity",
    a: { content: "Purchase order PO-5590 is for a quantity of 12 tonnes.", value: 12 },
    b: { content: "Purchase order PO-5590 is for a quantity of 15 tonnes.", value: 15 },
  },
  {
    record: "VENDOR-BoxLine",
    attribute: "status",
    a: { content: "Vendor BoxLine account status is active.", value: "active" },
    b: { content: "Vendor BoxLine account status is suspended.", value: "suspended" },
  },
];

// ── Retrieval probe: the SPECIFIC-genre queries whose answer is one exact figure
// (objective to grade: is the gold figure present in the returned memories?). We
// deliberately grade only these unambiguous, number-bearing queries — no
// subjective content-token judging.
const retrievalProbe = [
  { id: "q06", question: "What is the amount on invoice INV-2043?", goldFigure: 18400 },
  { id: "q07", question: "What is the total value of purchase order PO-5590?", goldFigure: 12900 },
  { id: "q08", question: "What was ByteCraft's EBITDA in 2026-05?", goldFigure: 38400 },
  { id: "q10", question: "What is the amount on purchase invoice PINV-771?", goldFigure: 6300 },
  { id: "q14", question: "How much cash did Acme Foods hold at end of 2026-04?", goldFigure: 27600 },
];

const out = {
  note:
    "Frozen data for the external head-to-head. corpus/queries mirror bench/dataset.ts; " +
    "conflictPairs mirror bench/consistency-dataset.ts. Regenerate with `npm run bench:export`.",
  corpus: CORPUS.map((m) => ({ id: m.id, content: m.content })),
  queries: QUERIES.map((q) => ({ id: q.id, genre: q.genre, text: q.text, gold: q.gold })),
  conflictPairs,
  retrievalProbe,
};

mkdirSync(join(here), { recursive: true });
const path = join(here, "data.json");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path}  (${out.corpus.length} memories, ${out.conflictPairs.length} conflict pairs, ${out.retrievalProbe.length} retrieval probes)`);
