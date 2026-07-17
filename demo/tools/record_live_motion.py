#!/usr/bin/env python3
"""Record genuine, secret-free MemoryAgent browser interaction footage.

Production mode is fail-closed: it requires the passed final CAPTURE_REVIEW for the
same exact deployed SHA and pinned public origin.  The recorder never reads or uses
a reviewer credential.  It exercises only the idempotent public demo seed plus
public recall/browse UI, writes raw footage exclusively under ignored .artifacts,
and emits a hash-bound manifest consumed by compose_real_motion_video.py.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Page, Route, sync_playwright

import compose_real_motion_video as video_qa


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_URL = "https://memory.43.106.13.19.sslip.io"
DEFAULT_VIDEO = ".artifacts/final-video/memoryagent-live-interaction.webm"
DEFAULT_MANIFEST = ".artifacts/final-video/memoryagent-live-interaction.manifest.json"
DEFAULT_POSTER = ".artifacts/final-video/memoryagent-live-interaction-poster.png"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
FORBIDDEN_POSITIONING = re.compile(r"hidden|ika|efka|mydata|greek|greece|αφμ|aade", re.IGNORECASE)
CAPTURE_QUESTION_SOURCE = ROOT / "scripts" / "capture_submission_gallery.py"
CAPTURE_QUESTION_DECLARATION = re.compile(
    r"CANONICAL_RECALL_QUESTION\s*=\s*\(\s*"
    r"((?:\"(?:\\.|[^\"\\])*\"\s*)+)\)",
    re.MULTILINE,
)
EXPECTED_CAPTURE_QUESTION = (
    "Using only the retrieved memory, return exactly one sentence that states the true employer cost "
    "for Northwind Trading in 2026-05 and includes citation marker [1]. Mention no other amounts, "
    "ratios, employee counts, or calculations."
)


class CaptureError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CaptureError(message)


def project_path(value: str | Path, label: str, *, exists: bool = False) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    resolved = path.resolve(strict=exists)
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise CaptureError(f"{label} must stay inside this repository") from exc
    if exists:
        require(resolved.is_file(), f"{label} must be a regular file")
        require(not resolved.is_symlink(), f"{label} must not be a symlink")
        require(resolved.stat().st_nlink == 1, f"{label} must have exactly one hard link")
    return resolved


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CaptureError(f"{label} is not valid UTF-8 JSON") from exc
    require(isinstance(payload, dict), f"{label} must be a JSON object")
    return payload


def validate_origin(raw: str) -> str:
    parsed = urlparse(raw)
    require(raw == DEFAULT_URL, f"live origin must equal pinned {DEFAULT_URL}")
    require(parsed.scheme == "https" and parsed.netloc == "memory.43.106.13.19.sslip.io", "invalid live origin")
    require(parsed.path == "" and not parsed.params and not parsed.query and not parsed.fragment, "live origin must have no path/query/fragment")
    return raw


def production_evidence(path: Path, expected_sha: str, base_url: str) -> dict[str, Any]:
    payload = read_json(path, "CAPTURE_REVIEW")
    require(payload.get("status") == "passed", "CAPTURE_REVIEW status is not passed")
    require(payload.get("exactRuntimeSource") == expected_sha, "CAPTURE_REVIEW exact runtime SHA mismatch")
    require(payload.get("liveBaseUrl") == base_url, "CAPTURE_REVIEW public origin mismatch")
    gates = payload.get("gates")
    require(isinstance(gates, dict) and gates.get("reviewerCredentialRendered") is False,
            "CAPTURE_REVIEW does not prove that reviewer credentials stayed out of media")
    return payload


def reviewed_capture_question() -> tuple[str, str]:
    """Read the tracked capture-question source without importing it or making live calls."""
    source = project_path(CAPTURE_QUESTION_SOURCE, "capture question source", exists=True)
    current_bytes = source.read_bytes()
    head = subprocess.run(
        ["git", "-C", str(ROOT), "show", "HEAD:scripts/capture_submission_gallery.py"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    require(head.returncode == 0, "cannot read capture question source from final source HEAD")
    require(head.stdout == current_bytes, "capture_submission_gallery.py differs from final source HEAD")
    text = current_bytes.decode("utf-8")
    match = CAPTURE_QUESTION_DECLARATION.search(text)
    require(match is not None, "CANONICAL_RECALL_QUESTION declaration is missing or non-canonical")
    literals = re.findall(r'\"(?:\\.|[^\"\\])*\"', match.group(1))
    require(literals, "CANONICAL_RECALL_QUESTION contains no quoted text")
    try:
        question = "".join(json.loads(literal) for literal in literals)
    except json.JSONDecodeError as exc:
        raise CaptureError("CANONICAL_RECALL_QUESTION contains an invalid string literal") from exc
    require(
        question == EXPECTED_CAPTURE_QUESTION,
        "capture question is not the reviewed one-sentence citation-explicit question",
    )
    return question, hashlib.sha256(current_bytes).hexdigest()


def add_recording_overlay(page: Page) -> None:
    page.evaluate("""
        () => {
          const badge = document.createElement('div');
          badge.id = 'archon-capture-live-badge';
          badge.textContent = 'LIVE HTTPS · PUBLIC UI';
          badge.style.cssText = 'position:fixed;right:28px;top:24px;z-index:2147483646;'
            + 'background:#06110dee;color:#86efac;border:1px solid #34d399;border-radius:999px;'
            + 'padding:10px 16px;font:700 18px system-ui;letter-spacing:.05em;pointer-events:none;';
          const cursor = document.createElement('div');
          cursor.id = 'archon-capture-cursor';
          cursor.style.cssText = 'position:fixed;left:-30px;top:-30px;width:22px;height:22px;'
            + 'z-index:2147483647;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 4px #10b981aa;'
            + 'pointer-events:none;transform:translate(-50%,-50%);';
          document.documentElement.append(badge, cursor);
          addEventListener('mousemove', event => {
            cursor.style.left = event.clientX + 'px'; cursor.style.top = event.clientY + 'px';
          }, {passive:true});
          addEventListener('mousedown', () => { cursor.style.background = '#34d399'; });
          addEventListener('mouseup', () => { cursor.style.background = 'transparent'; });
        }
    """)


def guard_text(label: str, text: str) -> None:
    require(FORBIDDEN_POSITIONING.search(text or "") is None,
            f"{label} contains a forbidden positioning term")


def network_guard(base_url: str):
    origin = urlparse(base_url)

    def handle(route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.scheme in ("http", "https") and (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc):
            route.abort()
        else:
            route.continue_()

    return handle


def record_live(
    context: BrowserContext,
    page: Page,
    base_url: str,
    poster: Path,
    primary_question: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    started = time.monotonic()
    actions: list[dict[str, Any]] = []

    def mark(action: str) -> None:
        actions.append({"atSeconds": round(time.monotonic() - started, 3), "action": action})

    response = context.request.post(f"{base_url}/demo/seed", data="{}", headers={"content-type": "application/json"})
    require(response.ok, f"idempotent public demo seed failed with HTTP {response.status}")
    page.goto(f"{base_url}/", wait_until="networkidle", timeout=90_000)
    require(urlparse(page.url).scheme + "://" + urlparse(page.url).netloc == base_url, "navigation left pinned origin")
    add_recording_overlay(page)
    page.locator("#countN").wait_for(state="visible", timeout=60_000)
    page.wait_for_function("() => /^[0-9]+$/.test((document.querySelector('#countN')?.textContent || '').trim())")
    count = page.locator("#countN").inner_text().strip()
    require(count.isdigit() and int(count) >= 1, "live memory badge did not resolve to a real positive count")
    token = page.locator("#judgeToken")
    require(token.count() == 1 and token.input_value() == "", "reviewer token field is not blank")
    mark("loaded live public Explorer with a real memory count")
    page.wait_for_timeout(900)

    company = page.locator("#company")
    question = page.locator("#question")
    company.fill("")
    company.press_sequentially("Northwind Trading", delay=45)
    mark("typed the public company filter")
    question.fill("")
    question.press_sequentially(primary_question, delay=15)
    require(question.input_value() == primary_question, "typed question does not byte-match the tracked canonical question")
    mark("typed a natural-language recall question")
    page.wait_for_timeout(500)
    with page.expect_response(
        lambda response: response.request.method == "POST" and response.url == f"{base_url}/recall",
        timeout=120_000,
    ) as recall_response_info:
        page.locator("#askBtn").click()
    recall_response = recall_response_info.value
    mark("clicked Recall")
    require(recall_response.ok, f"live recall failed with HTTP {recall_response.status}")
    try:
        request_payload = recall_response.request.post_data_json
        recall_payload = recall_response.json()
    except Exception as exc:
        raise CaptureError("live recall request/response was not valid JSON") from exc
    require(isinstance(request_payload, dict), "live recall request body is not a JSON object")
    require(request_payload.get("question") == primary_question, "live recall request changed the canonical question")
    require(request_payload.get("company") == "Northwind Trading", "live recall request lost the canonical company scope")
    require(request_payload.get("limit") == 3, "live recall request did not use the reviewed limit=3 contract")
    require(isinstance(recall_payload, dict), "live recall response is not a JSON object")
    require(recall_payload.get("modelId") == "qwen-plus", "live recall response did not use qwen-plus")
    grounding = recall_payload.get("grounding")
    require(isinstance(grounding, dict), "live recall response did not report grounding evidence")
    grounding_pair = (grounding.get("status"), grounding.get("attempts"))
    require(grounding_pair in (("passed", 1), ("repaired", 2)),
            f"live recall reported invalid grounding pair {grounding_pair!r}")
    response_citations = recall_payload.get("citations")
    require(isinstance(response_citations, list) and 1 <= len(response_citations) <= 3,
            "live recall response did not return 1-3 citations")
    require("[1]" in str(recall_payload.get("answer") or ""), "live recall answer omitted required citation marker [1]")
    page.locator("#result .answer").wait_for(state="visible", timeout=90_000)
    page.locator("#result .cite").first.wait_for(state="visible", timeout=60_000)
    answer = page.locator("#result .answer").inner_text().strip()
    citations = page.locator("#result .cite").all_inner_texts()
    require(answer and "(no answer)" not in answer and citations, "live recall was not grounded and cited")
    require(len(citations) == len(response_citations), "visible citation count differs from the live recall payload")
    guard_text("answer", answer)
    guard_text("citations", "\n".join(citations))
    page.locator("#result .answer").scroll_into_view_if_needed()
    mark("waited for the grounded qwen-plus answer and visible citations")
    page.wait_for_timeout(1600)
    poster.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(poster), full_page=False)

    page.locator("#count").click()
    mark("opened Browse memories")
    page.locator(".rec-row").first.wait_for(state="visible", timeout=45_000)
    page.wait_for_function("() => document.querySelectorAll('.rec-row').length >= 6")
    rows = page.locator(".rec-row").all_inner_texts()
    require(rows, "Browse memories rendered no rows")
    guard_text("browse rows", "\n".join(rows))
    page.locator("#recordsPanel").scroll_into_view_if_needed()
    mark("revealed real stored memory rows")
    page.wait_for_timeout(1900)
    require(token.input_value() == "", "reviewer token field changed during recording")
    return actions, {
        "question": primary_question,
        "company": "Northwind Trading",
        "requestLimit": 3,
        "modelId": "qwen-plus",
        "grounding": {"status": grounding_pair[0], "attempts": grounding_pair[1]},
        "citationCount": len(response_citations),
        "answerSha256": hashlib.sha256(answer.encode("utf-8")).hexdigest(),
    }


def record_fixture(page: Page, poster: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    page.set_content("""
      <!doctype html><html><style>
      body{margin:0;background:#071b16;color:#eefbf5;font:28px system-ui}main{padding:90px 150px}
      input,button{font:28px system-ui;padding:18px;margin:12px 0;width:80%}button{width:auto;background:#10b981;color:#04100c}
      #answer{margin-top:36px;padding:28px;border:2px solid #34d399;opacity:0;transition:opacity .8s}
      .row{margin:12px 0;padding:14px;background:#102820;transform:translateX(-30px);opacity:0;transition:.45s}
      .shown{opacity:1!important;transform:none!important}</style><main>
      <h1>SELF-TEST · NOT SUBMISSION EVIDENCE</h1><input id=company><input id=question>
      <button id=recall>Recall</button><section id=answer>Grounded answer <b>[1]</b></section>
      <div id=rows><div class=row>memory 1</div><div class=row>memory 2</div><div class=row>memory 3</div></div>
      <script>recall.onclick=()=>{answer.classList.add('shown');[...document.querySelectorAll('.row')].forEach((r,i)=>setTimeout(()=>r.classList.add('shown'),500+i*350))}</script>
      </main></html>
    """)
    add_recording_overlay(page)
    started = time.monotonic()
    actions = []
    page.locator("#company").press_sequentially("Northwind Trading", delay=35)
    actions.append({"atSeconds": round(time.monotonic() - started, 3), "action": "fixture typed company"})
    page.locator("#question").press_sequentially("What changed?", delay=45)
    page.locator("#recall").click()
    actions.append({"atSeconds": round(time.monotonic() - started, 3), "action": "fixture clicked recall"})
    page.locator("#answer.shown").wait_for(state="visible")
    page.wait_for_timeout(2300)
    page.screenshot(path=str(poster))
    return actions, {"fixture": True}


def capture(
    *, expected_sha: str, evidence_path: Path, base_url: str, output: Path,
    manifest_path: Path, poster: Path, replace: bool, fixture: bool,
) -> dict[str, Any]:
    require(SHA_RE.fullmatch(expected_sha) is not None, "expected SHA must be 40 lowercase hex characters")
    canonical_question = ""
    canonical_source_sha = ""
    if fixture:
        evidence = read_json(evidence_path, "fixture evidence")
        require(evidence.get("exactRuntimeSource") == expected_sha, "fixture evidence SHA mismatch")
    else:
        evidence = production_evidence(evidence_path, expected_sha, base_url)
        canonical_question, canonical_source_sha = reviewed_capture_question()
        require(relative(output).startswith(".artifacts/final-video/"), "raw live footage must stay under .artifacts/final-video")
    for target, label in ((output, "output"), (manifest_path, "manifest"), (poster, "poster")):
        require(replace or not target.exists(), f"refusing to replace existing {relative(target)} without --replace")
        target.parent.mkdir(parents=True, exist_ok=True)

    run_root = project_path(".artifacts/final-video/recording-runtime", "recording runtime")
    if run_root.exists():
        shutil.rmtree(run_root)
    run_root.mkdir(parents=True)
    started_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    raw_video: Path | None = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            screen={"width": 1920, "height": 1080},
            ignore_https_errors=False,
            record_video_dir=str(run_root),
            record_video_size={"width": 1920, "height": 1080},
        )
        if not fixture:
            context.add_init_script("try{localStorage.setItem('archon_tour_done','1')}catch(e){}")
            context.route("**/*", network_guard(base_url))
        page = context.new_page()
        page.set_default_timeout(90_000)
        actions, recall_proof = (
            record_fixture(page, poster)
            if fixture
            else record_live(context, page, base_url, poster, canonical_question)
        )
        video_handle = page.video
        page.close()
        context.close()
        require(video_handle is not None, "Playwright did not create a video handle")
        raw_video = Path(video_handle.path())
        browser.close()
    require(raw_video is not None and raw_video.is_file() and raw_video.stat().st_size > 10_000,
            "browser recording is missing or empty")
    shutil.copyfile(raw_video, output)

    media = video_qa.media_summary(output)
    require(media["width"] == 1920 and media["height"] == 1080, "browser recording is not 1920x1080")
    require(media["audioStreamCount"] == 0, "browser recording unexpectedly contains audio")
    motion = video_qa.diversity(output, duration=min(float(media["durationSeconds"]), 30.0))
    require(motion["uniqueFrames"] >= 8 and motion["uniqueRatio"] >= 0.25,
            "browser recording is too static to count as genuine interaction footage")
    finished_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    manifest = {
        "schemaVersion": 1,
        "status": "passed",
        "mode": "fixture" if fixture else "live",
        "submissionEligible": not fixture,
        "expectedRuntimeSha": expected_sha,
        "publicUrl": base_url,
        "capturedAt": started_at.isoformat().replace("+00:00", "Z"),
        "finishedAt": finished_at.isoformat().replace("+00:00", "Z"),
        "evidenceManifestPath": relative(evidence_path),
        "evidenceManifestSha256": sha256_file(evidence_path),
        "reviewerCredentialUsed": False,
        "reviewerCredentialRendered": False,
        "durableReviewerWritesCreated": False,
        "publicSeed": "idempotent canonical demo seed" if not fixture else "fixture only",
        "canonicalQuestionSource": None if fixture else {
            "path": "scripts/capture_submission_gallery.py",
            "sha256": canonical_source_sha,
            "question": canonical_question,
        },
        "recallProof": recall_proof,
        "actions": actions,
        "rawVideo": {"path": relative(output), "sha256": sha256_file(output), "bytes": output.stat().st_size, **media},
        "frameDiversity": motion,
        "poster": {"path": relative(poster), "sha256": sha256_file(poster), "bytes": poster.stat().st_size},
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    shutil.rmtree(run_root, ignore_errors=True)
    return manifest


def self_test() -> int:
    root = project_path(".artifacts/final-video/memory-recorder-selftest", "self-test root")
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    sha = "1" * 40
    evidence = root / "CAPTURE_REVIEW.json"
    evidence.write_text(json.dumps({"status": "passed", "exactRuntimeSource": sha}) + "\n", encoding="utf-8")
    capture(expected_sha=sha, evidence_path=evidence, base_url=DEFAULT_URL,
            output=root / "fixture.webm", manifest_path=root / "fixture.manifest.json",
            poster=root / "fixture-poster.png", replace=False, fixture=True)
    print("MemoryAgent live recorder self-test: PASS · real browser video · 1920x1080 · no audio · frame diversity")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--expected-sha")
    parser.add_argument("--capture-review", default="demo/gallery/CAPTURE_REVIEW.json")
    parser.add_argument("--base-url", default=DEFAULT_URL)
    parser.add_argument("--output", default=DEFAULT_VIDEO)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--poster", default=DEFAULT_POSTER)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            return self_test()
        require(args.expected_sha is not None, "--expected-sha is required")
        base_url = validate_origin(str(args.base_url))
        manifest = capture(
            expected_sha=str(args.expected_sha),
            evidence_path=project_path(args.capture_review, "CAPTURE_REVIEW", exists=True),
            base_url=base_url,
            output=project_path(args.output, "output"),
            manifest_path=project_path(args.manifest, "manifest"),
            poster=project_path(args.poster, "poster"),
            replace=args.replace,
            fixture=False,
        )
        print(f"MemoryAgent live recorder: PASS · {manifest['rawVideo']['durationSeconds']:.3f}s · {manifest['rawVideo']['sha256'][:12]} · no reviewer credential")
        return 0
    except (CaptureError, video_qa.GateError, OSError, UnicodeError, ValueError) as exc:
        print(f"MemoryAgent live recorder: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
