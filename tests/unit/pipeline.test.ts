// Unit tests for the document-ingestion pipeline — NO DB, NO key, NO network.
// Uses the FakeExtractionClient (content == the JSON the model would return),
// the InMemoryStore + FakeEmbedder/FakeNarrator, and a canned OpenAI-compatible
// client to cover the REAL QwenExtractionClient parse/routing branches offline
// (the same canned-client pattern as narrator.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Extractor, safeFloat } from "../../src/pipeline/extractor.js";
import { FakeExtractionClient, QwenExtractionClient, qwenExtractionClientFrom } from "../../src/pipeline/vision.js";
import { ClassifierAgent, classifyDocType } from "../../src/pipeline/classifier.js";
import { EventLinkerAgent, linkEvents } from "../../src/pipeline/event-linker.js";
import { ValidatorAgent, validateEvent } from "../../src/pipeline/validator.js";
import { runPipeline, ingestPipeline } from "../../src/pipeline/pipeline.js";
import type { RawDocument } from "../../src/pipeline/models.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { FakeNarrator } from "../../src/agents/narrator.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { MemoryAgent } from "../../src/agents/memory-agent.js";

// ── Fixture: a valid payroll triplet whose numbers pass R1–R4 ─────────────────
function triplet(company = "ByteCraft", period = "2026-05"): RawDocument[] {
  return [
    {
      doc_id: "d-reg", filename: "register.pdf", source_kind: "text", company, period,
      content: JSON.stringify({ doc_type: "payroll_register", gross_pay_total: 7000, employer_cost_total: 8600, employee_count: 2 }),
    },
    {
      doc_id: "d-bank", filename: "bank.pdf", source_kind: "text", company, period,
      content: JSON.stringify({ doc_type: "bank_confirmation", net_pay_total: 6500, payment_date: "2026-05-28" }),
    },
    {
      doc_id: "d-p1", filename: "payslip1.png", source_kind: "image", company, period,
      content: JSON.stringify({ doc_type: "payslip", employee: { employee_id: "E-01", name: "Ana Cole", gross: 4000, employee_social_security: 100, tax: 200, net: 3700, employer_social_security: 500, employer_cost: 4500 } }),
    },
    {
      doc_id: "d-p2", filename: "payslip2.png", source_kind: "image", company, period,
      content: JSON.stringify({ doc_type: "payslip", employee: { employee_id: "E-02", name: "Tom Reed", gross: 3000, employee_social_security: 80, tax: 120, net: 2800, employer_social_security: 1100, employer_cost: 4100 } }),
    },
  ];
}

// ── safeFloat (ADR-003 null-safety) ───────────────────────────────────────────
test("safeFloat: null / undefined / NaN fall back to the default", () => {
  assert.equal(safeFloat(null), 0);
  assert.equal(safeFloat(undefined, 5), 5);
  assert.equal(safeFloat("not a number"), 0);
  assert.equal(safeFloat("€1,234.50"), 1234.5); // strips currency symbols
  assert.equal(safeFloat(42), 42);
});

// ── Extractor (Fake client) ───────────────────────────────────────────────────
test("Extractor: parses a register document into normalized totals", async () => {
  const ex = new Extractor(new FakeExtractionClient());
  const doc = await ex.extract(triplet()[0]!);
  assert.equal(doc.doc_type, "payroll_register");
  assert.equal(doc.gross_pay_total, 7000);
  assert.equal(doc.employer_cost_total, 8600);
  assert.equal(doc.company, "ByteCraft");
});

test("Extractor: derives employer_cost when only gross + employer SS present", async () => {
  const ex = new Extractor(new FakeExtractionClient());
  const raw: RawDocument = {
    doc_id: "d", filename: "r.pdf", source_kind: "text", company: "X", period: "2026-01",
    content: JSON.stringify({ doc_type: "payroll_register", gross_pay_total: 1000, employer_social_security_total: 250 }),
  };
  const doc = await ex.extract(raw);
  assert.equal(doc.employer_cost_total, 1250);
});

test("Extractor: derives payslip employer_cost when omitted (gross + employer SS)", async () => {
  const ex = new Extractor(new FakeExtractionClient());
  const raw: RawDocument = {
    doc_id: "d", filename: "p.png", source_kind: "image",
    content: JSON.stringify({ doc_type: "payslip", employee: { employee_id: "E-9", name: "Q", gross: 2000, employer_social_security: 400 } }),
  };
  const doc = await ex.extract(raw);
  assert.equal(doc.payslip?.employer_cost, 2400);
});

test("Extractor: tolerates prose-wrapped / fenced JSON and null fields", async () => {
  // A canned client returning messy output — exercises parseJsonLoose + null-safety.
  const canned = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "Here you go:\n```json\n{\"doc_type\":\"bank_confirmation\",\"net_pay_total\":null,\"payment_date\":\"2026-05-10\"}\n```" } }] }) } },
  };
  const ex = new Extractor(qwenExtractionClientFrom(canned as never));
  const doc = await ex.extract({ doc_id: "d", filename: "b.pdf", source_kind: "text", content: "" });
  assert.equal(doc.doc_type, "bank_confirmation");
  assert.equal(doc.net_pay_total, null); // null stays null, no crash
  assert.equal(doc.payment_date, "2026-05-10");
});

test("QwenExtractionClient: routes an image doc to the vision model with an image part", async () => {
  let seen: { model?: string; hasImage?: boolean } = {};
  const canned = {
    chat: {
      completions: {
        create: async (args: { model: string; messages: Array<{ content: unknown }> }) => {
          seen.model = args.model;
          const user = args.messages[1]!.content;
          seen.hasImage = Array.isArray(user) && user.some((p: { type: string }) => p.type === "image_url");
          return { choices: [{ message: { content: "{}" } }] };
        },
      },
    },
  };
  const client = new QwenExtractionClient(canned as never, "qwen-vl-max", "qwen-plus");
  await client.extract({ doc_id: "d", filename: "p.png", source_kind: "image", content: "data:image/png;base64,AAAA" });
  assert.equal(seen.model, "qwen-vl-max");
  assert.equal(seen.hasImage, true);
});

test("QwenExtractionClient: routes a text doc to the text model, no image part", async () => {
  let seen: { model?: string; isString?: boolean } = {};
  const canned = {
    chat: { completions: { create: async (args: { model: string; messages: Array<{ content: unknown }> }) => {
      seen.model = args.model;
      seen.isString = typeof args.messages[1]!.content === "string";
      return { choices: [{ message: { content: "{}" } }] };
    } } },
  };
  const client = new QwenExtractionClient(canned as never, "qwen-vl-max", "qwen-plus");
  await client.extract({ doc_id: "d", filename: "r.txt", source_kind: "text", content: "some text" });
  assert.equal(seen.model, "qwen-plus");
  assert.equal(seen.isString, true);
});

// ── ClassifierAgent (rule-based) ──────────────────────────────────────────────
test("classifyDocType: repairs an unknown doc_type from field shape", () => {
  assert.equal(classifyDocType({ doc_id: "1", doc_type: "unknown", company: "X", period: "p", payslip: { employee_id: "e", name: "n", gross: 1, employee_social_security: 0, tax: 0, net: 1, employer_social_security: 0, employer_cost: 1 }, model_id: "m" }), "payslip");
  assert.equal(classifyDocType({ doc_id: "2", doc_type: "unknown", company: "X", period: "p", gross_pay_total: 100, model_id: "m" }), "payroll_register");
  assert.equal(classifyDocType({ doc_id: "3", doc_type: "unknown", company: "X", period: "p", net_pay_total: 50, model_id: "m" }), "bank_confirmation");
  assert.equal(classifyDocType({ doc_id: "4", doc_type: "unknown", company: "X", period: "p", model_id: "m" }), "unknown");
});

test("ClassifierAgent.classify does not mutate the input document", () => {
  const c = new ClassifierAgent();
  const input = { doc_id: "1", doc_type: "unknown" as const, company: "X", period: "p", gross_pay_total: 100, model_id: "m" };
  const out = c.classify(input);
  assert.equal(input.doc_type, "unknown");
  assert.equal(out.doc_type, "payroll_register");
});

// ── EventLinkerAgent (fusion + P&L wedge) ─────────────────────────────────────
test("linkEvents: fuses the triplet into one accurate PayrollEvent", async () => {
  const ex = new Extractor(new FakeExtractionClient());
  const classified = new ClassifierAgent().classifyAll(await ex.extractAll(triplet()));
  const [event] = linkEvents(classified);
  assert.ok(event);
  assert.equal(event.company, "ByteCraft");
  assert.equal(event.employee_count, 2);
  assert.equal(event.gross_total, 7000);
  assert.equal(event.employer_cost_total, 8600);
  assert.equal(event.bank_net_total, 6500);
  assert.equal(event.employer_social_security_total, 1600); // 8600 - 7000
  assert.equal(event.hidden_total, 2100); // 8600 - 6500
  assert.equal(event.employees.length, 2);
  assert.equal(event.linked_docs.length, 4);
});

test("linkEvents: falls back to payslip sums when the register is missing", () => {
  const events = linkEvents([
    { doc_id: "b", doc_type: "bank_confirmation", company: "X", period: "2026-01", net_pay_total: 5000, model_id: "m" },
    { doc_id: "p1", doc_type: "payslip", company: "X", period: "2026-01", model_id: "m", payslip: { employee_id: "E1", name: "A", gross: 3000, employee_social_security: 0, tax: 0, net: 2600, employer_social_security: 400, employer_cost: 3400 } },
    { doc_id: "p2", doc_type: "payslip", company: "X", period: "2026-01", model_id: "m", payslip: { employee_id: "E2", name: "B", gross: 3000, employee_social_security: 0, tax: 0, net: 2400, employer_social_security: 400, employer_cost: 3400 } },
  ]);
  const [e] = events;
  assert.equal(e!.gross_total, 6000); // sum of payslip gross
  assert.equal(e!.employer_cost_total, 6800); // gross + employer SS
  assert.equal(e!.employee_count, 2);
});

test("linkEvents: groups separate companies/periods into separate events", () => {
  const events = linkEvents([
    { doc_id: "a", doc_type: "payroll_register", company: "A", period: "2026-01", gross_pay_total: 100, employer_cost_total: 120, employee_count: 1, model_id: "m" },
    { doc_id: "b", doc_type: "payroll_register", company: "B", period: "2026-01", gross_pay_total: 200, employer_cost_total: 250, employee_count: 1, model_id: "m" },
  ]);
  assert.equal(events.length, 2);
});

// ── ValidatorAgent (R1–R4) ────────────────────────────────────────────────────
test("validateEvent: a clean triplet passes R1 and R4", async () => {
  const ex = new Extractor(new FakeExtractionClient());
  const classified = new ClassifierAgent().classifyAll(await ex.extractAll(triplet()));
  const [event] = linkEvents(classified);
  const results = validateEvent(event!, "2026-05-28");
  const byRule = Object.fromEntries(results.map((r) => [r.rule.split(":")[0], r]));
  assert.equal(byRule.R1!.passed, true); // bank 6500 == payslip net 6500
  assert.equal(byRule.R4!.passed, true); // 2 == 2
});

test("validateEvent: R1 flags a bank vs payslip mismatch beyond 2%", () => {
  const results = validateEvent({
    event_id: "e", company: "X", period: "2026-01", employee_count: 1, bank_net_total: 5000,
    gross_total: 4000, employer_social_security_total: 800, employee_social_security_total: 0,
    tax_withheld_total: 0, employer_cost_total: 4800, cost_gap_amount: 800, cost_gap_pct: 16, hidden_total: -200,
    employees: [{ employee_id: "E1", name: "A", gross: 4000, employee_social_security: 0, tax: 0, net: 4000, employer_social_security: 800, employer_cost: 4800 }],
    linked_docs: [],
  });
  const r1 = results.find((r) => r.rule.startsWith("R1"))!;
  assert.equal(r1.passed, false);
  assert.equal(r1.severity, "error");
});

test("validateEvent: R3 flags a payment date after the period end", () => {
  const r = validateEvent({
    event_id: "e", company: "X", period: "2026-02", employee_count: 1, bank_net_total: 100,
    gross_total: 100, employer_social_security_total: 20, employee_social_security_total: 0,
    tax_withheld_total: 0, employer_cost_total: 120, cost_gap_amount: 20, cost_gap_pct: 20, hidden_total: 20,
    employees: [{ employee_id: "E1", name: "A", gross: 100, employee_social_security: 0, tax: 0, net: 100, employer_social_security: 20, employer_cost: 120 }],
    linked_docs: [],
  }, "2026-03-05"); // March payment for a February period
  const r3 = r.find((x) => x.rule.startsWith("R3"))!;
  assert.equal(r3.passed, false);
});

test("ValidatorAgent: skips rules gracefully on an incomplete event", () => {
  const results = new ValidatorAgent().validate({
    event_id: "e", company: "X", period: "2026-01", employee_count: 0, bank_net_total: 0,
    gross_total: 0, employer_social_security_total: 0, employee_social_security_total: 0,
    tax_withheld_total: 0, employer_cost_total: 0, cost_gap_amount: 0, cost_gap_pct: 0, hidden_total: 0,
    employees: [], linked_docs: [],
  });
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.passed)); // all skipped → pass/info
});

// ── Orchestrator: runPipeline + ingestPipeline (memory-feed) ──────────────────
test("runPipeline: produces one event with P&L + validation, no DB", async () => {
  const out = await runPipeline(triplet(), { extractor: new Extractor(new FakeExtractionClient()) });
  assert.equal(out.events.length, 1);
  const [r] = out.events;
  assert.equal(r!.event.employer_cost_total, 8600);
  assert.equal(r!.pnl.off_bank_cost, 2100);
  assert.equal(r!.validation.length, 4);
});

test("ingestPipeline: writes the fused event + validation findings into memory", async () => {
  const store = new InMemoryStore();
  const agent = new MemoryAgent(new FakeEmbedder(), store, new FakeNarrator());
  const out = await ingestPipeline(agent, triplet(), { extractor: new Extractor(new FakeExtractionClient()) });

  assert.ok(out.memoryIds.length > 0);
  assert.equal(await store.count(), out.memoryIds.length);

  // The memory is now demonstrably fed by the pipeline: the agent can recall it.
  const { hits } = await agent.recallAnswer("what did it cost to employ the team?", { company: "ByteCraft" });
  assert.ok(hits.length > 0);

  // At least one validation memory was written (a recallable cross-doc check).
  const audit = await store.listForAudit({ company: "ByteCraft", kind: "validation" });
  assert.ok(audit.length >= 1);
});
