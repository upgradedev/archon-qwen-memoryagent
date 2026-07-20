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
from contextlib import contextmanager
import datetime as dt
from dataclasses import dataclass
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterator, Sequence
from urllib.parse import urlparse
import uuid

from playwright.sync_api import BrowserContext, Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "demo" / "tools"))
sys.path.insert(0, str(ROOT / "scripts"))

import compose_real_motion_video as video_qa  # noqa: E402
from repo_paths import read_project_file_once  # noqa: E402


DEFAULT_URL = "https://memory.43.106.13.19.sslip.io"
DEFAULT_VIDEO = ".artifacts/final-video/memoryagent-live-interaction.webm"
DEFAULT_MANIFEST = ".artifacts/final-video/memoryagent-live-interaction.manifest.json"
DEFAULT_POSTER = ".artifacts/final-video/memoryagent-live-interaction-poster.png"
CANONICAL_CAPTURE_REVIEW = "demo/gallery/CAPTURE_REVIEW.json"
PRIVATE_OUTPUT_ROOT = ".artifacts/final-video"
RECORDING_RUNTIME_ROOT = ".artifacts/final-video/recording-runtime"
TRUSTED_GIT_ENV = "MEMORYAGENT_GIT_EXECUTABLE"
PRODUCTION_BROWSER_MODE = "production-live-capture"
FIXTURE_SELF_TEST_BROWSER_MODE = "offline-fixture-self-test-non-production"
PRODUCTION_CHROMIUM_ARGS: tuple[str, ...] = ()
FIXTURE_SELF_TEST_CHROMIUM_ARGS = ("--no-sandbox",)
SANDBOX_DISABLING_CHROMIUM_FLAGS = frozenset({
    "--no-sandbox",
    "--disable-sandbox",
    "--disable-setuid-sandbox",
    "--disable-seccomp-sandbox",
    "--disable-seccomp-filter-sandbox",
    "--disable-namespace-sandbox",
    "--disable-gpu-sandbox",
})
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
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


@dataclass(frozen=True)
class TrustedExecutable:
    """One absolute executable pinned to a stable filesystem/content identity."""

    path: Path
    sha256: str
    size: int
    device: int
    inode: int
    mode_type: int
    mtime_ns: int
    ctime_ns: int

    def assert_unchanged(self) -> None:
        current = _snapshot_trusted_executable(self.path)
        require(
            current == self,
            "trusted Git executable changed identity or bytes after resolution",
        )


@dataclass(frozen=True)
class OwnedPath:
    """Filesystem identity owned by this promotion transaction."""

    path: Path
    device: int
    inode: int
    mode_type: int

    @classmethod
    def capture(cls, path: Path, label: str) -> "OwnedPath":
        try:
            metadata = path.lstat()
        except OSError as exc:
            raise CaptureError(f"{label} disappeared while its identity was captured") from exc
        require(
            stat.S_ISREG(metadata.st_mode) and not _is_symlink_or_reparse(metadata),
            f"{label} must be a non-reparse regular file",
        )
        return cls(path, metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode))

    def still_owned(self) -> bool:
        try:
            metadata = self.path.lstat()
        except FileNotFoundError:
            return False
        except OSError:
            return False
        return (
            metadata.st_dev,
            metadata.st_ino,
            stat.S_IFMT(metadata.st_mode),
        ) == (self.device, self.inode, self.mode_type)

    def same_identity(self, other: "OwnedPath") -> bool:
        return (
            self.device,
            self.inode,
            self.mode_type,
        ) == (
            other.device,
            other.inode,
            other.mode_type,
        )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CaptureError(message)


def _is_symlink_or_reparse(metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(reparse_flag and attributes & reparse_flag)


def _same_file_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev,
        left.st_ino,
        stat.S_IFMT(left.st_mode),
    ) == (
        right.st_dev,
        right.st_ino,
        stat.S_IFMT(right.st_mode),
    )


def _reject_absolute_reparse_components(path: Path, label: str) -> None:
    """Reject aliases from the filesystem root through one existing absolute path."""

    require(path.is_absolute(), f"{label} must be absolute")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except OSError as exc:
            raise CaptureError(f"{label} has an unreadable path component") from exc
        require(
            not _is_symlink_or_reparse(metadata),
            f"{label} must not traverse a symlink or reparse point",
        )


def _snapshot_trusted_executable(path: Path) -> TrustedExecutable:
    """Hash Git through a verified descriptor and bind its filesystem identity."""

    try:
        before_path = path.lstat()
    except OSError as exc:
        raise CaptureError("trusted Git executable is unavailable") from exc
    require(
        stat.S_ISREG(before_path.st_mode) and not _is_symlink_or_reparse(before_path),
        "trusted Git executable must be a non-reparse regular file",
    )
    require(os.access(path, os.X_OK), "trusted Git executable is not executable")
    descriptor = -1
    try:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        before_fd = os.fstat(descriptor)
        require(
            stat.S_ISREG(before_fd.st_mode) and _same_file_identity(before_path, before_fd),
            "trusted Git executable changed before it could be read",
        )
        digest = hashlib.sha256()
        size = 0
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
            size += len(block)
        after_fd = os.fstat(descriptor)
    except OSError as exc:
        raise CaptureError("trusted Git executable could not be read safely") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    try:
        after_path = path.lstat()
    except OSError as exc:
        raise CaptureError("trusted Git executable disappeared while it was read") from exc
    require(
        _same_file_identity(before_path, before_fd)
        and _same_file_identity(before_fd, after_fd)
        and _same_file_identity(after_fd, after_path)
        and before_fd.st_size == after_fd.st_size == after_path.st_size == size
        and before_fd.st_mtime_ns == after_fd.st_mtime_ns == after_path.st_mtime_ns
        and before_fd.st_ctime_ns == after_fd.st_ctime_ns == after_path.st_ctime_ns,
        "trusted Git executable changed while it was read",
    )
    return TrustedExecutable(
        path=path,
        sha256=digest.hexdigest(),
        size=size,
        device=after_fd.st_dev,
        inode=after_fd.st_ino,
        mode_type=stat.S_IFMT(after_fd.st_mode),
        mtime_ns=after_fd.st_mtime_ns,
        ctime_ns=after_fd.st_ctime_ns,
    )


def trusted_git() -> TrustedExecutable:
    """Resolve Git only from an explicit absolute trust configuration, never PATH."""

    configured = os.environ.get(TRUSTED_GIT_ENV)
    require(
        isinstance(configured, str) and bool(configured) and configured == configured.strip(),
        f"production capture requires {TRUSTED_GIT_ENV} as an exact absolute Git executable path",
    )
    candidate = Path(configured)
    require(candidate.is_absolute(), f"{TRUSTED_GIT_ENV} must be an absolute path")
    lexical = Path(os.path.abspath(candidate))
    try:
        resolved = lexical.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise CaptureError("trusted Git executable could not be resolved") from exc
    require(
        os.path.normcase(os.path.normpath(str(resolved)))
        == os.path.normcase(os.path.normpath(str(lexical))),
        "trusted Git executable must not resolve through an alias or reparse point",
    )
    require(resolved.name.lower() in {"git", "git.exe"}, "trusted Git executable name is not canonical")
    _reject_absolute_reparse_components(resolved, "trusted Git executable")
    repository_root = ROOT.resolve(strict=True)
    try:
        resolved.relative_to(repository_root)
    except ValueError:
        pass
    else:
        raise CaptureError("trusted Git executable must stay outside this repository")
    try:
        current_directory = Path.cwd().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise CaptureError("current directory could not be resolved for Git trust") from exc
    require(
        resolved.parent != current_directory,
        "trusted Git executable must not be selected from the current directory",
    )
    return _snapshot_trusted_executable(resolved)


def _run_git(arguments: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    executable = trusted_git()
    executable.assert_unchanged()
    try:
        return subprocess.run(
            [str(executable.path), *arguments],
            check=False,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
        )
    finally:
        executable.assert_unchanged()


def _reject_reparse_components(path: Path, label: str) -> None:
    root = ROOT.resolve(strict=True)
    try:
        relative_path = path.relative_to(root)
    except ValueError as exc:
        raise CaptureError(f"{label} must stay inside this repository") from exc
    current = root
    for part in relative_path.parts:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            break
        except OSError as exc:
            raise CaptureError(f"{label} has an unreadable path component") from exc
        require(not _is_symlink_or_reparse(metadata),
                f"{label} must not traverse a symlink or reparse point")


def project_path(value: str | Path, label: str, *, exists: bool = False) -> Path:
    raw_text = str(value).strip()
    require(bool(raw_text), f"{label} must be a non-empty repository path")
    raw = Path(raw_text)
    require(".." not in raw.parts, f"{label} must not contain parent traversal")
    for part in raw.parts:
        if part == raw.anchor:
            continue
        require(":" not in part and not part.endswith((" ", ".")),
                f"{label} contains a non-canonical Windows path component")
        require(part.split(".", 1)[0].upper() not in WINDOWS_RESERVED_NAMES,
                f"{label} contains a reserved Windows device name")
    candidate = raw if raw.is_absolute() else ROOT / raw
    lexical = Path(os.path.abspath(candidate))
    root = ROOT.resolve(strict=True)
    try:
        relative_path = lexical.relative_to(root)
    except ValueError as exc:
        raise CaptureError(f"{label} must stay inside this repository") from exc
    for part in relative_path.parts:
        require(":" not in part and not part.endswith((" ", ".")),
                f"{label} contains a non-canonical Windows path component")
        require(part.split(".", 1)[0].upper() not in WINDOWS_RESERVED_NAMES,
                f"{label} contains a reserved Windows device name")
    _reject_reparse_components(lexical, label)
    try:
        metadata = lexical.lstat()
    except FileNotFoundError:
        require(not exists, f"{label} must exist inside this repository")
    except OSError as exc:
        raise CaptureError(f"{label} could not be inspected safely") from exc
    else:
        require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
        require(metadata.st_nlink == 1, f"{label} must have exactly one hard link")
    return lexical


def relative(path: Path) -> str:
    return Path(os.path.abspath(path)).relative_to(ROOT.resolve(strict=True)).as_posix()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json_bytes(data: bytes, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise CaptureError(f"{label} is not valid UTF-8 JSON") from exc
    require(isinstance(payload, dict), f"{label} must be a JSON object")
    return payload


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        snapshot = read_project_file_once(path, label)
    except ValueError as exc:
        raise CaptureError(str(exc)) from exc
    return read_json_bytes(snapshot.data, label)


def validate_origin(raw: str) -> str:
    parsed = urlparse(raw)
    require(raw == DEFAULT_URL, f"live origin must equal pinned {DEFAULT_URL}")
    require(parsed.scheme == "https" and parsed.netloc == "memory.43.106.13.19.sslip.io", "invalid live origin")
    require(parsed.path == "" and not parsed.params and not parsed.query and not parsed.fragment, "live origin must have no path/query/fragment")
    return raw


def production_evidence(payload: dict[str, Any], expected_sha: str, base_url: str) -> dict[str, Any]:
    require(payload.get("schemaVersion") == 3, "CAPTURE_REVIEW schema is not canonical v3")
    require(payload.get("status") == "passed", "CAPTURE_REVIEW status is not passed")
    require(payload.get("exactRuntimeSource") == expected_sha, "CAPTURE_REVIEW exact runtime SHA mismatch")
    require(payload.get("liveBaseUrl") == base_url, "CAPTURE_REVIEW public origin mismatch")
    gates = payload.get("gates")
    require(isinstance(gates, dict) and gates.get("reviewerCredentialRendered") is False,
            "CAPTURE_REVIEW does not prove that reviewer credentials stayed out of media")
    require(gates.get("exactDeploymentEvidence") is True,
            "CAPTURE_REVIEW does not bind exact deployment evidence")
    deployment = payload.get("deploymentEvidence")
    require(isinstance(deployment, dict), "CAPTURE_REVIEW has no exact deployment evidence record")
    evidence_mode = deployment.get("mode")
    require(
        evidence_mode in {"strict-final-marker", "terminal-success-truncated-output"}
        and gates.get("exactDeploymentEvidenceMode") == evidence_mode,
        "CAPTURE_REVIEW exact deployment evidence mode is inconsistent",
    )
    return payload


def normalize_git_output(data: bytes) -> bytes:
    """Normalize Git/working-tree text for CRLF-safe committed-source comparison."""
    return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def reviewed_capture_question() -> tuple[str, str]:
    """Read the tracked capture-question source without importing it or making live calls."""
    try:
        source = read_project_file_once(CAPTURE_QUESTION_SOURCE, "capture question source")
    except ValueError as exc:
        raise CaptureError(str(exc)) from exc
    current_bytes = source.data
    head = _run_git(
        ["-C", str(ROOT), "show", "HEAD:scripts/capture_submission_gallery.py"],
    )
    require(head.returncode == 0, "cannot read capture question source from final source HEAD")
    require(
        normalize_git_output(head.stdout) == normalize_git_output(current_bytes),
        "capture_submission_gallery.py differs from final source HEAD",
    )
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
    return question, source.sha256


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


def validate_recall_proof(proof: dict[str, Any], canonical_question: str, *, fixture: bool) -> None:
    if fixture:
        require(proof == {"fixture": True}, "fixture recall proof is not canonical")
        return
    require(
        set(proof) == {
            "question", "company", "requestLimit", "modelId", "grounding",
            "citationCount", "answerSha256",
        },
        "live recall proof fields are incomplete or non-canonical",
    )
    require(proof.get("question") == canonical_question, "live recall proof question mismatch")
    require(proof.get("company") == "Northwind Trading", "live recall proof company mismatch")
    require(type(proof.get("requestLimit")) is int and proof["requestLimit"] == 3,
            "live recall proof request limit is not exactly 3")
    require(proof.get("modelId") == "qwen-plus", "live recall proof model is not qwen-plus")
    grounding = proof.get("grounding")
    require(
        grounding in ({"status": "passed", "attempts": 1}, {"status": "repaired", "attempts": 2}),
        "live recall proof grounding record is invalid",
    )
    citation_count = proof.get("citationCount")
    require(type(citation_count) is int and 1 <= citation_count <= 3,
            "live recall proof citation count is not an integer from 1 to 3")
    require(isinstance(proof.get("answerSha256"), str)
            and SHA256_RE.fullmatch(proof["answerSha256"]) is not None,
            "live recall proof answer hash is not 64 lowercase hex characters")


def network_guard(base_url: str):
    origin = urlparse(base_url)

    def handle(route: Route) -> None:
        request = route.request
        parsed = urlparse(request.url)
        allowed_origin = (
            parsed.scheme in ("http", "https")
            and (parsed.scheme, parsed.netloc) == (origin.scheme, origin.netloc)
        )
        if not allowed_origin or request.redirected_from is not None:
            route.abort()
        else:
            route.continue_()

    return handle


def block_websocket(websocket: Any) -> None:
    websocket.close(code=1008, reason="network destination not permitted")


def chromium_launch_options(mode: str) -> dict[str, Any]:
    """Keep every sandbox bypass confined to the labelled offline fixture."""

    require(
        mode in {PRODUCTION_BROWSER_MODE, FIXTURE_SELF_TEST_BROWSER_MODE},
        "Chromium launch mode is not canonical",
    )
    fixture_self_test = mode == FIXTURE_SELF_TEST_BROWSER_MODE
    arguments = list(
        FIXTURE_SELF_TEST_CHROMIUM_ARGS
        if fixture_self_test
        else PRODUCTION_CHROMIUM_ARGS
    )
    disabling = [
        argument
        for argument in arguments
        if argument.strip().lower().split("=", 1)[0] in SANDBOX_DISABLING_CHROMIUM_FLAGS
    ]
    require(
        fixture_self_test or not disabling,
        "production Chromium launch must not disable a browser sandbox",
    )
    return {
        "headless": True,
        "chromium_sandbox": not fixture_self_test,
        "args": arguments,
    }


def browser_context_options(run_root: Path) -> dict[str, Any]:
    return {
        "viewport": {"width": 1920, "height": 1080},
        "screen": {"width": 1920, "height": 1080},
        "ignore_https_errors": False,
        "service_workers": "block",
        "record_video_dir": str(run_root),
        "record_video_size": {"width": 1920, "height": 1080},
    }


def configure_live_context(context: BrowserContext, base_url: str) -> None:
    context.add_init_script("try{localStorage.setItem('archon_tour_done','1')}catch(e){}")
    context.route("**/*", network_guard(base_url))
    context.route_web_socket("**/*", block_websocket)


def seed_public_demo(context: BrowserContext, base_url: str) -> None:
    seed_url = f"{base_url}/demo/seed"
    response = context.request.post(
        seed_url,
        data="{}",
        headers={"content-type": "application/json"},
        max_redirects=0,
    )
    require(response.url == seed_url, "idempotent public demo seed response URL changed")
    require(response.ok, f"idempotent public demo seed failed with HTTP {response.status}")


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

    seed_public_demo(context, base_url)
    page_url = f"{base_url}/"
    navigation = page.goto(page_url, wait_until="networkidle", timeout=90_000)
    require(navigation is not None, "live page navigation returned no response")
    require(navigation.url == page_url, "live page response URL changed")
    require(navigation.request.redirected_from is None, "live page navigation was redirected")
    require(page.url == page_url, "navigation left the exact pinned page URL")
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


def paths_overlap(left: Path, right: Path) -> bool:
    """Return whether either canonical path is equal to or contains the other."""
    if left == right:
        return True
    try:
        left.relative_to(right)
        return True
    except ValueError:
        pass
    try:
        right.relative_to(left)
        return True
    except ValueError:
        return False


def validate_capture_paths(
    *, evidence_path: Path, output: Path, manifest_path: Path, poster: Path, fixture: bool,
) -> None:
    """Keep immutable sanitized evidence separate from every private recorder output."""
    outputs = ((output, "output", ".webm"), (manifest_path, "manifest", ".json"), (poster, "poster", ".png"))
    private_root = Path(os.path.abspath(ROOT / PRIVATE_OUTPUT_ROOT))
    runtime_root = Path(os.path.abspath(ROOT / RECORDING_RUNTIME_ROOT))

    for target, label, suffix in outputs:
        try:
            relative_private = target.relative_to(private_root)
        except ValueError as exc:
            raise CaptureError(f"{label} must stay under ignored {PRIVATE_OUTPUT_ROOT}/") from exc
        require(bool(relative_private.parts), f"{label} must name a file below ignored {PRIVATE_OUTPUT_ROOT}/")
        require(target.suffix.lower() == suffix, f"{label} must use the canonical {suffix} extension")
        require(not paths_overlap(target, runtime_root),
                f"{label} must not overlap the private recording runtime")

    all_paths = ((evidence_path, "CAPTURE_REVIEW"),) + tuple((path, label) for path, label, _suffix in outputs)
    for index, (left, left_label) in enumerate(all_paths):
        for right, right_label in all_paths[index + 1:]:
            require(
                not paths_overlap(left, right),
                f"{left_label} and {right_label} paths must be distinct and non-overlapping",
            )

    if not fixture:
        require(relative(evidence_path) == CANONICAL_CAPTURE_REVIEW,
                f"production CAPTURE_REVIEW must be the canonical sanitized {CANONICAL_CAPTURE_REVIEW}")
        require(not paths_overlap(CAPTURE_QUESTION_SOURCE, output)
                and not paths_overlap(CAPTURE_QUESTION_SOURCE, manifest_path)
                and not paths_overlap(CAPTURE_QUESTION_SOURCE, poster),
                "private recorder outputs must not overlap the canonical question source")


def _move_no_overwrite(source: Path, destination: Path) -> None:
    """Atomically move one path entry only when the destination is absent."""

    if os.name == "nt":
        # Windows rename is no-replace: it fails if destination already exists.
        os.rename(source, destination)
        return
    if sys.platform.startswith("linux"):
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2", None)
        require(renameat2 is not None, "atomic no-overwrite rename is unavailable")
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
        if result != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(destination))
        return
    if sys.platform == "darwin":
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        renamex_np = getattr(libc, "renamex_np", None)
        require(renamex_np is not None, "atomic no-overwrite rename is unavailable")
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        result = renamex_np(os.fsencode(source), os.fsencode(destination), 0x00000004)
        if result != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(destination))
        return
    raise CaptureError("atomic no-overwrite rename is unavailable on this platform")


def _move_to_unique_recovery(source: Path, kind: str) -> OwnedPath:
    """Move the current source entry to an unpredictable no-overwrite recovery path."""

    try:
        metadata = source.lstat()
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise CaptureError(f"recorder {kind} source could not be inspected") from exc
    require(
        stat.S_ISREG(metadata.st_mode) and not _is_symlink_or_reparse(metadata),
        f"recorder {kind} source must be a non-reparse regular file",
    )
    source_owner = OwnedPath(source, metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode))
    for _attempt in range(64):
        recovery = source.parent / f".{source.name}.{uuid.uuid4().hex}.{kind}"
        try:
            _move_no_overwrite(source, recovery)
        except FileExistsError:
            continue
        expected_recovery = OwnedPath(
            recovery,
            source_owner.device,
            source_owner.inode,
            source_owner.mode_type,
        )
        try:
            require(
                expected_recovery.still_owned(),
                f"recorder {kind} file changed identity during its no-overwrite move",
            )
        except BaseException as verification_exc:
            try:
                _move_no_overwrite(recovery, source)
            except (OSError, CaptureError) as restore_exc:
                raise CaptureError(
                    f"recorder {kind} identity verification failed; retained recovery file "
                    f"{relative(recovery)} because the source could not be restored: {restore_exc}"
                ) from verification_exc
            raise
        return expected_recovery
    raise CaptureError(f"could not reserve a unique recorder {kind} path")


def promote_recorder_bundle(
    staged_outputs: Sequence[tuple[Path, Path]], scratch: Path, *, replace: bool,
) -> None:
    """Promote with no-overwrite moves and preserve recovery bytes on every race."""

    sources = [source for source, _destination in staged_outputs]
    destinations = [destination for _source, destination in staged_outputs]
    require(len(staged_outputs) == 3, "recorder promotion requires video, poster, and manifest")
    require(len(set(sources)) == len(sources), "staged recorder outputs must be distinct")
    require(len(set(destinations)) == len(destinations), "recorder output destinations must be distinct")
    require(not set(sources).intersection(destinations), "staged recorder output must not alias a destination")
    require(destinations[-1].suffix.lower() == ".json",
            "recorder manifest must be the last promoted output")

    source_owners: dict[Path, OwnedPath] = {}
    for source, destination in staged_outputs:
        try:
            metadata = source.lstat()
        except OSError as exc:
            raise CaptureError(f"staged recorder output {relative(source)} is missing") from exc
        require(stat.S_ISREG(metadata.st_mode) and not _is_symlink_or_reparse(metadata),
                f"staged recorder output {relative(source)} must be a regular file")
        require(metadata.st_nlink == 1,
                f"staged recorder output {relative(source)} must have exactly one hard link")
        require(not paths_overlap(source, destination), "staged recorder output overlaps its destination")
        source_owners[source] = OwnedPath.capture(source, "staged recorder output")
        destination.parent.mkdir(parents=True, exist_ok=True)
        require(replace or not destination.exists(),
                f"refusing to replace existing {relative(destination)} without --replace")

    scratch.mkdir(parents=True, exist_ok=True)
    backups: dict[Path, OwnedPath] = {}
    promoted: dict[Path, OwnedPath] = {}
    committed = False
    try:
        if replace:
            for destination in destinations:
                try:
                    backups[destination] = _move_to_unique_recovery(destination, "rollback")
                except FileNotFoundError:
                    continue
        for source, destination in staged_outputs:
            _move_no_overwrite(source, destination)
            source_owner = source_owners[source]
            expected_owner = OwnedPath(
                destination,
                source_owner.device,
                source_owner.inode,
                source_owner.mode_type,
            )
            promoted[destination] = expected_owner
            require(
                expected_owner.still_owned(),
                f"promoted recorder output {relative(destination)} changed identity during promotion",
            )
        committed = True
    except BaseException as exc:
        rollback_errors: list[str] = []
        displaced: list[OwnedPath] = []
        for destination, expected_owner in reversed(tuple(promoted.items())):
            try:
                recovery = _move_to_unique_recovery(destination, "failed-promotion")
            except FileNotFoundError:
                continue
            except (OSError, CaptureError) as rollback_exc:
                rollback_errors.append(f"preserve {relative(destination)}: {rollback_exc}")
                continue
            if recovery.same_identity(expected_owner):
                displaced.append(recovery)
                continue
            # A concurrently appeared destination is never unlinked. Put it back
            # with no-overwrite semantics or retain it at the recovery path.
            try:
                _move_no_overwrite(recovery.path, destination)
            except (OSError, CaptureError) as rollback_exc:
                rollback_errors.append(
                    f"restore concurrently appeared {relative(destination)}: {rollback_exc}"
                )
                displaced.append(recovery)
            else:
                rollback_errors.append(
                    f"preserved concurrently appeared {relative(destination)} instead of deleting it"
                )
        for destination, backup in backups.items():
            if not backup.path.exists():
                continue
            try:
                _move_no_overwrite(backup.path, destination)
            except (OSError, CaptureError) as rollback_exc:
                rollback_errors.append(f"restore {relative(destination)}: {rollback_exc}")
        if rollback_errors:
            retained = [
                relative(owner.path)
                for owner in (*backups.values(), *displaced)
                if owner.path.exists()
            ]
            raise CaptureError(
                "recorder output promotion failed and rollback could not restore a coherent bundle: "
                + "; ".join(rollback_errors)
                + "; retained rollback files: "
                + (", ".join(retained) if retained else "none")
            ) from exc
        cleanup_errors: list[str] = []
        for recovery in displaced:
            if not recovery.still_owned():
                cleanup_errors.append(f"retain changed {relative(recovery.path)}")
                continue
            try:
                recovery.path.unlink()
            except OSError as rollback_exc:
                cleanup_errors.append(f"remove {relative(recovery.path)}: {rollback_exc}")
        if cleanup_errors:
            retained = [relative(owner.path) for owner in displaced if owner.path.exists()]
            raise CaptureError(
                "recorder rollback restored destinations but retained failed promoted bytes: "
                + "; ".join(cleanup_errors)
                + "; retained rollback files: "
                + (", ".join(retained) if retained else "none")
            ) from exc
        raise
    finally:
        if committed:
            for backup in backups.values():
                if not backup.still_owned():
                    continue
                try:
                    backup.path.unlink()
                except OSError:
                    # The complete bundle is committed; a private stale backup is
                    # retained rather than risking deletion of a changed entry.
                    pass
        for source, owner in source_owners.items():
            if not owner.still_owned():
                continue
            try:
                source.unlink()
            except OSError:
                # Staged bytes live under the private runtime and are cleaned by
                # the recorder's identity-aware runtime reset.
                pass


def capture_browser_video(
    *, run_root: Path, poster: Path, fixture: bool, base_url: str, canonical_question: str,
) -> tuple[Path, list[dict[str, Any]], dict[str, Any]]:
    """Record one browser session entirely inside the private runtime directory."""
    raw_video: Path | None = None
    with sync_playwright() as playwright:
        browser_mode = FIXTURE_SELF_TEST_BROWSER_MODE if fixture else PRODUCTION_BROWSER_MODE
        browser = playwright.chromium.launch(**chromium_launch_options(browser_mode))
        context: BrowserContext | None = None
        try:
            context = browser.new_context(**browser_context_options(run_root))
            if not fixture:
                configure_live_context(context, base_url)
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
            context = None
            require(video_handle is not None, "Playwright did not create a video handle")
            raw_video = Path(video_handle.path())
        finally:
            try:
                if context is not None:
                    context.close()
            finally:
                browser.close()
    require(raw_video is not None, "Playwright did not return a browser recording")
    return raw_video, actions, recall_proof


def capture(
    *, expected_sha: str, evidence_path: Path, base_url: str, output: Path,
    manifest_path: Path, poster: Path, replace: bool, fixture: bool,
) -> dict[str, Any]:
    require(SHA_RE.fullmatch(expected_sha) is not None, "expected SHA must be 40 lowercase hex characters")
    if not fixture:
        base_url = validate_origin(base_url)
    evidence_path = project_path(evidence_path, "fixture evidence" if fixture else "CAPTURE_REVIEW", exists=True)
    output = project_path(output, "output")
    manifest_path = project_path(manifest_path, "manifest")
    poster = project_path(poster, "poster")
    validate_capture_paths(
        evidence_path=evidence_path,
        output=output,
        manifest_path=manifest_path,
        poster=poster,
        fixture=fixture,
    )
    try:
        evidence_snapshot = read_project_file_once(
            evidence_path,
            "fixture evidence" if fixture else "CAPTURE_REVIEW",
        )
    except ValueError as exc:
        raise CaptureError(str(exc)) from exc
    evidence = read_json_bytes(
        evidence_snapshot.data,
        "fixture evidence" if fixture else "CAPTURE_REVIEW",
    )
    canonical_question = ""
    canonical_source_sha = ""
    if fixture:
        require(evidence.get("exactRuntimeSource") == expected_sha, "fixture evidence SHA mismatch")
    else:
        production_evidence(evidence, expected_sha, base_url)
        canonical_question, canonical_source_sha = reviewed_capture_question()
    recorder_source = video_qa.tracked_source_record(
        "demo/tools/record_live_motion.py",
        "live motion recorder source",
        require_head=not fixture,
    )
    for target, label in ((output, "output"), (manifest_path, "manifest"), (poster, "poster")):
        require(replace or not target.exists(), f"refusing to replace existing {relative(target)} without --replace")

    run_root = video_qa.safe_reset_artifact_directory(
        RECORDING_RUNTIME_ROOT,
        "recording runtime",
    )
    primary_error: BaseException | None = None
    try:
        run_root.mkdir(parents=True)
        staged_video = run_root / "interaction.webm"
        staged_poster = run_root / "interaction-poster.png"
        staged_manifest = run_root / "interaction.manifest.json"
        started_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        raw_video, actions, recall_proof = capture_browser_video(
            run_root=run_root,
            poster=staged_poster,
            fixture=fixture,
            base_url=base_url,
            canonical_question=canonical_question,
        )
        raw_video = project_path(raw_video, "raw browser recording", exists=True)
        staged_poster = project_path(staged_poster, "staged browser poster", exists=True)
        try:
            raw_video.relative_to(run_root)
        except ValueError as exc:
            raise CaptureError("raw browser recording escaped the private recording runtime") from exc
        require(not paths_overlap(raw_video, staged_video)
                and not paths_overlap(raw_video, staged_poster)
                and not paths_overlap(raw_video, staged_manifest),
                "raw browser recording must not alias a staged recorder output")
        require(raw_video.is_file() and raw_video.stat().st_size > 10_000,
                "browser recording is missing or empty")
        require(staged_poster.is_file() and staged_poster.stat().st_size > 0,
                "browser poster is missing or empty")
        validate_recall_proof(recall_proof, canonical_question, fixture=fixture)
        shutil.copyfile(raw_video, staged_video)

        media = video_qa.media_summary(staged_video)
        require(media["width"] == 1920 and media["height"] == 1080, "browser recording is not 1920x1080")
        require(media["audioStreamCount"] == 0, "browser recording unexpectedly contains audio")
        motion = video_qa.diversity(staged_video, duration=min(float(media["durationSeconds"]), 30.0))
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
            "recorderSource": recorder_source,
            "capturedAt": started_at.isoformat().replace("+00:00", "Z"),
            "finishedAt": finished_at.isoformat().replace("+00:00", "Z"),
            "evidenceManifestPath": relative(evidence_path),
            "evidenceManifestSha256": evidence_snapshot.sha256,
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
            "rawVideo": {
                "path": relative(output),
                "sha256": sha256_file(staged_video),
                "bytes": staged_video.stat().st_size,
                **media,
            },
            "frameDiversity": motion,
            "poster": {
                "path": relative(poster),
                "sha256": sha256_file(staged_poster),
                "bytes": staged_poster.stat().st_size,
            },
        }
        staged_manifest.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        require(read_json(staged_manifest, "staged interaction manifest") == manifest,
                "staged interaction manifest changed during serialization")
        promote_recorder_bundle(
            ((staged_video, output), (staged_poster, poster), (staged_manifest, manifest_path)),
            run_root,
            replace=replace,
        )
        return manifest
    except BaseException as exc:
        primary_error = exc
        raise
    finally:
        try:
            video_qa.safe_reset_artifact_directory(
                RECORDING_RUNTIME_ROOT,
                "recording runtime",
            )
        except BaseException as cleanup_exc:
            if primary_error is None:
                raise
            primary_error.add_note(f"recording runtime cleanup also failed: {cleanup_exc}")


@contextmanager
def _compose_fixture_tool_discovery() -> Iterator[None]:
    """Temporarily seed only the recorder fixture's compose-tool cache from PATH."""

    tool_names = ("ffmpeg", "ffprobe")
    environment_names = tuple(video_qa.TRUSTED_EXECUTABLE_ENV[name] for name in tool_names)
    missing = object()
    previous_environment: dict[str, str | object] = {
        name: os.environ.get(name, missing) for name in environment_names
    }
    previous_cache = dict(video_qa._TRUSTED_EXECUTABLE_CACHE)
    try:
        video_qa.clear_trusted_executable_cache()
        for name in environment_names:
            os.environ.pop(name, None)
        for name in tool_names:
            video_qa.resolve_trusted_executable(name, allow_discovery=True)
        yield
    finally:
        video_qa.clear_trusted_executable_cache()
        video_qa._TRUSTED_EXECUTABLE_CACHE.update(previous_cache)
        for name, value in previous_environment.items():
            if value is missing:
                os.environ.pop(name, None)
            else:
                os.environ[name] = str(value)


def self_test() -> int:
    with _compose_fixture_tool_discovery():
        root = video_qa.safe_reset_artifact_directory(
            ".artifacts/final-video/memory-recorder-selftest",
            "memory recorder self-test root",
        )
        root.mkdir(parents=True)
        sha = "1" * 40
        evidence = root / "CAPTURE_REVIEW.json"
        evidence.write_text(
            json.dumps({"status": "passed", "exactRuntimeSource": sha}) + "\n",
            encoding="utf-8",
        )
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
