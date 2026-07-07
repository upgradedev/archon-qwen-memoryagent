#!/usr/bin/env python3
"""Capture a short LIVE browser interaction with the Archon MemoryAgent Explorer UI
into a sequence of 1920x1080 PNG screenshots (web_shots/*.png) that the demo-video
workflow assembles into an ~8.5s "live in the browser" segment.

The Explorer UI (src/ui.html) is served by the live Alibaba Cloud box at BOTH `/`
and `/ui`. This drives that real UI end to end:

    seed (idempotent) -> open Explorer -> type a company + a question -> Recall ->
    WAIT for a grounded, CITED qwen-plus answer -> screenshot the cited answer ->
    open the "memories N" browse view -> WAIT for real memory rows -> screenshot.

HARD gates (fail the whole job — never ship a blank or leaky web scene):
  * the live memory count badge must resolve to a real number >= 1
  * the recall answer must be non-empty AND carry >= 1 citation
  * a POSITIONING guard (the same regex as scripts/capture_live.sh, plus `aade`)
    fails on any country/authority term in the on-screen answer, citations, or
    browsed rows — so a positioning leak fails the build instead of shipping.

Env:
  DEMO_BASE_URL  live base URL (default https://memory.43.106.13.19.sslip.io)
  WEB_COMPANY    company to type      (default "Northwind Trading" — the seed company)
  WEB_QUESTION   question to type     (default the verified template question)
"""
from __future__ import annotations

import os
import re
import sys
import pathlib

from playwright.sync_api import sync_playwright

BASE = os.environ.get("DEMO_BASE_URL", "https://memory.43.106.13.19.sslip.io").rstrip("/")
COMPANY = os.environ.get("WEB_COMPANY", "Northwind Trading")
QUESTION = os.environ.get("WEB_QUESTION", "What did it really cost to employ the team?")

# Same positioning guard as scripts/capture_live.sh (+ `aade`): the memory is a
# pure, domain-neutral financial engine — no country/authority-specific terms may
# appear in anything the browser puts on screen.
FORBIDDEN = re.compile(r"hidden|ika|efka|mydata|greek|greece|αφμ|aade", re.IGNORECASE)

OUT = pathlib.Path("web_shots")
OUT.mkdir(exist_ok=True)


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def guard(label: str, text: str) -> None:
    if FORBIDDEN.search(text or ""):
        fail(f"{label} contains a forbidden positioning term (/{FORBIDDEN.pattern}/) — "
             "universal financial terms only")


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            ignore_https_errors=True,
        )
        # Suppress the auto-start guided tour so its overlay never covers the UI.
        ctx.add_init_script("try{localStorage.setItem('archon_tour_done','1')}catch(e){}")
        page = ctx.new_page()
        page.set_default_timeout(60000)

        # Seed the demo data (idempotent) so the template company/question is
        # guaranteed answerable, then load the Explorer so it reflects the count.
        r = ctx.request.post(f"{BASE}/demo/seed", data="{}",
                             headers={"content-type": "application/json"})
        if not r.ok:
            fail(f"/demo/seed failed: HTTP {r.status}")

        page.goto(f"{BASE}/", wait_until="networkidle")

        # The live "memories N" badge must resolve to a real number (proves the
        # store is real, not a mock) — this is the count shown in every frame.
        page.wait_for_function(
            "() => { const n = document.getElementById('countN');"
            " return n && /^[0-9]+$/.test((n.textContent || '').trim()); }"
        )
        count = (page.eval_on_selector("#countN", "e => (e.textContent || '').trim()") or "")
        if not count.isdigit() or int(count) < 1:
            fail(f"live memory count badge is not a real number: {count!r}")
        print(f"live memory count badge: {count}")

        # Type the company + question (exactly what a user does in the Explorer).
        page.fill("#company", COMPANY)
        page.fill("#question", QUESTION)
        page.wait_for_timeout(250)
        page.screenshot(path=str(OUT / "1_home.png"))  # header (memories N) + typed query

        # Recall -> WAIT for a grounded answer with >= 1 citation (no fixed sleep).
        page.click("#askBtn")
        page.wait_for_selector("#result .answer", timeout=60000)
        page.wait_for_selector("#result .cite", timeout=60000)

        answer = (page.eval_on_selector("#result .answer", "e => e.innerText") or "").strip()
        if not answer or "(no answer)" in answer:
            fail(f"recall returned no grounded answer: {answer!r}")
        cites = page.eval_on_selector_all("#result .cite", "els => els.map(e => e.innerText)")
        if not cites:
            fail("recall returned an answer with no citations — refusing to ship an ungrounded scene")
        guard("web answer", answer)
        guard("web citations", "\n".join(cites))
        print("ANSWER:", " ".join(answer.split())[:300])
        print(f"citations: {len(cites)}")

        # Bring the cited answer to the top of the viewport and snapshot the hero frame.
        page.eval_on_selector("#result .answer", "e => e.scrollIntoView({block: 'start'})")
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "2_answer.png"))

        # Open the "memories N" browse view (loads a fuller slice) -> WAIT for real
        # memory rows, then bring the records panel deterministically into view. The
        # UI's own smooth scroll is animated/interruptible, so we do an explicit
        # instant scroll instead of relying on it.
        page.click("#count")
        page.wait_for_selector(".rec-row", timeout=30000)
        page.wait_for_function("() => document.querySelectorAll('.rec-row').length >= 6")
        page.eval_on_selector("#recordsPanel", "e => e.scrollIntoView({block: 'start', behavior: 'instant'})")
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "3_browse.png"))
        rows = page.eval_on_selector_all(".rec-row", "els => els.map(e => e.innerText)")
        if not rows:
            fail("browse view rendered no memory rows")
        guard("browse memory rows", "\n".join(rows))
        print(f"browse rows: {len(rows)}")

        ctx.close()
        browser.close()

    for f in ("1_home.png", "2_answer.png", "3_browse.png"):
        pth = OUT / f
        if not pth.exists() or pth.stat().st_size < 5000:
            fail(f"screenshot missing or too small: {f}")
    print("web_shots OK")


if __name__ == "__main__":
    main()
