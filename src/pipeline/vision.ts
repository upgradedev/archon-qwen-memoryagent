// Extraction client — the ONE seam the document extractor talks to a model
// through, mirroring the Embedder/Narrator pattern (../memory/embeddings.ts,
// ../agents/narrator.ts). An image document routes to the Qwen VISION model
// (qwen-vl-max) as an OpenAI-compatible multimodal message; a text/pdf document
// routes to the Qwen TEXT model (qwen-plus) as a plain chat message. Both return
// the model's raw JSON string, which the Extractor null-safe-parses.
//
// Two implementations behind one `ExtractionClient` interface:
//   QwenExtractionClient — real vision/text extraction on Model Studio (DashScope).
//   FakeExtractionClient — deterministic, no key. Returns the document's own
//                          JSON payload, so the whole pipeline runs offline in CI
//                          exactly as FakeNarrator/FakeEmbedder do.
// `defaultExtractionClient()` auto-selects Qwen when a DashScope key is present.

import {
  createQwenClient,
  hasQwenCreds,
  type QwenChatClient,
} from "../qwen/client.js";
import type { RawDocument } from "./models.js";

// The vision model that reads scanned / image documents. Configurable; defaults
// to qwen-vl-max (verified live on DashScope). qwen3-vl-plus also works.
export const DEFAULT_VISION_MODEL = process.env.VISION_MODEL || "qwen-vl-max";
// The text model that reads digital text / pdf documents (shares the analysis model).
export const DEFAULT_EXTRACT_TEXT_MODEL =
  process.env.EXTRACT_TEXT_MODEL || process.env.QWEN_MODEL || "qwen-plus";

// What the extractor asks the model for: a normalized financial record as JSON.
export const EXTRACTION_SYSTEM_PROMPT =
  "You are a financial-document extraction agent. Read the supplied business " +
  "document and return ONE JSON object with the financial fields you can read: " +
  "doc_type (payroll_register | bank_confirmation | payslip), company, period " +
  "(YYYY-MM), and the numeric totals present — gross_pay_total, " +
  "employer_cost_total, net_pay_total, employee_count, payment_date, and for a " +
  "single payslip an employee object {employee_id,name,gross," +
  "employee_social_security,tax,net,employer_social_security,employer_cost}. " +
  "Use null for anything the document does not state. Return JSON only, no prose.";

// The multimodal content shape the OpenAI-compatible vision endpoint expects.
type VisionContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// A chat client that also accepts multimodal (image) content parts. The stock
// `openai` client satisfies this at runtime; the narrow type keeps the seam
// injectable + offline-fakeable.
export interface MultimodalChatClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: Array<
          | { role: "system" | "user" | "assistant"; content: string }
          | { role: "user"; content: VisionContent[] }
        >;
        temperature?: number;
        max_tokens?: number;
      }): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
}

export interface ExtractionClient {
  readonly visionModel: string;
  readonly textModel: string;
  // Return the model's raw JSON string for one document.
  extract(doc: RawDocument): Promise<string>;
}

// Real extraction via Model Studio. Image docs → vision model with an image_url
// part; text/pdf docs → text model with the document text inline.
export class QwenExtractionClient implements ExtractionClient {
  readonly visionModel: string;
  readonly textModel: string;
  constructor(
    private client: MultimodalChatClient = createQwenClient() as unknown as MultimodalChatClient,
    visionModel: string = DEFAULT_VISION_MODEL,
    textModel: string = DEFAULT_EXTRACT_TEXT_MODEL,
  ) {
    this.visionModel = visionModel;
    this.textModel = textModel;
  }

  async extract(doc: RawDocument): Promise<string> {
    const isImage = doc.source_kind === "image";
    const model = isImage ? this.visionModel : this.textModel;
    const userMsg = isImage
      ? {
          role: "user" as const,
          content: [
            { type: "text" as const, text: `Extract document ${doc.filename}.` },
            { type: "image_url" as const, image_url: { url: doc.content } },
          ],
        }
      : {
          role: "user" as const,
          content: `Extract document ${doc.filename}:\n\n${doc.content}`,
        };
    const res = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        userMsg,
      ],
      temperature: 0,
      max_tokens: 1024,
    });
    return res.choices?.[0]?.message?.content?.trim() || "{}";
  }
}

// Deterministic offline extractor. The document's `content` already carries the
// JSON the model WOULD return (the same convention the other Fakes use), so the
// fake simply hands it back — exercising the full extract→classify→link→validate
// path with no key and no network.
export class FakeExtractionClient implements ExtractionClient {
  readonly visionModel = "fake-vision-extractor";
  readonly textModel = "fake-text-extractor";
  async extract(doc: RawDocument): Promise<string> {
    return doc.content?.trim() || "{}";
  }
}

// Wrap a real OpenAI-compatible client (satisfies both QwenChatClient and the
// multimodal shape) into the extraction seam. Exported for the narrator-style
// canned-client unit test.
export function qwenExtractionClientFrom(client: QwenChatClient): ExtractionClient {
  return new QwenExtractionClient(client as unknown as MultimodalChatClient);
}

export function defaultExtractionClient(): ExtractionClient {
  return hasQwenCreds() ? new QwenExtractionClient() : new FakeExtractionClient();
}
