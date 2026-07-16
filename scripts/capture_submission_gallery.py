#!/usr/bin/env python3
"""Capture the final, sanitized MemoryAgent submission media from one verified release.

This is deliberately a release gate, not a best-effort screenshot helper.  It
requires exact-deployment evidence, validates the public and authenticated live
paths, drives the real Explorer, keeps raw material under the ignored
``demo/private-originals`` directory, and only then writes reviewed composites to
``demo/gallery``.

The reviewer credential is accepted through ``DEMO_JUDGE_API_KEY`` or an explicitly
ignored, project-local JSON file.  The credential value is never accepted as a
command-line literal, printed, serialized into an artifact, included in a
screenshot, or placed in a tracked file.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
from typing import Any, Sequence
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from exact_deploy_evidence import (
    ExactDeployEvidenceError,
    STRICT_FINAL_MARKER,
    TERMINAL_SUCCESS_TRUNCATED_OUTPUT,
    validate_exact_deploy_evidence as _validate_exact_deploy_evidence,
)
from repo_paths import ProjectFileSnapshot, REPO_ROOT, inside_repo, read_project_file_once


REPO = Path(REPO_ROOT)
PRIVATE = REPO / "demo" / "private-originals"
GALLERY = REPO / "demo" / "gallery"
FINAL_MEDIA = REPO / "demo" / "final-media"
PROOF_FRAMES = FINAL_MEDIA / "proof-frames"
ARCHITECTURE = FINAL_MEDIA / "judge-architecture.jpg"

DEFAULT_BASE_URL = "https://memory.43.106.13.19.sslip.io"
DEFAULT_REPO_URL = "https://github.com/upgradedev/archon-qwen-memoryagent"
EXPECTED_EMBEDDER = "text-embedding-v4"
EXPECTED_NARRATOR = "qwen-plus"
EXPECTED_VISION = "qwen-vl-max"
EXPECTED_DIMENSION = 1024
CANVAS = (1920, 1080)
GALLERY_CANVAS = (1500, 1000)

PRIMARY_OUTPUTS = (
    "01-grounded-cross-session-recall.png",
    "02-session-feedback-persistence.png",
    "03-read-only-field-self-audit.png",
    "04-qwen-semantic-self-audit.png",
    "05-human-resolution-control.png",
    "06-safe-memory-lifecycle.png",
    "07-qwen-memoryagent-architecture.png",
)

CANONICAL_RECALL_QUESTION = (
    "Using only the retrieved memory, state the true employer cost for Northwind Trading in 2026-05 "
    "and include citation marker [1] in the sentence."
)
VALID_GROUNDING_RESULTS = frozenset({("passed", 1), ("repaired", 2)})

SECONDARY_OUTPUTS = (
    "08-qwen-vl-document-canary.png",
    "09-live-health-readiness.png",
    "10-alibaba-runtime-proof.png",
    "11-public-repository-license.png",
)

SAFE_POST_DEPLOY_PATHS = (
    re.compile(r"^(?:README\.md|SECURITY\.md|deploy/DEPLOY_STATE\.md)$"),
    re.compile(r"^(?:demo|docs)/"),
    re.compile(r"^\.github/workflows/demo-video\.yml$"),
    re.compile(r"^scripts/(?:capture_live\.sh|captions\.txt|capture_submission_gallery\.py)$"),
)

SENSITIVE_KEY = re.compile(
    r"(?:authorization|api[-_]?key|access[-_]?key|secret|password|token|cookie)",
    re.IGNORECASE,
)
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+\-/=]{8,}", re.IGNORECASE)
PRIVATE_IPV4 = re.compile(
    r"\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b"
)


class GateError(RuntimeError):
    """A fail-closed release/media validation error."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def project_path(value: str | Path, label: str, *, must_exist: bool = False) -> Path:
    return Path(inside_repo(value, label, must_exist=must_exist))


def snapshot_project_file(value: str | Path, label: str) -> ProjectFileSnapshot:
    try:
        return read_project_file_once(value, label)
    except ValueError as exc:
        raise GateError(str(exc)) from exc


class NoRedirectHandler(urlrequest.HTTPRedirectHandler):
    """Turn every HTTP redirect into an error instead of a follow-up request."""

    def redirect_request(
        self,
        req: urlrequest.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


NO_REDIRECT_OPENER = urlrequest.build_opener(NoRedirectHandler())


def validate_live_origin(value: str) -> str:
    require(value == DEFAULT_BASE_URL, f"live credential destination must be exactly {DEFAULT_BASE_URL}")
    parsed = urlparse.urlparse(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise GateError("live credential destination has an invalid port") from exc
    require(
        parsed.scheme == "https"
        and parsed.hostname == "memory.43.106.13.19.sslip.io"
        and port in {None, 443}
        and parsed.username is None
        and parsed.password is None
        and parsed.path == ""
        and not parsed.params
        and not parsed.query
        and not parsed.fragment,
        "live credential destination must be the pinned credential-free HTTPS origin",
    )
    return DEFAULT_BASE_URL


def is_pinned_live_request(url: str, *, redirected: bool = False) -> bool:
    if redirected:
        return False
    parsed = urlparse.urlparse(url)
    try:
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname == "memory.43.106.13.19.sslip.io"
        and port in {None, 443}
        and parsed.username is None
        and parsed.password is None
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO), *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
    )
    if check and result.returncode != 0:
        # Never echo arbitrary git stderr: credential helpers and remote URLs do
        # not belong in a public media-build log.
        raise GateError(f"git {' '.join(args[:2])} failed (exit {result.returncode})")
    return result.stdout.strip()


def allowed_post_deploy_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return any(pattern.fullmatch(normalized) or pattern.match(normalized) for pattern in SAFE_POST_DEPLOY_PATHS)


def validate_exact_deploy_evidence(expected_sha: str, status: Any, output: str | bytes) -> str:
    """Translate the shared exact-deploy contract into this gate's error type."""

    try:
        return _validate_exact_deploy_evidence(expected_sha, status, output)
    except ExactDeployEvidenceError as exc:
        raise GateError(str(exc)) from exc


def verify_exact_release(
    expected_sha: str,
    deployment_output: ProjectFileSnapshot,
    deployment_status: ProjectFileSnapshot,
) -> tuple[str, str, dict[str, str | int]]:
    require(re.fullmatch(r"[0-9a-f]{40}", expected_sha) is not None, "expected SHA must be 40 lowercase hex characters")
    commit_check = subprocess.run(
        ["git", "-C", str(REPO), "cat-file", "-e", f"{expected_sha}^{{commit}}"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    require(commit_check.returncode == 0, "expected SHA is not present in this repository")

    try:
        status = json.loads(deployment_status.text())
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GateError("deployment status is not valid UTF-8 JSON") from exc
    evidence_mode = validate_exact_deploy_evidence(expected_sha, status, deployment_output.data)
    producer = {
        "invocationId": str(status["invocationId"]),
        "commandId": str(status["commandId"]),
        "outputSha256": deployment_output.sha256,
        "outputBytes": deployment_output.size,
    }

    compose = git("show", f"{expected_sha}:docker-compose.yml")
    require("127.0.0.1:${BACKEND_PORT:-9000}:9000" in compose, "exact source no longer binds the backend to loopback")
    require("pgvector/pgvector:" in compose, "exact source no longer declares the self-hosted pgvector service")

    # Refresh only the remote-tracking commit metadata.  No checkout, reset, merge,
    # or source mutation is performed.
    git("fetch", "--quiet", "origin", "main")
    remote_main = git("rev-parse", "origin/main")
    require(re.fullmatch(r"[0-9a-f]{40}", remote_main) is not None, "origin/main did not resolve to a commit")
    ancestor = subprocess.run(
        ["git", "-C", str(REPO), "merge-base", "--is-ancestor", expected_sha, remote_main],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    require(ancestor.returncode == 0, "exact-deployed SHA is not an ancestor of origin/main")

    changed = [line for line in git("diff", "--name-only", f"{expected_sha}..{remote_main}").splitlines() if line]
    unsafe = [path for path in changed if not allowed_post_deploy_path(path)]
    require(not unsafe, "origin/main contains a post-deploy runtime-affecting path; redeploy before capture")
    return remote_main, evidence_mode, producer


def load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{label} is not valid UTF-8 JSON") from exc


def reviewer_token_from_args(args: argparse.Namespace) -> str:
    env_token = os.environ.get("DEMO_JUDGE_API_KEY", "")
    credential_arg = getattr(args, "reviewer_credential_json", None)
    require(not (env_token and credential_arg), "choose either DEMO_JUDGE_API_KEY or --reviewer-credential-json, never both")
    if credential_arg:
        credential_path = project_path(credential_arg, "reviewer credential JSON", must_exist=True)
        relative = str(credential_path.relative_to(REPO)).replace("\\", "/")
        tracked = subprocess.run(
            ["git", "-C", str(REPO), "ls-files", "--error-unmatch", "--", relative],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        require(tracked.returncode != 0, "reviewer credential JSON must never be tracked")
        ignored = subprocess.run(
            ["git", "-C", str(REPO), "check-ignore", "--quiet", "--", relative],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        require(ignored.returncode == 0, "reviewer credential JSON must be under an ignored project path")
        payload = load_json(credential_path, "reviewer credential JSON")
        require(isinstance(payload, dict), "reviewer credential JSON must be an object")
        token = payload.get("token")
        require(isinstance(token, str), "reviewer credential JSON has no string token field")
    else:
        token = env_token
    require(len(token) >= 32 and not token.isspace(), "a private 32+ character reviewer credential is required")
    return token


def scrub_json(value: Any) -> Any:
    """Remove secret-shaped keys before retaining ignored raw responses."""
    if isinstance(value, dict):
        return {
            str(key): ("[REMOVED]" if SENSITIVE_KEY.search(str(key)) else scrub_json(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [scrub_json(item) for item in value]
    if isinstance(value, str):
        return BEARER.sub("Bearer [REMOVED]", value)
    return value


def write_private_json(name: str, value: Any) -> None:
    path = PRIVATE / name
    path.write_text(json.dumps(scrub_json(value), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def request_json(
    method: str,
    base_url: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    reviewer_token: str | None = None,
    timeout: float = 90.0,
) -> tuple[Any, dict[str, str]]:
    base_url = validate_live_origin(base_url)
    url = base_url.rstrip("/") + path
    data = json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json", "User-Agent": "Archon-MemoryAgent-Media-Gate/1.0"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if reviewer_token:
        headers["Authorization"] = f"Bearer {reviewer_token}"
    req = urlrequest.Request(url, data=data, headers=headers, method=method)
    try:
        with NO_REDIRECT_OPENER.open(req, timeout=timeout) as response:
            raw = response.read()
            status = response.status
            response_headers = {key.lower(): value for key, value in response.headers.items()}
    except urlerror.HTTPError as exc:
        # The body can contain operational details.  Report only path + status.
        if 300 <= exc.code < 400:
            raise GateError(f"{method} {path} attempted a forbidden HTTP redirect") from exc
        raise GateError(f"{method} {path} returned HTTP {exc.code}") from exc
    except (urlerror.URLError, TimeoutError, OSError) as exc:
        raise GateError(f"{method} {path} was unreachable") from exc
    require(status == 200, f"{method} {path} returned HTTP {status}")
    try:
        return json.loads(raw.decode("utf-8")), response_headers
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{method} {path} did not return JSON") from exc


def model_is_real(value: Any) -> bool:
    return isinstance(value, str) and value != "" and not value.lower().startswith("fake-")


def validate_ready(ready: Any) -> None:
    require(isinstance(ready, dict) and ready.get("status") == "ready", "/ready is not ready")
    checks = ready.get("checks")
    require(isinstance(checks, dict), "/ready omitted checks")

    def positive(name_pattern: str) -> bool:
        for key, value in checks.items():
            if re.search(name_pattern, str(key), re.IGNORECASE):
                if isinstance(value, dict):
                    return value.get("ok") is True or value.get("configured") is True
                return str(value).lower() in {"ok", "ready", "configured", "configured-not-probed", "operational"}
        return False

    require(positive(r"database"), "/ready database check is not positive")
    require(positive(r"qwen|embedder"), "/ready Qwen check is not positive")
    require(positive(r"auth"), "/ready reviewer-auth check is not positive")


def public_release_probes(base_url: str, reviewer_token: str) -> dict[str, Any]:
    health, _ = request_json("GET", base_url, "/health")
    require(isinstance(health, dict) and health.get("status") == "ok", "/health is not ok")
    require(health.get("embedder") == EXPECTED_EMBEDDER, "/health reports the wrong embedding model")
    require(health.get("narrator") == EXPECTED_NARRATOR, "/health reports the wrong narrator model")
    require(model_is_real(health.get("judge")), "/health reports a Fake or missing semantic judge")
    require(health.get("embedDim") == EXPECTED_DIMENSION, "/health reports the wrong embedding dimension")

    ready, _ = request_json("GET", base_url, "/ready")
    validate_ready(ready)

    deep, _ = request_json("GET", base_url, "/ready/deep", reviewer_token=reviewer_token, timeout=120)
    require(isinstance(deep, dict), "/ready/deep returned the wrong shape")
    deep_checks = deep.get("checks")
    require(isinstance(deep_checks, dict), "/ready/deep omitted checks")
    require(
        isinstance(deep_checks.get("embedder"), dict) and deep_checks["embedder"].get("status") == "operational",
        "/ready/deep did not prove the real embedder operational",
    )
    require(
        isinstance(deep_checks.get("narrator"), dict) and deep_checks["narrator"].get("grounding") == "passed",
        "/ready/deep did not prove grounded narration",
    )

    openapi, _ = request_json("GET", base_url, "/openapi.json")
    paths = openapi.get("paths") if isinstance(openapi, dict) else None
    required_paths = {
        "/ready", "/ready/deep", "/ingest/invoice", "/feedback", "/consistency/semantic",
        "/resolve-conflict", "/consolidate", "/forget",
    }
    require(isinstance(paths, dict) and required_paths.issubset(paths), "/openapi.json is missing final hardened routes")

    request_json("POST", base_url, "/demo/seed", body={})
    seeded, _ = request_json("POST", base_url, "/demo/seed", body={})
    require(isinstance(seeded, dict) and seeded.get("alreadySeeded") is True, "public seed is not idempotent")
    require(seeded.get("reconciled") is False and seeded.get("events") == 0, "public seed required unexpected reconciliation")

    pnl_path = "/pnl?" + urlparse.urlencode({"company": "Northwind Trading"})
    pnl, _ = request_json("GET", base_url, pnl_path)
    require(isinstance(pnl, dict), "selected-company P&L returned the wrong shape")
    require(pnl.get("currency") == "EUR", "selected-company P&L is not one EUR bucket")
    require(pnl.get("unknown_currency_records") == 0, "selected-company P&L contains unknown currencies")
    require(pnl.get("employer_cost_total") == 14600, "selected-company P&L employer cost is not 14,600")
    require(pnl.get("revenue_total") == 42700 and pnl.get("net_profit") == 28100, "selected-company P&L totals are stale")

    # Seed the same fixed original-synthetic demo in the isolated reviewer tenant.
    # This makes the later semantic/human-control frame deterministic even when a
    # prior evidence run left an unrelated cleanup placeholder in that tenant.
    request_json("POST", base_url, "/demo/seed", body={}, reviewer_token=reviewer_token)
    reviewer_seeded, _ = request_json("POST", base_url, "/demo/seed", body={}, reviewer_token=reviewer_token)
    require(
        isinstance(reviewer_seeded, dict)
        and reviewer_seeded.get("alreadySeeded") is True
        and reviewer_seeded.get("reconciled") is False
        and reviewer_seeded.get("events") == 0,
        "reviewer-tenant fixed seed is not idempotent",
    )
    reviewer_pnl, _ = request_json("GET", base_url, pnl_path, reviewer_token=reviewer_token)
    require(isinstance(reviewer_pnl, dict), "reviewer-tenant P&L response is not an object")
    for key in ("currency", "employer_cost_total", "revenue_total", "net_profit", "unknown_currency_records"):
        require(reviewer_pnl.get(key) == pnl.get(key), f"reviewer-tenant fixed seed differs at {key}")

    for name, value in {
        "health.json": health,
        "ready.json": ready,
        "ready-deep.json": deep,
        "seed-idempotent.json": seeded,
        "northwind-pnl.json": pnl,
        "reviewer-seed-idempotent.json": reviewer_seeded,
        "reviewer-northwind-pnl.json": reviewer_pnl,
    }.items():
        write_private_json(name, value)
    return {
        "health": health,
        "ready": ready,
        "deep": deep,
        "pnl": pnl,
        "reviewerPnl": reviewer_pnl,
    }


def reviewer_memory_count(base_url: str, reviewer_token: str) -> int:
    payload, _ = request_json("GET", base_url, "/memory/count", reviewer_token=reviewer_token)
    count = payload.get("count") if isinstance(payload, dict) else None
    require(isinstance(count, int) and count >= 0, "reviewer memory count returned the wrong shape")
    return count


def reviewer_company_list(base_url: str, reviewer_token: str, company: str) -> dict[str, Any]:
    path = "/memory/list?" + urlparse.urlencode({"company": company, "limit": "100"})
    payload, _ = request_json("GET", base_url, path, reviewer_token=reviewer_token)
    require(isinstance(payload, dict) and isinstance(payload.get("items"), list), "reviewer memory list returned the wrong shape")
    require(payload.get("count") == len(payload["items"]), "reviewer memory list count is inconsistent")
    return payload


def synthetic_vision_document(marker: str, doc_type: str) -> str:
    """Build one page of an original synthetic payroll evidence pair in memory."""
    require(doc_type in {"payroll_register", "bank_confirmation"}, "unsupported synthetic vision document type")
    image = Image.new("RGB", (1600, 1000), "#fbfcfa")
    draw = ImageDraw.Draw(image)
    draw.rectangle((45, 45, 1555, 955), outline="#183b30", width=5)
    title = "PAYROLL REGISTER" if doc_type == "payroll_register" else "BANK CONFIRMATION"
    draw.text((105, 90), f"ORIGINAL SYNTHETIC {title}", font=font(50, bold=True), fill="#092019")
    draw.text((108, 178), "Submission evidence only · no real person or business", font=font(30), fill="#31584a")
    common = (
        ("Company", marker),
        ("Period", "2026-06"),
        ("Payroll run", f"RUN-{marker}"),
        ("Currency", "EUR"),
    )
    financial = (
        (
            ("Document type", "payroll_register"),
            ("Gross pay total", "EUR 1,000.00"),
            ("Employer social security", "EUR 200.00"),
            ("True employer cost", "EUR 1,200.00"),
        )
        if doc_type == "payroll_register"
        else (
            ("Document type", "bank_confirmation"),
            ("Net pay total", "EUR 800.00"),
            ("Employee count", "1"),
            ("Payment date", "2026-06-30"),
        )
    )
    rows = (*common, *financial)
    y = 285
    for label, value in rows:
        draw.text((130, y), label.upper(), font=font(24, bold=True), fill="#597268")
        draw.text((610, y - 8), value, font=font(38, bold=True), fill="#10271f")
        draw.line((125, y + 52, 1470, y + 52), fill="#d5dfdb", width=2)
        y += 77
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    require(len(encoded) < 8_000_000, "synthetic vision canary page unexpectedly exceeds the route cap")
    return f"data:image/png;base64,{encoded}"


def vision_document_canary(
    base_url: str,
    reviewer_token: str,
    expected_sha: str,
) -> dict[str, Any]:
    """Exercise real qwen-vl-max through the protected path with zero persistence."""
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
    marker = f"MVL{expected_sha[:6].upper()}{stamp}{secrets.token_hex(3).upper()}"
    before_count = reviewer_memory_count(base_url, reviewer_token)
    before_list = reviewer_company_list(base_url, reviewer_token, marker)
    require(before_list["count"] == 0, "vision canary marker already exists in reviewer memory")

    response, _ = request_json(
        "POST",
        base_url,
        "/ingest/documents",
        body={
            "dryRun": True,
            "documents": [
                {
                    "doc_id": f"register-{marker}",
                    "event_ref": f"RUN-{marker}",
                    "filename": f"original-synthetic-register-{marker}.png",
                    "source_kind": "image",
                    "content": synthetic_vision_document(marker, "payroll_register"),
                    "company": marker,
                    "period": "2026-06",
                    "currency": "EUR",
                    "declared_type": "payroll_register",
                },
                {
                    "doc_id": f"bank-{marker}",
                    "event_ref": f"RUN-{marker}",
                    "filename": f"original-synthetic-bank-{marker}.png",
                    "source_kind": "image",
                    "content": synthetic_vision_document(marker, "bank_confirmation"),
                    "company": marker,
                    "period": "2026-06",
                    "currency": "EUR",
                    "declared_type": "bank_confirmation",
                },
            ],
        },
        reviewer_token=reviewer_token,
        timeout=180,
    )
    require(isinstance(response, dict) and response.get("dryRun") is True, "vision canary did not remain a dry run")
    require(response.get("written") == 0 and response.get("memoryIds") == [], "vision canary reported a persistent write")
    require(response.get("extractionModels") == [EXPECTED_VISION], "vision canary did not report qwen-vl-max")
    require(response.get("events") == 1, "vision canary did not produce exactly one bounded event")
    results = response.get("results")
    event = results[0].get("event") if isinstance(results, list) and len(results) == 1 and isinstance(results[0], dict) else None
    require(isinstance(event, dict) and event.get("company") == marker, "vision canary did not preserve its unique synthetic identity")
    require(
        event.get("currency") == "EUR"
        and event.get("employer_cost_total") == 1200
        and event.get("bank_net_total") == 800,
        "vision canary extracted stale totals",
    )

    # A second independently authenticated read catches accidental delayed writes,
    # while the exact unique marker makes absence stronger than a global count alone.
    time.sleep(0.25)
    after_count = reviewer_memory_count(base_url, reviewer_token)
    after_list = reviewer_company_list(base_url, reviewer_token, marker)
    require(after_count == before_count, "vision dry run changed the reviewer memory count")
    require(after_list["count"] == 0, "vision dry run left unique-prefix memory residue")
    require(marker not in json.dumps(after_list, sort_keys=True), "vision marker remains in active reviewer memory")

    safe = {
        "status": "passed",
        "source": "original-synthetic-png-pair",
        "documents": 2,
        "route": "POST /ingest/documents",
        "modelId": EXPECTED_VISION,
        "dryRun": True,
        "events": 1,
        "written": 0,
        "reviewerCountBefore": before_count,
        "reviewerCountAfter": after_count,
        "uniquePrefixResidue": 0,
        "extracted": {"currency": "EUR", "employerCost": 1200, "bankNet": 800},
    }
    write_private_json("08-qwen-vl-document-canary-response.json", response)
    write_private_json("08-qwen-vl-document-canary-proof.json", safe)
    return safe


def font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"), Path("C:/Windows/Fonts/segoeuib.ttf"), Path("C:/Windows/Fonts/arialbd.ttf"))
        if bold
        else (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), Path("C:/Windows/Fonts/segoeui.ttf"), Path("C:/Windows/Fonts/arial.ttf"))
    )
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def strip_and_save(
    image: Image.Image,
    output: Path,
    *,
    size: tuple[int, int] | None = None,
    min_bytes: int = 20_000,
) -> None:
    clean = image.convert("RGB")
    if size is not None:
        clean = ImageOps.fit(clean, size, method=Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    clean.save(output, format="PNG", optimize=True)
    with Image.open(output) as check:
        require(check.size == (size or clean.size), f"{output.name} has the wrong dimensions")
        require(not check.info, f"{output.name} retained PNG metadata")
        require(output.stat().st_size >= min_bytes, f"{output.name} is unexpectedly small")


def save_dual_submission_frame(
    canvas: Image.Image,
    gallery_output: Path,
    *,
    proof_output: Path | None = None,
) -> None:
    """Write one 16:9 video frame and one no-crop 3:2 Devpost final.

    The 1920×1080 composition is the source of truth.  Devpost receives a
    1500×1000 canvas with that full frame centered and letterboxed, never a crop;
    therefore host, model, caveat and footer text stay inside both safe areas.
    """
    require(canvas.size == CANVAS, "submission source frame must be 1920×1080")
    PROOF_FRAMES.mkdir(parents=True, exist_ok=True)
    if proof_output is not None:
        video_output = proof_output
    elif gallery_output.resolve().is_relative_to(GALLERY.resolve()):
        video_output = PROOF_FRAMES / f"{gallery_output.stem}-16x9.png"
    else:
        video_output = gallery_output.with_name(f"{gallery_output.stem}-16x9.png")
    strip_and_save(canvas, video_output, size=CANVAS)

    devpost = Image.new("RGB", GALLERY_CANVAS, "#06110e")
    fitted = ImageOps.contain(canvas.convert("RGB"), GALLERY_CANVAS, method=Image.Resampling.LANCZOS)
    x = (GALLERY_CANVAS[0] - fitted.width) // 2
    y = (GALLERY_CANVAS[1] - fitted.height) // 2
    devpost.paste(fitted, (x, y))
    draw = ImageDraw.Draw(devpost)
    draw.rectangle((0, 0, GALLERY_CANVAS[0], 6), fill="#35d399")
    draw.rectangle((0, GALLERY_CANVAS[1] - 6, GALLERY_CANVAS[0], GALLERY_CANVAS[1]), fill="#183b30")
    strip_and_save(devpost, gallery_output, size=GALLERY_CANVAS)


def rounded(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], fill: str, *, radius: int = 24, outline: str | None = None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def wrap(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.ImageFont, max_width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and draw.textlength(candidate, font=face) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def fit_source(source: Image.Image, box: tuple[int, int, int, int], background: str = "#0a1412") -> Image.Image:
    width = box[2] - box[0]
    height = box[3] - box[1]
    panel = Image.new("RGB", (width, height), background)
    contained = ImageOps.contain(source.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)
    panel.paste(contained, ((width - contained.width) // 2, (height - contained.height) // 2))
    return panel


def composite_live_capture(
    raw_path: Path,
    output: Path,
    *,
    eyebrow: str,
    title: str,
    subtitle: str,
    badges: Sequence[str],
    base_url: str,
    expected_sha: str,
    observed_at: str,
    accent: str = "#35d399",
    source_label: str = "Exact runtime",
    dual_submission: bool = True,
) -> None:
    source = Image.open(raw_path)
    canvas = Image.new("RGB", CANVAS, "#06110e")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, CANVAS[0], 10), fill=accent)
    draw.text((80, 54), eyebrow.upper(), font=font(24, bold=True), fill=accent)
    draw.text((80, 94), title, font=font(54, bold=True), fill="#f3fff9")
    for index, line in enumerate(wrap(draw, subtitle, font(27), 1740)[:2]):
        draw.text((82, 166 + index * 34), line, font=font(27), fill="#a8beb5")

    badge_x = 80
    for value in badges:
        face = font(22, bold=True)
        width = int(draw.textlength(value, font=face)) + 42
        rounded(draw, (badge_x, 244, badge_x + width, 292), "#10231d", radius=22, outline="#2c5747", width=2)
        draw.text((badge_x + 21, 254), value, font=face, fill="#d8f9ec")
        badge_x += width + 16

    rounded(draw, (70, 320, 1850, 975), "#0a1713", radius=28, outline="#23483b", width=2)
    panel = fit_source(source, (88, 338, 1832, 957), "#0b1513")
    canvas.paste(panel, (88, 338))
    draw.rectangle((0, 1000, 1920, 1080), fill="#091612")
    draw.text((80, 1018), f"LIVE HTTPS · {base_url}", font=font(22, bold=True), fill="#d3f6e8")
    draw.text((760, 1018), f"{source_label} {expected_sha[:12]} · observed {observed_at}", font=font(20), fill="#89a79b")
    if dual_submission:
        save_dual_submission_frame(canvas, output)
    else:
        strip_and_save(canvas, output, size=CANVAS)


def render_health_card(
    output: Path,
    probes: dict[str, Any],
    *,
    base_url: str,
    expected_sha: str,
    observed_at: str,
) -> None:
    health = probes["health"]
    deep = probes["deep"]
    canvas = Image.new("RGB", CANVAS, "#06110e")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 10), fill="#35d399")
    draw.text((80, 62), "INDEPENDENT LIVE PROBES", font=font(24, bold=True), fill="#35d399")
    draw.text((80, 108), "Qwen + pgvector are ready", font=font(58, bold=True), fill="#f2fff9")
    draw.text((82, 186), "Cheap readiness and an authenticated cached end-to-end model probe are shown separately.", font=font(27), fill="#9cb3aa")

    cards = [
        ("/health", "200 · status ok", [
            ("Embedding", str(health["embedder"])),
            ("Narration", str(health["narrator"])),
            ("Semantic judge", str(health["judge"])),
            ("Vector dimensions", str(health["embedDim"])),
        ]),
        ("/ready", "200 · status ready", [
            ("Database", "ready"),
            ("Qwen configuration", "ready"),
            ("Reviewer auth", "configured"),
            ("Spend", "zero model calls"),
        ]),
        ("/ready/deep", "200 · authenticated", [
            ("Embedder", str(deep["checks"]["embedder"]["status"])),
            ("Narrator grounding", str(deep["checks"]["narrator"]["grounding"])),
            ("Cache", "hit" if deep.get("cached") else "fresh bounded probe"),
            ("Credential", "never rendered or retained"),
        ]),
    ]
    for index, (heading, status, rows) in enumerate(cards):
        x0 = 70 + index * 610
        x1 = x0 + 575
        rounded(draw, (x0, 290, x1, 890), "#0b1b16", radius=30, outline="#235444", width=2)
        draw.text((x0 + 34, 326), heading, font=font(38, bold=True), fill="#f3fff9")
        draw.text((x0 + 34, 382), status, font=font(22, bold=True), fill="#35d399")
        y = 465
        for label, value in rows:
            draw.text((x0 + 34, y), label.upper(), font=font(18, bold=True), fill="#789489")
            for line in wrap(draw, value, font(27, bold=True), 500)[:2]:
                y += 32
                draw.text((x0 + 34, y), line, font=font(27, bold=True), fill="#dff9ef")
            y += 44
    draw.text((80, 948), f"{base_url} · exact-deploy evidence {expected_sha[:12]} · {observed_at}", font=font(23), fill="#9db3aa")
    save_dual_submission_frame(canvas, output)


def render_vision_canary_card(
    output: Path,
    proof: dict[str, Any],
    *,
    base_url: str,
    expected_sha: str,
    observed_at: str,
) -> None:
    canvas = Image.new("RGB", CANVAS, "#06110e")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 10), fill="#60a5fa")
    draw.text((80, 60), "REAL DOCUMENT-VISION CANARY", font=font(24, bold=True), fill="#60a5fa")
    draw.text((80, 108), "qwen-vl-max reads it. Dry-run retains nothing.", font=font(56, bold=True), fill="#f3fff9")
    draw.text((82, 185), "An original synthetic two-page evidence pair traverses the protected live path; exact-prefix absence is checked after completion.", font=font(26), fill="#a3b8b0")

    steps = (
        ("1", "ORIGINAL INPUT", "2 synthetic PNG pages", "Payroll register + bank confirmation"),
        ("2", "LIVE MODEL PATH", str(proof["modelId"]), "POST /ingest/documents · bounded"),
        ("3", "EXTRACTED", "EUR 1,200 cost · 800 cash", f"{proof['events']} fused event · model id reported"),
        ("4", "ABSENCE GATE", "0 writes · 0 prefix residue", f"reviewer count {proof['reviewerCountBefore']} → {proof['reviewerCountAfter']}"),
    )
    for index, (number, heading, value, detail) in enumerate(steps):
        x0 = 70 + index * 455
        x1 = x0 + 420
        rounded(draw, (x0, 300, x1, 840), "#0b1b17", radius=30, outline="#284d42", width=2)
        rounded(draw, (x0 + 28, 330, x0 + 88, 390), "#60a5fa", radius=30)
        draw.text((x0 + 58, 360), number, anchor="mm", font=font(28, bold=True), fill="#06110e")
        draw.text((x0 + 30, 430), heading, font=font(22, bold=True), fill="#8dbef7")
        y = 490
        for line in wrap(draw, value, font(34, bold=True), 360)[:3]:
            draw.text((x0 + 30, y), line, font=font(34, bold=True), fill="#effff8")
            y += 44
        y += 24
        for line in wrap(draw, detail, font(23), 360)[:3]:
            draw.text((x0 + 30, y), line, font=font(23), fill="#9db5ab")
            y += 32
    draw.text((80, 915), "Evidence boundary", font=font(19, bold=True), fill="#759087")
    draw.text((270, 910), "Model execution is live; the displayed record is original synthetic and the route is explicitly non-persisting.", font=font(23), fill="#d5eee4")
    draw.text((80, 970), f"{base_url} · exact runtime {expected_sha[:12]} · {observed_at}", font=font(21), fill="#87a096")
    save_dual_submission_frame(canvas, output)


def render_feedback_persistence_card(
    output: Path,
    proof: dict[str, Any],
    *,
    base_url: str,
    expected_sha: str,
    observed_at: str,
) -> None:
    session_b = proof["sessionB"]
    canvas = Image.new("RGB", CANVAS, "#06110e")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 10), fill="#a78bfa")
    draw.text((80, 60), "EXPLICIT FEEDBACK · FRESH SESSION", font=font(24, bold=True), fill="#a78bfa")
    draw.text((80, 108), "Session A stores feedback. Session B applies it.", font=font(56, bold=True), fill="#f4f0ff")
    draw.text((82, 185), "The correction is a durable, cited memory record—not autonomous training and not a model-weight update.", font=font(27), fill="#b9aecf")

    panels = (
        (80, "SESSION A · REVIEWER FEEDBACK", "Persisted correction", proof["preferenceDisplay"], "Original synthetic fact superseded · correction provenance retained"),
        (980, "SESSION B · NEW CLIENT", "Grounded application", str(session_b["answer"]), f"{session_b['citationCount']} citation(s) · {session_b['modelId']} · corrected memory recalled"),
    )
    for x0, eyebrow, heading, body, detail in panels:
        x1 = x0 + 850
        rounded(draw, (x0, 300, x1, 870), "#0d1a17", radius=30, outline="#514574", width=2)
        draw.text((x0 + 38, 340), eyebrow, font=font(21, bold=True), fill="#aa93ef")
        draw.text((x0 + 38, 392), heading, font=font(38, bold=True), fill="#f6f2ff")
        y = 470
        for line in wrap(draw, body, font(29), 760)[:5]:
            draw.text((x0 + 38, y), line, font=font(29), fill="#d8eee5")
            y += 39
        draw.line((x0 + 38, 720, x1 - 38, 720), fill="#3e3754", width=2)
        y = 752
        for line in wrap(draw, detail, font(22), 760)[:3]:
            draw.text((x0 + 38, y), line, font=font(22), fill="#9eb4aa")
            y += 31
    draw.text((80, 925), "Persistence proof", font=font(19, bold=True), fill="#817799")
    draw.text((270, 920), "Separate authenticated calls; state survives into Session B, then the unique synthetic marker is scrubbed after proof.", font=font(23), fill="#d9d1ec")
    draw.text((80, 970), f"{base_url} · exact runtime {expected_sha[:12]} · {observed_at}", font=font(21), fill="#91879f")
    save_dual_submission_frame(canvas, output)


def render_lifecycle_card(
    output: Path,
    preview: dict[str, Any],
    confirmed: dict[str, Any],
    evidence: dict[str, Any],
    *,
    base_url: str,
    expected_sha: str,
    observed_at: str,
) -> None:
    canvas = Image.new("RGB", CANVAS, "#07110f")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 10), fill="#6ee7b7")
    draw.text((80, 62), "AUTHENTICATED MEMORY LIFECYCLE", font=font(24, bold=True), fill="#6ee7b7")
    draw.text((80, 110), "Preview first. Confirm explicitly.", font=font(58, bold=True), fill="#f3fff9")
    draw.text((82, 190), "During the one-row operation, protected seed/correction stay unchanged; post-proof cleanup then scrubs the marker.", font=font(27), fill="#9db4ab")

    cards = [
        ("1", "PREVIEW", preview, "Exactly one candidate · no mutation"),
        ("2", "CONFIRMED", confirmed, "Exactly one deletion · audit persisted"),
    ]
    for index, (number, heading, payload, outcome) in enumerate(cards):
        x0 = 80 + index * 900
        x1 = x0 + 840
        rounded(draw, (x0, 300, x1, 850), "#0c1c17", radius=32, outline="#285c49", width=2)
        rounded(draw, (x0 + 38, 338, x0 + 98, 398), "#35d399", radius=30)
        draw.text((x0 + 59, 348), number, anchor="ma", font=font(28, bold=True), fill="#052016")
        draw.text((x0 + 128, 340), heading, font=font(34, bold=True), fill="#effff8")
        rows = [
            ("dryRun", str(payload.get("dryRun")).lower()),
            ("scanned in reviewer tenant", str(payload.get("scanned"))),
            ("candidates", str(payload.get("candidates"))),
            ("active memories deleted", str(payload.get("forgotten"))),
            ("audit persisted", str((payload.get("audit") or {}).get("persisted")).lower()),
        ]
        y = 445
        for label, value in rows:
            draw.text((x0 + 45, y), label, font=font(24), fill="#9ab2a8")
            draw.text((x1 - 45, y), value, anchor="ra", font=font(26, bold=True), fill="#dff8ee")
            y += 58
        draw.text((x0 + 45, 765), outcome, font=font(26, bold=True), fill="#6ee7b7")

    audit = confirmed.get("audit") or {}
    reason = str(audit.get("reason") or "")
    draw.text((80, 910), "Reason", font=font(19, bold=True), fill="#779388")
    draw.text((170, 906), reason, font=font(23), fill="#d5eee4")
    proof_line = (
        f"Protected during evidenced deletion · post-proof cleanup applied · exact-prefix residue "
        f"{evidence.get('uniquePrefixResidue')}"
    )
    draw.text((80, 950), proof_line, font=font(21, bold=True), fill="#6ee7b7")
    draw.text((80, 995), f"{base_url} · exact runtime {expected_sha[:12]} · {observed_at}", font=font(20), fill="#87a096")
    save_dual_submission_frame(canvas, output)


def sanitize_alibaba_capture(raw_input: Path, profile_path: Path) -> Image.Image:
    profile = load_json(profile_path, "Alibaba redaction profile")
    require(isinstance(profile, dict), "Alibaba redaction profile must be an object")
    expected_hash = str(profile.get("sourceSha256", "")).lower()
    require(re.fullmatch(r"[0-9a-f]{64}", expected_hash) is not None, "Alibaba profile has no reviewed source SHA-256")
    require(sha256_file(raw_input) == expected_hash, "Alibaba capture differs from the human-reviewed redaction profile")

    image = Image.open(raw_input).convert("RGB")
    dimensions = profile.get("sourceDimensions")
    require(dimensions == [image.width, image.height], "Alibaba capture dimensions differ from the reviewed profile")
    crop = profile.get("safeCrop")
    require(isinstance(crop, list) and len(crop) == 4 and all(isinstance(v, int) for v in crop), "Alibaba safeCrop is invalid")
    x0, y0, x1, y1 = crop
    require(0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height, "Alibaba safeCrop escapes the source image")

    required_labels = {"instance-id", "instance-name", "public-ip"}
    covered: set[str] = set()
    draw = ImageDraw.Draw(image)
    redactions = profile.get("redactions")
    require(isinstance(redactions, list), "Alibaba redactions must be a list")
    for item in redactions:
        require(isinstance(item, dict), "Alibaba redaction entry must be an object")
        label = str(item.get("label", ""))
        box = item.get("box")
        require(isinstance(box, list) and len(box) == 4 and all(isinstance(v, int) for v in box), "Alibaba redaction box is invalid")
        bx0, by0, bx1, by1 = box
        require(0 <= bx0 < bx1 <= image.width and 0 <= by0 < by1 <= image.height, "Alibaba redaction box escapes the source image")
        covered.add(label)
        draw.rounded_rectangle((bx0, by0, bx1, by1), radius=7, fill="#101b22", outline="#f97316", width=2)
        label_text = str(item.get("replacement", "REDACTED"))
        draw.text(((bx0 + bx1) // 2, (by0 + by1) // 2), label_text, anchor="mm", font=font(13, bold=True), fill="#ffffff")
    require(required_labels.issubset(covered), "Alibaba profile does not cover every required identifier class")

    sanitized = image.crop((x0, y0, x1, y1))
    intermediate = PRIVATE / "alibaba-ecs-overview-sanitized.png"
    strip_and_save(sanitized, intermediate)
    return sanitized


def render_alibaba_card(
    output: Path,
    sanitized_console: Image.Image,
    probes: dict[str, Any],
    *,
    base_url: str,
    expected_sha: str,
    observed_at: str,
) -> None:
    health = probes["health"]
    canvas = Image.new("RGB", CANVAS, "#0d1117")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 10), fill="#ff6a00")
    draw.text((80, 58), "SANITIZED ALIBABA CLOUD RUNTIME PROOF", font=font(24, bold=True), fill="#ff8a3d")
    draw.text((80, 104), "One active ECS runtime. Exact source. Real Qwen.", font=font(52, bold=True), fill="#f8fbff")
    draw.text((82, 177), "Account, instance, host-name and raw IP identifiers are deliberately removed; qualifying facts remain visible.", font=font(26), fill="#9eabb8")

    rounded(draw, (65, 270, 1245, 875), "#151b23", radius=28, outline="#394350", width=2)
    console_panel = fit_source(sanitized_console, (85, 290, 1225, 855), "#ffffff")
    canvas.paste(console_panel, (85, 290))

    rounded(draw, (1280, 270, 1855, 875), "#151b23", radius=28, outline="#5c3a25", width=2)
    draw.text((1320, 310), "VERIFIED RELEASE", font=font(22, bold=True), fill="#ff8a3d")
    facts = [
        ("Runtime source", expected_sha[:12]),
        ("Region", "Singapore"),
        ("Public path", "HTTPS reverse proxy"),
        ("Backend", "loopback-only container"),
        ("Memory store", "self-hosted PostgreSQL + pgvector"),
        ("Embedding", str(health["embedder"])),
        ("Narration / judge", f"{health['narrator']} / {health['judge']}"),
        ("Readiness", "database · Qwen · auth ready"),
    ]
    y = 375
    for label, value in facts:
        draw.text((1320, y), label.upper(), font=font(16, bold=True), fill="#7f8b98")
        y += 27
        for line in wrap(draw, value, font(24, bold=True), 485)[:2]:
            draw.text((1320, y), line, font=font(24, bold=True), fill="#eef3f8")
            y += 29
        y += 22
    draw.text((80, 938), f"Exact-deploy marker + live /health + /ready · {base_url} · {observed_at}", font=font(22), fill="#9aa8b5")
    save_dual_submission_frame(canvas, output)


def render_architecture_assets(output: Path) -> None:
    with Image.open(ARCHITECTURE) as source:
        video = ImageOps.fit(source.convert("RGB"), CANVAS, method=Image.Resampling.LANCZOS)
    save_dual_submission_frame(video, output)


def render_repository_card(
    raw_path: Path,
    output: Path,
    *,
    repo_url: str,
    remote_main: str,
    observed_at: str,
) -> None:
    composite_live_capture(
        raw_path,
        output,
        eyebrow="Reproducibility",
        title="Public source · MIT license · current main",
        subtitle="The repository landing page is paired with an unauthenticated GitHub API check for public visibility, default branch and license detection.",
        badges=("PUBLIC", "MIT", f"main {remote_main[:12]}"),
        base_url=repo_url,
        expected_sha=remote_main,
        observed_at=observed_at,
        accent="#58a6ff",
        source_label="Repository main",
    )


def browser_capture(
    base_url: str,
    repo_url: str,
    reviewer_token: str,
    expected_sha: str,
    observed_at: str,
    probes: dict[str, Any],
) -> dict[str, Any]:
    base_url = validate_live_origin(base_url)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise GateError("Playwright is required; install the hash-locked requirements/video-demo.lock environment") from exc

    console_errors: list[str] = []
    results: dict[str, Any] = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
            locale="en-US",
            color_scheme="dark",
            ignore_https_errors=False,
            service_workers="block",
        )
        context.add_init_script("try{localStorage.setItem('archon_tour_done','1')}catch(e){}")
        page = context.new_page()
        page.set_default_timeout(90_000)
        page.on("console", lambda message: console_errors.append(message.type) if message.type == "error" else None)

        def guard_live_request(route: Any) -> None:
            request = route.request
            if is_pinned_live_request(request.url, redirected=request.redirected_from is not None):
                route.continue_()
            else:
                route.abort("blockedbyclient")

        # A context route covers this page plus any popup/new page. Service workers
        # are disabled because their network fetches can bypass normal routing, and
        # the Explorer needs no WebSocket transport for this evidence capture.
        context.route("**/*", guard_live_request)
        context.route_web_socket(
            "**/*",
            lambda websocket: websocket.close(code=1008, reason="network destination not permitted"),
        )
        try:
            navigation = page.goto(base_url, wait_until="networkidle")
        except Exception as exc:
            raise GateError("Explorer pinned-origin navigation failed or attempted a redirect") from exc
        require(navigation is not None, "Explorer pinned-origin navigation returned no response")
        require(navigation.request.redirected_from is None, "Explorer navigation attempted a redirect")
        require(is_pinned_live_request(page.url), "Explorer navigation left the pinned live origin")
        page.locator("#model").filter(has_text=EXPECTED_EMBEDDER).wait_for()
        require(page.locator("#judgeToken").get_attribute("type") == "password", "reviewer field is not password-masked")

        # 01 · fresh-session grounded recall.
        page.locator("#company").fill("Northwind Trading")
        page.locator("#question").fill(CANONICAL_RECALL_QUESTION)
        with page.expect_response(lambda response: response.url.endswith("/recall") and response.request.method == "POST") as pending:
            page.locator("#askBtn").click()
        recall_response = pending.value
        require(recall_response.status == 200, "Explorer recall returned a non-200 response")
        recall_request_body = recall_response.request.post_data_json
        require(isinstance(recall_request_body, dict), "Explorer recall request body is not JSON")
        require(
            recall_request_body.get("question") == CANONICAL_RECALL_QUESTION,
            "Explorer recall question drifted from the canonical evidence wording",
        )
        require(
            recall_request_body.get("company") == "Northwind Trading",
            "Explorer recall lost its canonical company scope",
        )
        require(
            recall_request_body.get("limit") == 3,
            "Explorer recall did not send the bounded limit=3 contract",
        )
        recall = recall_response.json()
        require(recall.get("modelId") == EXPECTED_NARRATOR, "Explorer recall did not use qwen-plus")
        require(isinstance(recall.get("answer"), str) and recall["answer"].strip(), "Explorer recall returned no answer")
        require(isinstance(recall.get("citations"), list) and len(recall["citations"]) >= 1, "Explorer recall returned no citations")
        require("[1]" in recall["answer"], "Explorer recall answer omitted the requested [1] citation marker")
        require(
            any(
                isinstance(citation, dict)
                and citation.get("marker") == "[1]"
                and str(citation.get("content", "")).strip()
                for citation in recall["citations"]
            ),
            "Explorer recall answer did not resolve [1] to a non-empty cited memory",
        )
        grounding = recall.get("grounding")
        grounding_result = (
            grounding.get("status"), grounding.get("attempts")
        ) if isinstance(grounding, dict) else (None, None)
        require(
            isinstance(grounding, dict)
            and type(grounding.get("attempts")) is int
            and grounding_result in VALID_GROUNDING_RESULTS,
            "Explorer recall did not pass strict grounding within the bounded two-attempt contract",
        )
        page.locator("#result .cite").first.wait_for()
        raw_recall = PRIVATE / "01-grounded-cross-session-recall-raw.png"
        page.locator("#result").screenshot(path=str(raw_recall), animations="disabled")
        composite_live_capture(
            raw_recall,
            GALLERY / PRIMARY_OUTPUTS[0],
            eyebrow="Fresh session · bounded recall",
            title="Qwen answers from durable memory — with citations",
            subtitle="On original synthetic demo data, a new browser session asks by meaning; pgvector supplies bounded evidence and qwen-plus grounds the answer in numbered sources.",
            badges=("qwen-plus", f"{len(recall['citations'])} citations", f"grounding {grounding['status']}"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )
        write_private_json("01-grounded-cross-session-recall-response.json", recall)
        results["recall"] = recall

        # 03 · public read-only field audit.
        with page.expect_response(lambda response: response.url.endswith("/consistency") and response.request.method == "POST") as pending:
            page.locator("#auditBtn").click()
        field_audit = pending.value.json()
        contradictions = field_audit.get("contradictions") if isinstance(field_audit, dict) else None
        require(isinstance(contradictions, list), "field audit returned no contradiction list")
        target = next((item for item in contradictions if item.get("subject") == "INV-5521"), None)
        require(isinstance(target, dict), "field audit did not surface INV-5521")
        values = {item.get("value") for item in target.get("values", [])}
        require({8400, 8900}.issubset(values), "INV-5521 audit does not contain both canonical values")
        resolution = target.get("resolution")
        require(isinstance(resolution, dict) and resolution.get("recommendedValue") == 8900, "field audit recency recommendation is stale")
        target_locator = page.locator(".audit-flag").filter(has_text="INV-5521").first
        target_locator.wait_for()
        raw_field = PRIVATE / "03-field-audit-raw.png"
        target_locator.screenshot(path=str(raw_field), animations="disabled")
        composite_live_capture(
            raw_field,
            GALLERY / PRIMARY_OUTPUTS[2],
            eyebrow="Read-only self-audit",
            title="Both values stay visible. Policy recommends — never rewrites.",
            subtitle="Original synthetic INV-5521 preserves both sessions' provenance, then recommends the later 8,900 value under the declared recency rule.",
            badges=("INV-5521", "8,400 ↔ 8,900", "read-only"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )
        write_private_json("03-field-audit-response.json", field_audit)
        results["fieldAudit"] = field_audit

        # 04 · protected meaning-level Qwen audit.  The token exists in the input
        # only while the request is in flight, then both field and sessionStorage
        # are cleared before any screenshot is taken.
        page.locator("#judgeToken").fill(reviewer_token)
        with page.expect_response(lambda response: response.url.endswith("/consistency/semantic") and response.request.method == "POST") as pending:
            page.locator("#semanticBtn").click()
        semantic_response = pending.value
        require(semantic_response.status == 200, "semantic audit returned a non-200 response")
        semantic = semantic_response.json()
        require(semantic.get("status") == "complete", "semantic audit is not complete")
        findings = semantic.get("semanticContradictions")
        require(isinstance(findings, list) and findings, "semantic audit found no contradiction")
        semantic_target = next(
            (
                finding for finding in findings
                if "always pays" in " ".join(memory.get("content", "") for memory in finding.get("memories", [])).lower()
                and "chronically late" in " ".join(memory.get("content", "") for memory in finding.get("memories", [])).lower()
            ),
            None,
        )
        require(isinstance(semantic_target, dict), "semantic audit omitted the canonical meaning conflict")
        judge = semantic_target.get("judge")
        require(isinstance(judge, dict) and judge.get("model") == probes["health"]["judge"], "semantic finding has the wrong judge provenance")
        page.locator("#judgeToken").fill("")
        page.evaluate("sessionStorage.removeItem('archon_memory_reviewer_token')")
        require(page.locator("#judgeToken").input_value() == "", "reviewer token remained in the page before capture")
        semantic_locator = page.locator(".audit-flag").filter(has_text="chronically late").first
        semantic_locator.wait_for()
        raw_semantic = PRIVATE / "04-semantic-audit-raw.png"
        semantic_locator.screenshot(path=str(raw_semantic), animations="disabled")
        composite_live_capture(
            raw_semantic,
            GALLERY / PRIMARY_OUTPUTS[3],
            eyebrow="Meaning-level self-audit",
            title="Qwen catches the contradiction metadata rules cannot see",
            subtitle="Original synthetic vendor claims share no numeric field. The configured Qwen judge detects their opposed meaning and returns a read-only recommendation.",
            badges=(str(judge["model"]), f"{semantic.get('compared')} pair compared", "credential absent"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )
        write_private_json("04-semantic-audit-response.json", semantic)
        results["semanticAudit"] = semantic

        # 05 · render the real reviewer-tenant decision controls, then exercise
        # the local Defer path (zero API call, zero mutation) after clearing the
        # credential.  Accept/Override remain visibly separated protected actions.
        page.locator("#judgeToken").fill(reviewer_token)
        with page.expect_response(lambda response: response.url.endswith("/consistency") and response.request.method == "POST"):
            page.locator("#auditBtn").click()
        page.locator("#judgeToken").fill("")
        page.evaluate("sessionStorage.removeItem('archon_memory_reviewer_token')")
        control = page.locator(".audit-flag").filter(has_text="INV-5521").first
        control.locator("button", has_text="Defer — no write").click()
        control.locator(".decision-result").filter(has_text="Zero API call").wait_for()
        require(page.locator("#judgeToken").input_value() == "", "reviewer token remained before control capture")
        raw_control = PRIVATE / "05-human-control-raw.png"
        control.screenshot(path=str(raw_control), animations="disabled")
        composite_live_capture(
            raw_control,
            GALLERY / PRIMARY_OUTPUTS[4],
            eyebrow="Structural human gate",
            title="Accept. Override. Or defer with zero write.",
            subtitle="This capture exercises only Defer: zero API call and zero mutation. Accept/Override remain separately tested protected actions, not a live claim in this frame.",
            badges=("live: Defer only", "zero API call", "Accept/Override not exercised"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )

        # 11 · public repository landing page.  API facts are validated below;
        # the browser capture is the judge-readable visual context.
        repo_page = context.new_page()
        repo_page.set_default_timeout(90_000)
        repo_page.goto(repo_url, wait_until="domcontentloaded")
        repo_page.locator("body").wait_for()
        require("archon-qwen-memoryagent" in repo_page.title().lower(), "public repository landing page did not load")
        raw_repo = PRIVATE / "11-public-repository-raw.png"
        repo_page.screenshot(path=str(raw_repo), animations="disabled")
        results["repoRaw"] = raw_repo
        repo_page.close()

        require(not console_errors, "Explorer emitted browser-console errors during canonical capture")
        context.close()
        browser.close()
    return results


def contained_browser_capture(*args: Any, **kwargs: Any) -> dict[str, Any]:
    """Keep browser profile/temp/cache scratch inside the ignored project tree."""
    scratch = PRIVATE / "browser-runtime"
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)
    keys = ("TMP", "TEMP", "TMPDIR")
    previous = {key: os.environ.get(key) for key in keys}
    for key in keys:
        os.environ[key] = str(scratch)
    try:
        return browser_capture(*args, **kwargs)
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        for attempt in range(3):
            try:
                if scratch.exists():
                    shutil.rmtree(scratch)
                break
            except PermissionError:
                if attempt == 2:
                    raise GateError("project-local browser scratch could not be removed")
                time.sleep(0.2)


def enforce_private_scratch_budget(limit_bytes: int = 256 * 1024 * 1024) -> None:
    total = sum(path.stat().st_size for path in PRIVATE.rglob("*") if path.is_file())
    require(total <= limit_bytes, "ignored private capture scratch exceeds the 256 MiB budget")


def github_public_probe(repo_url: str) -> dict[str, Any]:
    parsed = urlparse.urlparse(repo_url)
    parts = [part for part in parsed.path.split("/") if part]
    require(parsed.hostname == "github.com" and len(parts) == 2, "repository URL must be a canonical github.com owner/repo URL")
    api_url = f"https://api.github.com/repos/{parts[0]}/{parts[1]}"
    req = urlrequest.Request(api_url, headers={"Accept": "application/vnd.github+json", "User-Agent": "Archon-MemoryAgent-Media-Gate/1.0"})
    try:
        with urlrequest.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urlerror.URLError, urlerror.HTTPError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError("unauthenticated GitHub repository probe failed") from exc
    require(data.get("private") is False, "GitHub repository is not public")
    require(data.get("default_branch") == "main", "GitHub default branch is not main")
    license_info = data.get("license")
    require(isinstance(license_info, dict) and license_info.get("spdx_id") == "MIT", "GitHub does not detect the MIT license")
    safe = {
        "html_url": data.get("html_url"),
        "private": data.get("private"),
        "default_branch": data.get("default_branch"),
        "license": {"spdx_id": license_info.get("spdx_id")},
        "pushed_at": data.get("pushed_at"),
    }
    write_private_json("11-github-public-probe.json", safe)
    return safe


def feedback_persistence_and_lifecycle_proof(
    base_url: str,
    reviewer_token: str,
    probes: dict[str, Any],
) -> dict[str, Any]:
    """Create, recall, retire and scrub one synthetic feedback marker.

    Existing protected contracts are used throughout: strict invoice ingestion,
    explicit feedback, authenticated fresh recall and preview/confirm forgetting.
    The inevitable final correction is a prefix-free cleanup placeholder in a
    unique sandbox company; repeated or concurrent runs therefore cannot select
    each other's rows and leave no evidence marker or superseded candidate. No
    baseline demo row is selected or mutated.
    """
    run_stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S")
    run_slug = f"{run_stamp.lower()}-{secrets.token_hex(4)}"
    marker = f"MFP-{run_stamp}-{secrets.token_hex(3).upper()}"
    company = f"Submission Evidence Sandbox {run_slug}"
    preference_display = "Present true employer cost before net cash, and cite the stored source."
    preference_fact = f"{marker}: Reviewer preference — {preference_display}"
    cleanup_fact = "Submission evidence cleanup placeholder; no business claim and no run marker."
    original_id: str | None = None
    corrected_id: str | None = None
    proof: dict[str, Any] = {}
    primary_error: Exception | None = None
    cleanup_error: Exception | None = None

    # Refuse to contaminate the one-candidate lifecycle proof with residue from a
    # prior interrupted attempt. Dry-run does not claim or persist an operation.
    preflight, _ = request_json(
        "POST", base_url, "/forget",
        body={
            "company": company,
            "deleteSuperseded": True,
            "operationId": f"media-preflight-{run_slug}",
            "reason": "Submission evidence preflight: sandbox has no superseded retention candidates",
        },
        reviewer_token=reviewer_token,
    )
    require(preflight.get("dryRun") is True and preflight.get("candidates") == 0, "sandbox contains prior superseded evidence residue")
    before_list = reviewer_company_list(base_url, reviewer_token, company)
    require(marker not in json.dumps(before_list, sort_keys=True), "feedback marker already exists before Session A")

    try:
        ingested, _ = request_json(
            "POST", base_url, "/ingest/invoice",
            body={
                "invoice": {
                    "type": "purchase",
                    "company": company,
                    "period": "2026-06",
                    "date": "2026-06-30",
                    "currency": "EUR",
                    "total": 8400,
                    "invoice_ref": marker,
                    "vendor": "Original Synthetic Vendor",
                    "status": "unpaid",
                },
            },
            reviewer_token=reviewer_token,
            timeout=120,
        )
        require(isinstance(ingested, dict) and ingested.get("written") == 1, "Session A synthetic invoice was not written exactly once")
        original_id = ingested.get("id")
        require(isinstance(original_id, str) and original_id, "Session A response omitted its memory id")

        feedback, _ = request_json(
            "POST", base_url, "/feedback",
            body={
                "memoryId": original_id,
                "outcome": "incorrect",
                "correctedFact": preference_fact,
                "feedbackId": f"media-feedback-{run_slug}",
            },
            reviewer_token=reviewer_token,
            timeout=120,
        )
        corrected_id = feedback.get("correctedMemoryId") if isinstance(feedback, dict) else None
        require(isinstance(corrected_id, str) and corrected_id, "Session A feedback produced no durable correction")
        require(feedback.get("memoryId") == original_id and feedback.get("outcome") == "incorrect", "Session A feedback provenance is incomplete")
        require((feedback.get("after") or {}).get("supersededBy") == corrected_id, "Session A did not supersede the original fact atomically")

        # request_json constructs a new request with no client-side session state.
        # Only the reviewer credential and question cross this Session-B boundary.
        recall, _ = request_json(
            "POST", base_url, "/recall",
            body={
                "question": f"{marker}: apply the stored reviewer preference. Which workforce-cost figure should appear first?",
                "company": company,
                "limit": 5,
                "hybrid": True,
                "rerank": True,
            },
            reviewer_token=reviewer_token,
            timeout=150,
        )
        hits = recall.get("hits") if isinstance(recall, dict) else None
        require(isinstance(hits, list) and any(hit.get("id") == corrected_id for hit in hits if isinstance(hit, dict)), "fresh Session B did not recall the persisted correction")
        citations = recall.get("citations")
        require(isinstance(citations, list) and any(marker in str(citation.get("content", "")) for citation in citations if isinstance(citation, dict)), "fresh Session B answer did not cite the persisted preference")
        answer = recall.get("answer")
        require(recall.get("modelId") == EXPECTED_NARRATOR and isinstance(answer, str), "fresh Session B did not return a qwen-plus answer")
        normalized_answer = answer.casefold()
        require(
            "employer" in normalized_answer and "cost" in normalized_answer,
            "fresh Session B cited the correction but did not identify employer cost as the requested first figure",
        )

        protected, _ = request_json(
            "POST", base_url, "/feedback",
            body={
                "memoryId": corrected_id,
                "outcome": "correct",
                "feedbackId": f"media-protect-{run_slug}",
            },
            reviewer_token=reviewer_token,
        )
        require(protected.get("outcome") == "correct" and protected.get("correctedMemoryId") is None, "protected correction proof returned the wrong result")

        operation_id = f"media-lifecycle-{run_slug}"
        reason = "Submission proof: delete one feedback-superseded original synthetic fact"
        lifecycle_payload = {
            "company": company,
            "deleteSuperseded": True,
            "operationId": operation_id,
            "reason": reason,
        }
        preview, _ = request_json("POST", base_url, "/forget", body=lifecycle_payload, reviewer_token=reviewer_token)
        require(preview.get("dryRun") is True and preview.get("candidates") == 1 and preview.get("forgotten") == 0, "lifecycle preview did not select exactly one superseded synthetic row")
        require(isinstance(preview.get("audit"), dict) and preview["audit"].get("persisted") is False, "lifecycle preview unexpectedly persisted an operation")

        confirmed, _ = request_json(
            "POST", base_url, "/forget", body={**lifecycle_payload, "confirm": True}, reviewer_token=reviewer_token
        )
        require(confirmed.get("dryRun") is False and confirmed.get("candidates") == 1 and confirmed.get("forgotten") == 1, "lifecycle confirmation did not delete exactly one row")
        audit = confirmed.get("audit")
        require(isinstance(audit, dict) and audit.get("persisted") is True, "confirmed lifecycle operation was not audited")
        require(audit.get("operationId") == operation_id and audit.get("reason") == reason, "lifecycle provenance is incomplete")

        still_active = reviewer_company_list(base_url, reviewer_token, company)
        require(any(item.get("id") == corrected_id for item in still_active["items"] if isinstance(item, dict)), "protected correction changed during lifecycle deletion")
        pnl_path = "/pnl?" + urlparse.urlencode({"company": "Northwind Trading"})
        seed_after, _ = request_json("GET", base_url, pnl_path, reviewer_token=reviewer_token)
        for key in ("currency", "employer_cost_total", "revenue_total", "net_profit", "unknown_currency_records"):
            require(seed_after.get(key) == probes["reviewerPnl"].get(key), f"protected reviewer seed changed at {key}")

        proof = {
            "status": "passed",
            "preferenceDisplay": preference_display,
            "sessionA": {
                "feedbackPersisted": True,
                "originalSuperseded": True,
                "correctedMemoryId": corrected_id,
            },
            "sessionB": {
                "freshRequest": True,
                "correctedMemoryRecalled": True,
                "preferenceApplied": True,
                "answer": recall["answer"],
                "citationCount": len(citations),
                "modelId": recall["modelId"],
            },
            "learningBoundary": "explicit persisted feedback; no model-weight update",
            "lifecycle": {
                "retentionBasis": "feedback-superseded original synthetic fact",
                "preview": preview,
                "confirmed": confirmed,
                "protectedSeedUnchanged": True,
                "protectedCorrectionUnchanged": True,
            },
        }
        write_private_json("02-session-a-ingest-response.json", ingested)
        write_private_json("02-session-a-feedback-response.json", feedback)
        write_private_json("02-session-b-recall-response.json", recall)
        write_private_json("06-lifecycle-preview.json", preview)
        write_private_json("06-lifecycle-confirmed.json", confirmed)
    except Exception as exc:  # cleanup below is mandatory even on a failed proof
        primary_error = exc
    finally:
        try:
            active_id = corrected_id or original_id
            if active_id is not None:
                cleanup_feedback, _ = request_json(
                    "POST", base_url, "/feedback",
                    body={
                        "memoryId": active_id,
                        "outcome": "incorrect",
                        "correctedFact": cleanup_fact,
                        "feedbackId": f"media-clean-feedback-{run_slug}",
                    },
                    reviewer_token=reviewer_token,
                    timeout=120,
                )
                require(isinstance(cleanup_feedback.get("correctedMemoryId"), str), "cleanup feedback did not create its prefix-free placeholder")
                cleanup_payload = {
                    "company": company,
                    "deleteSuperseded": True,
                    "operationId": f"media-clean-forget-{run_slug}",
                    "reason": "Submission evidence cleanup: remove all superseded run-marked rows",
                }
                cleanup_preview, _ = request_json("POST", base_url, "/forget", body=cleanup_payload, reviewer_token=reviewer_token)
                cleanup_candidates = cleanup_preview.get("candidates")
                require(isinstance(cleanup_candidates, int) and cleanup_candidates >= 1, "cleanup preview found no superseded evidence rows")
                cleanup_confirmed, _ = request_json(
                    "POST", base_url, "/forget", body={**cleanup_payload, "confirm": True}, reviewer_token=reviewer_token
                )
                require(cleanup_confirmed.get("forgotten") == cleanup_candidates, "cleanup did not delete every superseded evidence row")
            after_list = reviewer_company_list(base_url, reviewer_token, company)
            require(marker not in json.dumps(after_list, sort_keys=True), "feedback/lifecycle marker remains in active reviewer memory")
            if proof:
                proof["lifecycle"]["uniquePrefixResidue"] = 0
                proof["lifecycle"]["postProofCleanupApplied"] = True
                proof["cleanup"] = {
                    "status": "passed",
                    "uniquePrefixResidue": 0,
                    "prefixFreePlaceholder": active_id is not None,
                }
        except Exception as exc:
            cleanup_error = exc

    if primary_error is not None:
        if cleanup_error is not None:
            raise GateError("feedback proof failed and mandatory exact-prefix cleanup also failed") from primary_error
        raise primary_error
    if cleanup_error is not None:
        raise GateError("feedback proof passed but mandatory exact-prefix cleanup failed") from cleanup_error
    require(bool(proof), "feedback persistence proof produced no evidence")
    write_private_json("02-feedback-persistence-lifecycle-proof.json", proof)
    return proof


def format_srt_time(seconds: float) -> str:
    require(seconds >= 0, "SRT time cannot be negative")
    millis = int(round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def parse_measured_windows(path: Path) -> list[tuple[float, float, str]]:
    raw = load_json(path, "caption windows")
    require(isinstance(raw, list) and raw, "caption windows must be a non-empty array")
    rows: list[tuple[float, float, str]] = []
    previous_end = 0.0
    for row in raw:
        require(isinstance(row, list) and len(row) == 3, "caption window has the wrong shape")
        start, end, text = row
        require(isinstance(start, (int, float)) and isinstance(end, (int, float)), "caption time is not numeric")
        require(isinstance(text, str) and text.strip(), "caption text is empty")
        start_f, end_f = float(start), float(end)
        require(start_f >= previous_end - 0.001 and end_f > start_f, "caption windows are not monotonic")
        rows.append((start_f, end_f, text.strip()))
        previous_end = end_f
    return rows


def parse_canonical_captions(path: Path, *, title_offset: float = 3.0) -> list[tuple[float, float, str]]:
    rows: list[tuple[float, float, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        parts = line.split("|", 2)
        require(len(parts) == 3, "canonical caption line has the wrong shape")
        rows.append((float(parts[0]) + title_offset, float(parts[1]) + title_offset, parts[2].strip()))
    require(rows, "canonical caption file is empty")
    return rows


def emit_srt(
    output: Path,
    *,
    measured_windows: Path | None,
    allow_canonical_fallback: bool,
    video_manifest: Path | None,
    web_narration: Path | None,
) -> str:
    if measured_windows is not None:
        rows = parse_measured_windows(measured_windows)
        source = "measured-caption-windows"
    else:
        require(allow_canonical_fallback, "final SRT requires --caption-windows; use --allow-canonical-caption-fallback only for an explicit draft")
        rows = parse_canonical_captions(REPO / "scripts" / "captions.txt")
        source = "canonical-unmeasured-draft"

    if video_manifest is not None or web_narration is not None:
        require(video_manifest is not None and web_narration is not None, "web narration timing requires both --video-manifest and --web-narration")
        manifest = load_json(video_manifest, "video manifest")
        require(isinstance(manifest, dict), "video manifest must be an object")
        title = float(manifest.get("title_dur"))
        screencast = float(manifest.get("screencast_dur"))
        web_duration = float(manifest.get("web_dur"))
        web_audio = float(manifest.get("a_web"))
        narration = web_narration.read_text(encoding="utf-8").strip()
        require(narration and web_duration >= web_audio > 0, "measured web narration timing is invalid")
        web_start = title + screencast + 0.5
        web_end = min(title + screencast + web_duration, web_start + web_audio)
        require(web_start >= rows[-1][1] - 0.05 and web_end > web_start, "web narration overlaps measured caption windows")
        rows.append((web_start, web_end, narration))
        source += "+measured-web-beat"

    require(rows[-1][1] < 175.0, "subtitle timeline reaches the 175-second publication ceiling")

    blocks: list[str] = []
    for index, (start, end, text) in enumerate(rows, start=1):
        clean_text = BEARER.sub("[REMOVED]", EMAIL.sub("[REMOVED]", text))
        require(clean_text == text, "subtitle text contains secret-shaped content")
        blocks.append(f"{index}\n{format_srt_time(start)} --> {format_srt_time(end)}\n{text}\n")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(blocks), encoding="utf-8", newline="\n")
    require(output.stat().st_size > 50, "generated SRT is unexpectedly small")
    return source


def render_youtube_thumbnail(field_audit_image: Path, output: Path) -> None:
    source = Image.open(field_audit_image).convert("RGB")
    background = ImageOps.fit(source, (1280, 720), method=Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(5))
    overlay = Image.new("RGBA", (1280, 720), (3, 13, 10, 175))
    canvas = Image.alpha_composite(background.convert("RGBA"), overlay)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1280, 9), fill="#35d399")
    rounded(draw, (58, 48, 255, 96), "#103628", radius=22, outline="#35d399", width=2)
    draw.text((156, 72), "QWEN CLOUD", anchor="mm", font=font(20, bold=True), fill="#cffff0")
    draw.text((58, 135), "MEMORY", font=font(74, bold=True), fill="#ffffff")
    draw.text((58, 215), "THAT AUDITS", font=font(74, bold=True), fill="#ffffff")
    draw.text((58, 295), "ITSELF", font=font(74, bold=True), fill="#35d399")
    draw.text((61, 397), "Cross-session contradiction", font=font(29, bold=True), fill="#c0d5cc")
    rounded(draw, (58, 456, 305, 551), "#16251f", radius=22, outline="#637c71", width=2)
    rounded(draw, (332, 456, 579, 551), "#17372a", radius=22, outline="#35d399", width=2)
    draw.text((181, 504), "€8,400", anchor="mm", font=font(46, bold=True), fill="#f6fff9")
    draw.text((455, 504), "€8,900", anchor="mm", font=font(46, bold=True), fill="#86efc1")
    draw.text((318, 583), "RECOMMEND · DON'T REWRITE", anchor="mm", font=font(23, bold=True), fill="#a8c0b6")

    # A crisp crop of the real final field-audit composite anchors the right side.
    panel = ImageOps.fit(source, (570, 520), method=Image.Resampling.LANCZOS, centering=(0.58, 0.58))
    rounded(draw, (650, 105, 1242, 647), "#0a1713", radius=28, outline="#3e6d5a", width=3)
    canvas.alpha_composite(panel.convert("RGBA"), (661, 116))
    rounded(draw, (1010, 48, 1225, 96), "#9f1c1c", radius=22)
    draw.text((1118, 72), "LIVE PROOF", anchor="mm", font=font(20, bold=True), fill="#ffffff")
    strip_and_save(canvas.convert("RGB"), output, size=(1280, 720))


def scan_text_for_secrets(text: str, expected_sha: str, base_url: str) -> None:
    normalized = text.replace(expected_sha, "[EXPECTED_SHA]").replace(base_url, "[BASE_URL]")
    require(BEARER.search(normalized) is None, "generated text contains a Bearer credential")
    require(EMAIL.search(normalized) is None, "generated text contains an email address")
    require(PRIVATE_IPV4.search(normalized) is None, "generated text contains a private IPv4 address")


def verify_outputs(expected_sha: str, base_url: str) -> dict[str, str]:
    required = [GALLERY / name for name in (*PRIMARY_OUTPUTS, *SECONDARY_OUTPUTS)]
    required.extend([ARCHITECTURE, FINAL_MEDIA / "youtube-thumbnail.png", FINAL_MEDIA / "memoryagent-demo.en.srt"])
    required.extend(PROOF_FRAMES / f"{Path(name).stem}-16x9.png" for name in (*PRIMARY_OUTPUTS, *SECONDARY_OUTPUTS))
    hashes: dict[str, str] = {}
    for path in required:
        require(path.is_file(), f"required output {path.relative_to(REPO)} is missing")
        if path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            with Image.open(path) as image:
                if path.name == "youtube-thumbnail.png":
                    require(image.size == (1280, 720), "YouTube thumbnail is not 1280×720")
                elif path == ARCHITECTURE:
                    require(image.size[0] >= 1600 and image.size[1] >= 900, "architecture image is below 1600×900")
                elif path.parent == PROOF_FRAMES:
                    require(image.size == CANVAS, f"{path.name} is not a 1920×1080 video proof frame")
                else:
                    require(image.size == GALLERY_CANVAS, f"{path.name} is not a 1500×1000 Devpost gallery final")
        if path.suffix.lower() == ".srt":
            scan_text_for_secrets(path.read_text(encoding="utf-8"), expected_sha, base_url)
        hashes[str(path.relative_to(REPO)).replace("\\", "/")] = sha256_file(path)

    tracked_private = git("ls-files", "demo/private-originals")
    require(not tracked_private, "demo/private-originals contains tracked files")
    return hashes


def write_review_manifest(
    *,
    expected_sha: str,
    remote_main: str,
    exact_deploy_evidence_mode: str,
    deployment_producer: dict[str, str | int],
    deployment_output: ProjectFileSnapshot,
    deployment_status: ProjectFileSnapshot,
    base_url: str,
    observed_at: str,
    probes: dict[str, Any],
    feedback_proof: dict[str, Any],
    vision_canary: dict[str, Any],
    hashes: dict[str, str],
    srt_source: str,
) -> None:
    manifest = {
        "schemaVersion": 3,
        "status": "passed",
        "capturedAt": observed_at,
        "liveBaseUrl": base_url,
        "exactRuntimeSource": expected_sha,
        "submissionPackHeadAtCapture": remote_main,
        "deploymentEvidence": {
            "mode": exact_deploy_evidence_mode,
            "producer": deployment_producer,
            "status": {
                "path": deployment_status.relative_path,
                "sha256": deployment_status.sha256,
                "size": deployment_status.size,
            },
            "output": {
                "path": deployment_output.relative_path,
                "sha256": deployment_output.sha256,
                "size": deployment_output.size,
            },
        },
        "models": {
            "embedder": probes["health"]["embedder"],
            "narrator": probes["health"]["narrator"],
            "judge": probes["health"]["judge"],
            "vision": vision_canary["modelId"],
            "embedDim": probes["health"]["embedDim"],
        },
        "gates": {
            "exactDeploymentEvidence": True,
            "exactDeploymentEvidenceMode": exact_deploy_evidence_mode,
            "publicHealthReady": True,
            "authenticatedDeepReadiness": True,
            "publicSeedIdempotent": True,
            "selectedCompanyPnl": True,
            "qwenVlOriginalSyntheticDryRun": {
                "modelIdReported": vision_canary["modelId"],
                "written": vision_canary["written"],
                "reviewerCountUnchanged": vision_canary["reviewerCountBefore"] == vision_canary["reviewerCountAfter"],
                "uniquePrefixResidue": vision_canary["uniquePrefixResidue"],
            },
            "feedbackPersistence": {
                "sessionAStoredCorrection": feedback_proof["sessionA"]["feedbackPersisted"],
                "freshSessionBRecalledCorrection": feedback_proof["sessionB"]["correctedMemoryRecalled"],
                "freshSessionBAppliedPreference": feedback_proof["sessionB"]["preferenceApplied"],
                "boundary": feedback_proof["learningBoundary"],
            },
            "lifecycleOneRow": {
                "retentionBasis": feedback_proof["lifecycle"]["retentionBasis"],
                "previewCandidates": feedback_proof["lifecycle"]["preview"]["candidates"],
                "confirmedForgotten": feedback_proof["lifecycle"]["confirmed"]["forgotten"],
                "protectedSeedUnchanged": feedback_proof["lifecycle"]["protectedSeedUnchanged"],
                "protectedCorrectionUnchanged": feedback_proof["lifecycle"]["protectedCorrectionUnchanged"],
                "postProofCleanupApplied": feedback_proof["lifecycle"]["postProofCleanupApplied"],
                "uniquePrefixResidue": feedback_proof["lifecycle"]["uniquePrefixResidue"],
            },
            "humanControlCapture": "Defer-only live proof; Accept/Override are not claimed by this frame",
            "reviewerCredentialRendered": False,
            "rawCapturesTracked": False,
            "alibabaProfileShaBound": True,
        },
        "subtitleTimingSource": srt_source,
        "architecture": {
            "sourcePath": "docs/judge-architecture.svg",
            "sourceSha256": sha256_file(REPO / "docs" / "judge-architecture.svg"),
            "rasterPath": "demo/final-media/judge-architecture.jpg",
            "rasterSha256": hashes["demo/final-media/judge-architecture.jpg"],
        },
        "artifacts": hashes,
    }
    path = GALLERY / "CAPTURE_REVIEW.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def self_test() -> int:
    root = project_path(".artifacts/media-pipeline-selftest", "self-test output")
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    evidence_sha = "1" * 40
    evidence_status_base = {
        "memorySha": evidence_sha,
        "status": "Success",
        "terminal": True,
        "exitCode": 0,
        "outputCaptured": True,
        "projectContained": True,
        "invocationId": "invoke-media-pipeline-selftest",
        "commandId": "command-media-pipeline-selftest",
    }
    marker_prefix = (
        f"EXACT_CHECKOUT_OK app=memoryagent sha={evidence_sha}\n"
        f"EXACT_APP_DEPLOY_OK app=memoryagent sha={evidence_sha}\n"
    )
    def bound_status(output: str, **overrides: Any) -> dict[str, Any]:
        raw = output.encode("utf-8")
        return {
            **evidence_status_base,
            "outputSha256": hashlib.sha256(raw).hexdigest(),
            "outputBytes": len(raw),
            **overrides,
        }

    autopilot_sha = "a" * 40
    strict_output = marker_prefix + f"EXACT_DEPLOY_SUCCESS memory={evidence_sha} autopilot={autopilot_sha}\n"
    require(
        validate_exact_deploy_evidence(
            evidence_sha,
            bound_status(strict_output),
            strict_output,
        ) == STRICT_FINAL_MARKER,
        "strict final-marker evidence self-test failed",
    )
    require(
        validate_exact_deploy_evidence(evidence_sha, bound_status(marker_prefix), marker_prefix)
        == TERMINAL_SUCCESS_TRUNCATED_OUTPUT,
        "terminal-success truncated-output evidence self-test failed",
    )
    rejected = False
    try:
        conflicting_output = marker_prefix + f"EXACT_DEPLOY_SUCCESS memory={'2' * 40} autopilot={autopilot_sha}\n"
        validate_exact_deploy_evidence(evidence_sha, bound_status(conflicting_output), conflicting_output)
    except GateError:
        rejected = True
    require(rejected, "exact-deploy evidence self-test accepted a conflicting final marker")
    rejected = False
    try:
        validate_exact_deploy_evidence(evidence_sha, bound_status(marker_prefix, terminal=False), marker_prefix)
    except GateError:
        rejected = True
    require(rejected, "exact-deploy evidence self-test accepted a non-terminal truncation fallback")

    raw = Image.new("RGB", (900, 500), "#10251f")
    draw = ImageDraw.Draw(raw)
    draw.text((55, 60), "SYNTHETIC SELF-TEST — NOT LIVE EVIDENCE", font=font(34, bold=True), fill="#ffffff")
    draw.text((55, 140), "Qwen · pgvector · citations [1] [2]", font=font(28), fill="#8ee8bd")
    raw_path = root / "raw.png"
    strip_and_save(raw, raw_path, min_bytes=1_000)
    output = root / "composite.png"
    composite_live_capture(
        raw_path,
        output,
        eyebrow="Pipeline self-test",
        title="Layout and metadata gate",
        subtitle="Synthetic fixture. This file is ignored and cannot be used as live evidence.",
        badges=("SELF-TEST", "NOT LIVE"),
        base_url=DEFAULT_BASE_URL,
        expected_sha="0" * 40,
        observed_at="2000-01-01T00:00:00Z",
        dual_submission=False,
    )
    windows = root / "windows.json"
    windows.write_text(json.dumps([[3.0, 5.0, "Synthetic caption"], [5.0, 7.5, "Second caption"]]), encoding="utf-8")
    srt = root / "test.srt"
    source = emit_srt(srt, measured_windows=windows, allow_canonical_fallback=False, video_manifest=None, web_narration=None)
    require(source == "measured-caption-windows" and "00:00:03,000" in srt.read_text(encoding="utf-8"), "SRT self-test failed")
    require(output.is_file() and Image.open(output).size == CANVAS, "composite self-test failed")
    gallery_fixture = root / "gallery-3x2.png"
    video_fixture = root / "proof-16x9.png"
    save_dual_submission_frame(Image.open(output), gallery_fixture, proof_output=video_fixture)
    require(Image.open(gallery_fixture).size == GALLERY_CANVAS, "3:2 mapping self-test failed")
    require(Image.open(video_fixture).size == CANVAS, "16:9 mapping self-test failed")
    probes = {
        "health": {
            "status": "ok", "embedder": EXPECTED_EMBEDDER, "narrator": EXPECTED_NARRATOR,
            "judge": EXPECTED_NARRATOR, "embedDim": EXPECTED_DIMENSION,
        },
        "deep": {
            "cached": True,
            "checks": {"embedder": {"status": "operational"}, "narrator": {"grounding": "passed"}},
        },
    }
    health_fixture = root / "health-3x2.png"
    render_health_card(
        health_fixture, probes,
        base_url=DEFAULT_BASE_URL, expected_sha="0" * 40, observed_at="2000-01-01T00:00:00Z",
    )
    lifecycle_fixture = root / "lifecycle-3x2.png"
    audit_preview = {
        "dryRun": True, "scanned": 4, "candidates": 1, "forgotten": 0,
        "audit": {"persisted": False, "reason": "synthetic self-test"},
    }
    audit_confirmed = {
        "dryRun": False, "scanned": 4, "candidates": 1, "forgotten": 1,
        "audit": {"persisted": True, "reason": "synthetic self-test"},
    }
    render_lifecycle_card(
        lifecycle_fixture, audit_preview, audit_confirmed,
        {"uniquePrefixResidue": 0},
        base_url=DEFAULT_BASE_URL, expected_sha="0" * 40, observed_at="2000-01-01T00:00:00Z",
    )
    vision_fixture = root / "vision-3x2.png"
    vision_proof = {
        "modelId": EXPECTED_VISION, "events": 1, "written": 0,
        "reviewerCountBefore": 7, "reviewerCountAfter": 7,
    }
    render_vision_canary_card(
        vision_fixture, vision_proof,
        base_url=DEFAULT_BASE_URL, expected_sha="0" * 40, observed_at="2000-01-01T00:00:00Z",
    )
    feedback_fixture = root / "feedback-3x2.png"
    render_feedback_persistence_card(
        feedback_fixture,
        {
            "preferenceDisplay": "Present employer cost before net cash and cite the stored source.",
            "sessionB": {
                "answer": "The stored reviewer preference says employer cost should appear first [1].",
                "citationCount": 1,
                "modelId": EXPECTED_NARRATOR,
            },
        },
        base_url=DEFAULT_BASE_URL, expected_sha="0" * 40, observed_at="2000-01-01T00:00:00Z",
    )
    canary_pages = [
        synthetic_vision_document("MVLSELFTEST", "payroll_register"),
        synthetic_vision_document("MVLSELFTEST", "bank_confirmation"),
    ]
    require(all(page.startswith("data:image/png;base64,") for page in canary_pages), "synthetic vision document self-test failed")
    render_youtube_thumbnail(gallery_fixture, root / "youtube-thumbnail.png")
    require(Image.open(health_fixture).size == GALLERY_CANVAS, "health-card self-test failed")
    require(Image.open(lifecycle_fixture).size == GALLERY_CANVAS, "lifecycle-card self-test failed")
    require(Image.open(vision_fixture).size == GALLERY_CANVAS, "vision-card self-test failed")
    require(Image.open(feedback_fixture).size == GALLERY_CANVAS, "feedback-card self-test failed")
    require(Image.open(root / "youtube-thumbnail.png").size == (1280, 720), "YouTube thumbnail self-test failed")
    print("media pipeline self-test: PASS (ignored project-contained fixtures only)")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run offline compositor/path/SRT checks only")
    parser.add_argument("--expected-sha", help="40-character exact deployed MemoryAgent source SHA")
    parser.add_argument("--deployment-output", help="repo-contained exact deploy decoded output")
    parser.add_argument("--deployment-status", help="repo-contained sanitized exact deploy status JSON")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--repo-url", default=DEFAULT_REPO_URL)
    parser.add_argument(
        "--reviewer-credential-json",
        help="explicit ignored repo-local JSON containing only the private in-memory token source",
    )
    parser.add_argument("--alibaba-raw", help="human-reviewed repo-contained raw Alibaba console PNG")
    parser.add_argument(
        "--alibaba-redaction-profile",
        default="demo/alibaba-redaction-profile.json",
        help="SHA-bound crop/redaction profile",
    )
    parser.add_argument("--caption-windows", help="final measured caption_windows.json")
    parser.add_argument("--video-manifest", help="final measured video_manifest.json")
    parser.add_argument("--web-narration", help="final narration_web.txt used by the video")
    parser.add_argument(
        "--allow-canonical-caption-fallback",
        action="store_true",
        help="emit an explicitly unmeasured draft SRT when final caption windows are unavailable",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()

    try:
        require(args.expected_sha is not None, "--expected-sha is required")
        require(args.deployment_output is not None and args.deployment_status is not None, "both deployment evidence paths are required")
        require(args.alibaba_raw is not None, "--alibaba-raw is required")
        expected_sha = str(args.expected_sha).lower()
        deployment_output = snapshot_project_file(args.deployment_output, "deployment output")
        deployment_status = snapshot_project_file(args.deployment_status, "deployment status")
        raw_alibaba_source = project_path(args.alibaba_raw, "Alibaba raw capture", must_exist=True)
        redaction_profile = project_path(args.alibaba_redaction_profile, "Alibaba redaction profile", must_exist=True)
        caption_windows = project_path(args.caption_windows, "caption windows", must_exist=True) if args.caption_windows else None
        video_manifest = project_path(args.video_manifest, "video manifest", must_exist=True) if args.video_manifest else None
        web_narration = project_path(args.web_narration, "web narration", must_exist=True) if args.web_narration else None

        base_url = validate_live_origin(str(args.base_url))
        reviewer_token = reviewer_token_from_args(args)

        PRIVATE.mkdir(parents=True, exist_ok=True)
        GALLERY.mkdir(parents=True, exist_ok=True)
        FINAL_MEDIA.mkdir(parents=True, exist_ok=True)
        require(ARCHITECTURE.is_file(), "canonical architecture image is missing")

        # Copy the reviewed raw cloud capture into this checkout's ignored private
        # originals.  The source is required to be project-contained; no OS temp or
        # external artifact directory is ever used.
        private_alibaba = PRIVATE / "alibaba-ecs-overview-raw.png"
        if raw_alibaba_source.resolve() != private_alibaba.resolve():
            shutil.copyfile(raw_alibaba_source, private_alibaba)
        else:
            private_alibaba = raw_alibaba_source
        enforce_private_scratch_budget()

        print("[1/10] exact release + post-deploy source allowlist")
        remote_main, exact_deploy_evidence_mode, deployment_producer = verify_exact_release(
            expected_sha,
            deployment_output,
            deployment_status,
        )
        observed_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

        print("[2/10] public health/readiness, authenticated deep readiness, seed and selected-company P&L")
        probes = public_release_probes(base_url, reviewer_token)

        print("[3/10] original-synthetic qwen-vl-max dry-run canary + exact absence gate")
        vision_canary = vision_document_canary(base_url, reviewer_token, expected_sha)
        probes["visionCanary"] = vision_canary

        print("[4/10] Session-A feedback, fresh Session-B application, one-row lifecycle + cleanup")
        feedback_proof = feedback_persistence_and_lifecycle_proof(base_url, reviewer_token, probes)

        print("[5/10] canonical Explorer recall, field audit, semantic audit and honest Defer-only capture")
        captured = contained_browser_capture(
            base_url, args.repo_url, reviewer_token, expected_sha, observed_at, probes
        )
        enforce_private_scratch_budget()

        print("[6/10] feedback-persistence and one-deletion lifecycle proof cards")
        render_feedback_persistence_card(
            GALLERY / PRIMARY_OUTPUTS[1], feedback_proof,
            base_url=base_url, expected_sha=expected_sha, observed_at=observed_at,
        )
        preview = feedback_proof["lifecycle"]["preview"]
        confirmed = feedback_proof["lifecycle"]["confirmed"]
        render_lifecycle_card(
            GALLERY / PRIMARY_OUTPUTS[5], preview, confirmed, feedback_proof["lifecycle"],
            base_url=base_url, expected_sha=expected_sha, observed_at=observed_at,
        )

        print("[7/10] qwen-vl, architecture, health/readiness and SHA-bound Alibaba proof cards")
        render_architecture_assets(GALLERY / PRIMARY_OUTPUTS[6])
        render_vision_canary_card(
            GALLERY / SECONDARY_OUTPUTS[0], vision_canary,
            base_url=base_url, expected_sha=expected_sha, observed_at=observed_at,
        )
        render_health_card(
            GALLERY / SECONDARY_OUTPUTS[1], probes,
            base_url=base_url, expected_sha=expected_sha, observed_at=observed_at,
        )
        sanitized_alibaba = sanitize_alibaba_capture(private_alibaba, redaction_profile)
        render_alibaba_card(
            GALLERY / SECONDARY_OUTPUTS[2], sanitized_alibaba, probes,
            base_url=base_url, expected_sha=expected_sha, observed_at=observed_at,
        )

        print("[8/10] public GitHub + MIT API gate and repository capture")
        github_public_probe(args.repo_url)
        render_repository_card(
            captured["repoRaw"], GALLERY / SECONDARY_OUTPUTS[3],
            repo_url=args.repo_url, remote_main=remote_main, observed_at=observed_at,
        )

        print("[9/10] 1280×720 YouTube thumbnail and English subtitle artifact")
        render_youtube_thumbnail(GALLERY / PRIMARY_OUTPUTS[2], FINAL_MEDIA / "youtube-thumbnail.png")
        srt_source = emit_srt(
            FINAL_MEDIA / "memoryagent-demo.en.srt",
            measured_windows=caption_windows,
            allow_canonical_fallback=args.allow_canonical_caption_fallback,
            video_manifest=video_manifest,
            web_narration=web_narration,
        )

        print("[10/10] dimensions, metadata, private-original tracking and artifact hashes")
        hashes = verify_outputs(expected_sha, base_url)
        enforce_private_scratch_budget()
        write_review_manifest(
            expected_sha=expected_sha,
            remote_main=remote_main,
            exact_deploy_evidence_mode=exact_deploy_evidence_mode,
            deployment_producer=deployment_producer,
            deployment_output=deployment_output,
            deployment_status=deployment_status,
            base_url=base_url,
            observed_at=observed_at,
            probes=probes,
            feedback_proof=feedback_proof,
            vision_canary=vision_canary,
            hashes=hashes,
            srt_source=srt_source,
        )
        print(f"submission media gate: PASS · exact runtime {expected_sha[:12]} · {len(hashes)} reviewed artifacts")
        return 0
    except GateError as exc:
        print(f"submission media gate: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
