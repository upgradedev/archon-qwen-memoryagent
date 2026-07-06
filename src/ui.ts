// The memory explorer — a single static, dependency-free HTML+JS page served by
// the SAME Fastify backend (GET / and GET /ui). A company filter + a question box
// call POST /recall same-origin and render the grounded answer, its citations, and
// a live /memory/count badge. No framework, no build step.
//
// The page is a plain .html file next to this module; the Dockerfile's
// `COPY src ./src` ships it, and it is read once at startup.

import { readFileSync } from "node:fs";

export const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
