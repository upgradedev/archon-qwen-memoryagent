// The memory explorer — a single static, dependency-free HTML+JS page served by
// the SAME Fastify backend (GET / and GET /ui). A company filter + a question box
// call POST /recall same-origin and render the grounded answer, its citations, and
// a live /memory/count badge. No framework, no build step.
//
// The page is a plain .html file next to this module; the Dockerfile's
// `COPY src ./src` ships it, and it is read once at startup.
//
// The one dynamic seam: the "try a question" chips are injected from
// DEMO_TEMPLATES (src/demo-data.ts) — the SAME list the CI end-to-end test asserts
// is answerable from the demo seed — so the chips a judge sees can never drift
// from the questions the pipeline verifies. The template array is substituted into
// a placeholder token in the page at module load.

import { readFileSync } from "node:fs";
import { DEMO_TEMPLATES } from "./demo-data.js";

const PLACEHOLDER = "/*__ARCHON_TEMPLATES__*/[]";

const raw = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
const injected = raw.replace(PLACEHOLDER, JSON.stringify(DEMO_TEMPLATES));

// Fail LOUD, not silent: if the placeholder was not found, the page would ship
// with empty chips (a broken demo). A no-op replace means the page and this
// module have drifted — surface it at startup instead of at a judge's click.
if (injected === raw) {
  throw new Error(
    `ui.ts: template placeholder "${PLACEHOLDER}" not found in ui.html — ` +
      `the chip list could not be injected. Restore the placeholder in ui.html.`,
  );
}

export const UI_HTML = injected;
