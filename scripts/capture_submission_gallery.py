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

import atexit
import argparse
import base64
import datetime as dt
import hashlib
from http import client as httpclient
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import ssl
import subprocess
import sys
import time
from typing import Any, Callable, Sequence
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
CAPTION_CONTRACT = REPO / "demo" / "caption-timeline.json"

DEFAULT_BASE_URL = "https://memory.43.106.13.19.sslip.io"
PINNED_LIVE_HOST = "memory.43.106.13.19.sslip.io"
PINNED_LIVE_PORT = 443
DEFAULT_REPO_URL = "https://github.com/upgradedev/archon-qwen-memoryagent"
PINNED_REPO_HOST = "github.com"
PINNED_REPO_ASSET_HOSTS = frozenset({"github.githubassets.com", "avatars.githubusercontent.com"})
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
    "Using only the retrieved memory, return exactly one sentence that states the true employer cost "
    "for Northwind Trading in 2026-05 and includes citation marker [1]. Mention no other amounts, "
    "ratios, employee counts, or calculations."
)
CANONICAL_SEMANTIC_REQUEST = {
    "company": "Northwind Trading",
    "kind": "insight",
    "maxPairs": 1,
}
VALID_GROUNDING_RESULTS = frozenset({("passed", 1), ("repaired", 2)})

# HTTP-200, read-only stage resilience.  These retries are intentionally separate
# from transport retrying: the server has authoritatively completed a read-only
# request and returned one of two small, typed degradation shapes.  Mutations,
# transport exceptions, non-200 responses, malformed/unknown payloads, grounding
# failures and content/safety failures are never retried here.
STAGE_LOCAL_MAX_ATTEMPTS = 3
STAGE_LOCAL_BACKOFF_SECONDS = (1.0, 2.0)
STAGE_LOCAL_RETRY_QUOTA = {
    "session-b-recall": {"pool": "judge-recall", "workUnitsPerAttempt": 4, "limit": 200},
    "explorer-recall": {"pool": "public-recall", "workUnitsPerAttempt": 4, "limit": 200},
    "semantic-audit": {"pool": "judge-semantic", "workUnitsPerAttempt": 1, "limit": 500},
}
REQUIRED_STAGE_LOCAL_PROVENANCE = tuple(STAGE_LOCAL_RETRY_QUOTA)
ALLOWLISTED_NARRATOR_TRANSIENT_CODES = frozenset({
    "upstream_rate_limited",
    "upstream_timeout",
    "upstream_unavailable",
})
NARRATOR_DEGRADED_MESSAGE = "narrator unavailable — returning raw recalled memories"
ATTEMPT_CLASSIFICATIONS = frozenset({
    "allowlisted-narrator-upstream-unavailable",
    "allowlisted-semantic-judge-unavailable",
    "http-non-200",
    "malformed-payload",
    "non-retryable-narrator-contract",
    "non-retryable-semantic-contract",
    "request-or-parse-failure",
    "strict-complete-semantic-audit",
    "strict-qwen-narrator",
})
SEMANTIC_ERROR_CLASSES = frozenset({
    "input-limit",
    "judge-unavailable",
    "malformed-error",
    "other",
    "unparseable-response",
})
SEMANTIC_PUBLIC_OBSERVATION_KEYS = frozenset({
    "compared",
    "embeddingFailed",
    "errorClasses",
    "failed",
    "findingCount",
    "httpStatus",
    "judgeUnavailableErrorCount",
    "judged",
    "otherErrorCount",
    "payloadShape",
    "statusClass",
    "truncated",
})
CANONICAL_PRIVATE_SOURCE_NAMES = frozenset({
    "alibaba-ecs-overview-raw.png",
    "alibaba-ecs-overview-raw.jpg",
})
LEGACY_PRIVATE_GENERATED_NAMES = frozenset({
    "01-grounded-cross-session-recall-raw.png",
    "01-grounded-cross-session-recall-response.json",
    "02-feedback-persistence-lifecycle-proof.json",
    "02-session-a-feedback-response.json",
    "02-session-a-ingest-response.json",
    "02-session-b-recall-response.json",
    "03-field-audit-raw.png",
    "03-field-audit-response.json",
    "04-semantic-audit-raw.png",
    "04-semantic-audit-response.json",
    "05-human-control-raw.png",
    "06-lifecycle-confirmed.json",
    "06-lifecycle-preview.json",
    "08-qwen-vl-document-canary-proof.json",
    "08-qwen-vl-document-canary-response.json",
    "11-github-public-probe.json",
    "11-public-repository-raw.png",
    "alibaba-ecs-overview-sanitized.png",
    "browser-runtime",
    "health.json",
    "northwind-pnl.json",
    "ready-deep.json",
    "ready.json",
    "reviewer-northwind-pnl.json",
    "reviewer-seed-idempotent.json",
    "runs",
    "seed-idempotent.json",
})

# Capture-only ingress resilience.  The four deterministic delays yield at most
# five transport attempts for body-free GET probes.  Mutations, HTTP responses,
# malformed payloads, and generic content/semantic gate failures are deliberately
# never retried; the typed HTTP-200 stage controller above is a separate policy.
GET_TRANSPORT_RETRY_DELAYS_SECONDS = (0.25, 0.5, 1.0, 2.0)
GET_TRANSPORT_MAX_ATTEMPTS = len(GET_TRANSPORT_RETRY_DELAYS_SECONDS) + 1

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
    re.compile(r"^scripts/(?:capture_live\.sh|captions\.txt|capture_submission_gallery\.py|capture_web\.py)$"),
    re.compile(r"^tests/docs/docs-consistency\.test\.ts$"),
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


_ACTIVE_PRIVATE_OUTPUT_DIR: Path | None = None


def _strict_int(value: Any) -> bool:
    return type(value) is int


def _list_count(value: Any) -> int | None:
    return len(value) if isinstance(value, list) else None


def validate_canonical_semantic_request(value: Any) -> None:
    """Require the captured Explorer POST to use the one-pair demo scope."""

    require(isinstance(value, dict), "Explorer semantic request body is not JSON")
    require(
        set(value) == set(CANONICAL_SEMANTIC_REQUEST)
        and value.get("company") == CANONICAL_SEMANTIC_REQUEST["company"]
        and value.get("kind") == CANONICAL_SEMANTIC_REQUEST["kind"]
        and _strict_int(value.get("maxPairs"))
        and value.get("maxPairs") == CANONICAL_SEMANTIC_REQUEST["maxPairs"],
        "Explorer semantic request body is not the exact bounded canonical scope",
    )


def semantic_error_class(error: Any) -> str:
    """Map private semantic failure details to a fixed public-safe enum."""

    if not isinstance(error, dict) or not isinstance(error.get("reason"), str):
        return "malformed-error"
    return {
        "judge unavailable": "judge-unavailable",
        "unparseable judge response": "unparseable-response",
        "statement exceeds judge input limit": "input-limit",
    }.get(error["reason"], "other")


def validate_semantic_public_observation(value: dict[str, Any]) -> None:
    """Prevent raw semantic content or identifiers from entering public evidence."""

    require(
        set(value).issubset(SEMANTIC_PUBLIC_OBSERVATION_KEYS),
        "semantic attempt evidence contains a non-sanitized field",
    )
    require(
        value.get("payloadShape") in {"object", "non-object", "unavailable"},
        "semantic attempt evidence contains an invalid payload class",
    )
    http_status = value.get("httpStatus")
    require(
        http_status is None or (_strict_int(http_status) and 100 <= http_status <= 599),
        "semantic attempt evidence contains an invalid HTTP status",
    )
    if "statusClass" in value:
        require(
            value["statusClass"] in {"complete", "partial", "inconclusive", "other"},
            "semantic attempt evidence contains an invalid status class",
        )
    for key in (
        "compared",
        "embeddingFailed",
        "failed",
        "findingCount",
        "judgeUnavailableErrorCount",
        "judged",
        "otherErrorCount",
    ):
        if key in value:
            require(
                value[key] is None or (_strict_int(value[key]) and value[key] >= 0),
                "semantic attempt evidence contains an invalid counter",
            )
    if "truncated" in value:
        require(
            value["truncated"] is None or type(value["truncated"]) is bool,
            "semantic attempt evidence contains an invalid truncation class",
        )
    error_classes = value.get("errorClasses")
    require(
        error_classes is None
        or (
            isinstance(error_classes, list)
            and all(error_class in SEMANTIC_ERROR_CLASSES for error_class in error_classes)
        ),
        "semantic attempt evidence contains a non-enum error class",
    )


def _safe_evidence_value(value: Any) -> None:
    """Reject secret-shaped attempt evidence before it reaches disk."""

    if isinstance(value, dict):
        for key, item in value.items():
            if SENSITIVE_KEY.search(str(key)):
                raise GateError("capture attempt evidence contains a sensitive key")
            _safe_evidence_value(item)
        return
    if isinstance(value, list):
        for item in value:
            _safe_evidence_value(item)
        return
    if isinstance(value, str):
        if BEARER.search(value) or EMAIL.search(value) or PRIVATE_IPV4.search(value):
            raise GateError("capture attempt evidence contains sensitive text")


class CaptureAttemptLedger:
    """Secret-safe, run-scoped evidence for bounded read-only stage retries."""

    def __init__(self, run_id: str, output_dir: Path) -> None:
        if re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", run_id) is None:
            raise GateError("capture run id is invalid")
        try:
            output_dir.resolve().relative_to(REPO.resolve())
        except (OSError, RuntimeError, ValueError) as exc:
            raise GateError("capture attempt evidence directory escaped the repository") from exc
        self.run_id = run_id
        self.output_dir = output_dir
        self.records: list[dict[str, Any]] = []

    def record(
        self,
        *,
        stage: str,
        attempt: int,
        outcome: str,
        classification: str,
        observation: dict[str, Any],
    ) -> None:
        quota = STAGE_LOCAL_RETRY_QUOTA.get(stage)
        require(quota is not None, "capture retry stage is not quota-declared")
        require(1 <= attempt <= STAGE_LOCAL_MAX_ATTEMPTS, "capture retry attempt is out of bounds")
        require(
            outcome in {"selected", "retryable-transient", "transient-exhausted", "rejected-no-retry", "request-failed-no-retry"},
            "capture retry outcome is invalid",
        )
        require(classification in ATTEMPT_CLASSIFICATIONS, "capture retry classification is invalid")
        if outcome == "selected":
            require(
                classification in {"strict-qwen-narrator", "strict-complete-semantic-audit"},
                "capture selected outcome has a non-success classification",
            )
        elif outcome in {"retryable-transient", "transient-exhausted"}:
            require(
                classification in {
                    "allowlisted-narrator-upstream-unavailable",
                    "allowlisted-semantic-judge-unavailable",
                },
                "capture transient outcome has a non-transient classification",
            )
            require(
                (outcome == "retryable-transient" and attempt < STAGE_LOCAL_MAX_ATTEMPTS)
                or (outcome == "transient-exhausted" and attempt == STAGE_LOCAL_MAX_ATTEMPTS),
                "capture transient outcome is inconsistent with its attempt",
            )
        elif outcome == "request-failed-no-retry":
            require(classification == "request-or-parse-failure", "capture failed request classification is invalid")
        else:
            require(
                classification in {
                    "http-non-200",
                    "malformed-payload",
                    "non-retryable-narrator-contract",
                    "non-retryable-semantic-contract",
                },
                "capture rejected outcome has a retryable classification",
            )
        if stage == "semantic-audit":
            validate_semantic_public_observation(observation)
        backoff = (
            STAGE_LOCAL_BACKOFF_SECONDS[attempt - 1]
            if outcome == "retryable-transient"
            else None
        )
        document = {
            "schemaVersion": 1,
            "captureRunId": self.run_id,
            "stage": stage,
            "attempt": attempt,
            "maxAttempts": STAGE_LOCAL_MAX_ATTEMPTS,
            "outcome": outcome,
            "classification": classification,
            "backoffSecondsBeforeNextAttempt": backoff,
            "quota": {
                "pool": quota["pool"],
                "workUnitsUpperBoundThisAttempt": quota["workUnitsPerAttempt"],
                "maxStageWorkUnits": quota["workUnitsPerAttempt"] * STAGE_LOCAL_MAX_ATTEMPTS,
                "dailyLimit": quota["limit"],
            },
            "observation": observation,
        }
        _safe_evidence_value(document)
        attempt_dir = self.output_dir / "attempts"
        attempt_dir.mkdir(parents=True, exist_ok=True)
        require(attempt_dir.is_dir() and not attempt_dir.is_symlink(), "capture attempt directory is unsafe")
        path = attempt_dir / f"{stage}-attempt-{attempt:02d}.json"
        require(not path.exists() and not path.is_symlink(), "capture attempt evidence path already exists")
        try:
            with path.open("x", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
        except FileExistsError as exc:
            raise GateError("capture attempt evidence path already exists") from exc
        try:
            relative = str(path.relative_to(REPO)).replace("\\", "/")
        except ValueError as exc:
            raise GateError("capture attempt evidence escaped the repository") from exc
        self.records.append({
            "stage": stage,
            "attempt": attempt,
            "outcome": outcome,
            "classification": classification,
            "backoffSecondsBeforeNextAttempt": backoff,
            "quota": document["quota"],
            "observation": observation,
            "path": relative,
            "sha256": sha256_file(path),
        })

    def review_provenance(self) -> dict[str, Any]:
        selected: dict[str, Any] = {}
        for stage in REQUIRED_STAGE_LOCAL_PROVENANCE:
            stage_records = [record for record in self.records if record["stage"] == stage]
            chosen = [record for record in stage_records if record["outcome"] == "selected"]
            require(len(chosen) == 1, f"capture retry provenance has no unique selected {stage} attempt")
            require(
                [record["attempt"] for record in stage_records] == list(range(1, len(stage_records) + 1)),
                f"capture retry provenance has a non-contiguous {stage} attempt sequence",
            )
            selected_record = chosen[0]
            require(selected_record is stage_records[-1], f"capture retry provenance selected a non-final {stage} attempt")
            require(
                all(record["outcome"] == "retryable-transient" for record in stage_records[:-1]),
                f"capture retry provenance contains a non-retryable pre-selection {stage} attempt",
            )
            for record in stage_records:
                evidence_path = REPO / record["path"]
                require(
                    evidence_path.is_file() and not evidence_path.is_symlink(),
                    f"capture retry evidence for {stage} is missing or unsafe",
                )
                require(
                    evidence_path.parent.resolve() == (self.output_dir / "attempts").resolve(),
                    f"capture retry evidence for {stage} escaped its run",
                )
                require(
                    sha256_file(evidence_path) == record["sha256"],
                    f"capture retry evidence hash drifted for {stage}",
                )
            selected[stage] = {
                "selectedAttempt": selected_record["attempt"],
                "attemptCount": len(stage_records),
                "evidencePath": selected_record["path"],
                "evidenceSha256": selected_record["sha256"],
            }
        return {
            "captureRunId": self.run_id,
            "policy": {
                "maxAttempts": STAGE_LOCAL_MAX_ATTEMPTS,
                "backoffSeconds": list(STAGE_LOCAL_BACKOFF_SECONDS),
                "retryableHttpResults": [
                    "typed narrator upstream unavailability after HTTP 200",
                    "typed semantic judge unavailability after HTTP 200",
                ],
                "neverRetried": [
                    "mutations",
                    "transport errors",
                    "non-200 responses",
                    "malformed or unknown payloads",
                    "grounding or content safety failures",
                    "embedding failures or truncation",
                    "unparseable judge output",
                ],
            },
            "quotaBounds": {
                stage: {
                    **quota,
                    "maxStageWorkUnits": quota["workUnitsPerAttempt"] * STAGE_LOCAL_MAX_ATTEMPTS,
                }
                for stage, quota in STAGE_LOCAL_RETRY_QUOTA.items()
            },
            "selectedAttempts": selected,
            "attemptEvidence": list(self.records),
        }


def classify_narrator_stage(payload: Any, http_status: int) -> tuple[str, str, dict[str, Any]]:
    """Select, retry, or reject a recall result without retaining its content."""

    if http_status != 200:
        return "rejected", "http-non-200", {
            "httpStatus": http_status,
            "payloadShape": "object" if isinstance(payload, dict) else "unavailable",
        }
    if not isinstance(payload, dict):
        return "rejected", "malformed-payload", {"httpStatus": http_status, "payloadShape": "non-object"}
    grounding = payload.get("grounding")
    grounding_status = grounding.get("status") if isinstance(grounding, dict) else None
    grounding_attempts = grounding.get("attempts") if isinstance(grounding, dict) else None
    grounding_result = (
        (grounding_status, grounding_attempts)
        if isinstance(grounding_status, str) and _strict_int(grounding_attempts)
        else (None, None)
    )
    model_id = payload.get("modelId")
    degradation_code = payload.get("degradationCode")
    degradation_allowlisted = (
        isinstance(degradation_code, str)
        and degradation_code in ALLOWLISTED_NARRATOR_TRANSIENT_CODES
    )
    degradation_grounding_failure = (
        isinstance(degradation_code, str)
        and degradation_code in {
            "grounding_invalid_or_missing_citation",
            "grounding_unsupported_numeric_claim",
        }
    )
    degradation_class = (
        "allowlisted-upstream"
        if degradation_allowlisted
        else "grounding-failure"
        if degradation_grounding_failure
        else "unexpected-narrator-failure"
        if isinstance(degradation_code, str) and degradation_code == "unexpected_narrator_failure"
        else "none"
        if degradation_code is None
        else "unknown"
    )
    summary = {
        "httpStatus": http_status,
        "payloadShape": "object",
        "modelClass": "expected" if model_id == EXPECTED_NARRATOR else "degraded" if model_id == "degraded" else "other",
        "groundingClass": grounding_result[0] if grounding_result in VALID_GROUNDING_RESULTS else "missing-or-invalid",
        "groundingAttempts": grounding_result[1] if grounding_result in VALID_GROUNDING_RESULTS else None,
        "degradationClass": degradation_class,
        "degradationAttempts": (
            payload.get("degradationAttempts")
            if _strict_int(payload.get("degradationAttempts"))
            else None
        ),
        "hitCount": _list_count(payload.get("hits")),
        "citationCount": _list_count(payload.get("citations")),
    }
    strict_success = (
        model_id == EXPECTED_NARRATOR
        and "degraded" not in payload
        and "degradationCode" not in payload
        and "degradationAttempts" not in payload
        and isinstance(grounding, dict)
        and _strict_int(grounding.get("attempts"))
        and grounding_result in VALID_GROUNDING_RESULTS
    )
    if strict_success:
        return "selected", "strict-qwen-narrator", summary
    hits = payload.get("hits")
    citations = payload.get("citations")
    degraded_keys = {
        "answer", "hits", "citations", "modelId", "consistency", "retrieval",
        "degraded", "degradationCode", "degradationAttempts",
    }
    retryable = (
        set(payload) == degraded_keys
        and model_id == "degraded"
        and payload.get("degraded") == NARRATOR_DEGRADED_MESSAGE
        and degradation_allowlisted
        and _strict_int(payload.get("degradationAttempts"))
        and payload.get("degradationAttempts") == 1
        and "grounding" not in payload
        and isinstance(payload.get("answer"), str)
        and bool(payload["answer"].strip())
        and isinstance(hits, list)
        and len(hits) > 0
        and all(isinstance(hit, dict) for hit in hits)
        and isinstance(citations, list)
        and len(citations) == len(hits)
        and all(isinstance(citation, dict) for citation in citations)
        and isinstance(payload.get("consistency"), dict)
        and isinstance(payload.get("retrieval"), dict)
    )
    if retryable:
        return "retryable", "allowlisted-narrator-upstream-unavailable", summary
    return "rejected", "non-retryable-narrator-contract", summary


def classify_semantic_stage(payload: Any, http_status: int) -> tuple[str, str, dict[str, Any]]:
    """Retry only a structurally exact judge-unavailable semantic report."""

    if http_status != 200:
        return "rejected", "http-non-200", {
            "httpStatus": http_status,
            "payloadShape": "object" if isinstance(payload, dict) else "unavailable",
        }
    if not isinstance(payload, dict):
        return "rejected", "malformed-payload", {"httpStatus": http_status, "payloadShape": "non-object"}
    errors = payload.get("errors")
    embedding_errors = payload.get("embeddingErrors")
    findings = payload.get("semanticContradictions")
    status_value = payload.get("status")
    compared = payload.get("compared")
    judged = payload.get("judged")
    failed = payload.get("failed")
    model_calls = payload.get("modelCalls")
    summary = {
        "httpStatus": http_status,
        "payloadShape": "object",
        "statusClass": status_value if isinstance(status_value, str) and status_value in {"complete", "partial", "inconclusive"} else "other",
        "compared": compared if _strict_int(compared) else None,
        "judged": judged if _strict_int(judged) else None,
        "failed": failed if _strict_int(failed) else None,
        "embeddingFailed": payload.get("embeddingFailed") if _strict_int(payload.get("embeddingFailed")) else None,
        "truncated": payload.get("truncated") if type(payload.get("truncated")) is bool else None,
        "findingCount": _list_count(findings),
        "errorClasses": (
            sorted({semantic_error_class(error) for error in errors})
            if isinstance(errors, list)
            else None
        ),
        "judgeUnavailableErrorCount": (
            sum(1 for error in errors if isinstance(error, dict) and error.get("reason") == "judge unavailable")
            if isinstance(errors, list)
            else None
        ),
        "otherErrorCount": (
            sum(1 for error in errors if not isinstance(error, dict) or error.get("reason") != "judge unavailable")
            if isinstance(errors, list)
            else None
        ),
    }
    require(
        summary["errorClasses"] is None
        or all(error_class in SEMANTIC_ERROR_CLASSES for error_class in summary["errorClasses"]),
        "semantic public error classification escaped its fixed enum",
    )
    counters_valid = all(_strict_int(value) and value >= 0 for value in (compared, judged, failed, model_calls))
    collections_valid = isinstance(errors, list) and isinstance(embedding_errors, list) and isinstance(findings, list)
    strict_complete = (
        status_value == "complete"
        and counters_valid
        and collections_valid
        and compared == judged == model_calls
        and failed == 0
        and errors == []
        and _strict_int(payload.get("embeddingFailed"))
        and payload.get("embeddingFailed") == 0
        and embedding_errors == []
        and payload.get("truncated") is False
    )
    if strict_complete:
        return "selected", "strict-complete-semantic-audit", summary
    error_shape_valid = (
        isinstance(errors, list)
        and len(errors) > 0
        and all(
            isinstance(error, dict)
            and set(error) == {"memoryIds", "reason"}
            and error.get("reason") == "judge unavailable"
            and isinstance(error.get("memoryIds"), list)
            and len(error["memoryIds"]) == 2
            and all(isinstance(memory_id, str) and bool(memory_id) for memory_id in error["memoryIds"])
            for error in errors
        )
    )
    retryable = (
        set(payload) == {
            "totalMemories", "audited", "candidatePairs", "compared", "modelCalls",
            "judged", "failed", "embeddingFailed", "truncated", "status", "errors",
            "embeddingErrors", "semanticContradictions", "ok",
        }
        and isinstance(status_value, str)
        and status_value in {"partial", "inconclusive"}
        and counters_valid
        and all(
            _strict_int(payload.get(key)) and payload[key] >= 0
            for key in ("totalMemories", "audited", "candidatePairs")
        )
        and collections_valid
        and compared > 0
        and model_calls == compared
        and failed == len(errors) > 0
        and judged + failed == compared
        and _strict_int(payload.get("embeddingFailed"))
        and payload.get("embeddingFailed") == 0
        and embedding_errors == []
        and payload.get("truncated") is False
        and payload.get("ok") is False
        and error_shape_valid
    )
    if retryable:
        return "retryable", "allowlisted-semantic-judge-unavailable", summary
    return "rejected", "non-retryable-semantic-contract", summary


def run_stage_local_retry(
    *,
    stage: str,
    operation: Callable[[], tuple[Any, int]],
    classifier: Callable[[Any, int], tuple[str, str, dict[str, Any]]],
    ledger: CaptureAttemptLedger,
    sleeper: Callable[[float], None] = time.sleep,
    response_recorder: Callable[[int, Any], None] | None = None,
) -> Any:
    """Retry only classifier-approved HTTP-200 read results, never requests generically."""

    require(stage in STAGE_LOCAL_RETRY_QUOTA, "capture retry stage has no quota declaration")
    for attempt in range(1, STAGE_LOCAL_MAX_ATTEMPTS + 1):
        try:
            payload, http_status = operation()
        except Exception as exc:
            ledger.record(
                stage=stage,
                attempt=attempt,
                outcome="request-failed-no-retry",
                classification="request-or-parse-failure",
                observation={"httpStatus": None, "payloadShape": "unavailable"},
            )
            if isinstance(exc, GateError):
                raise
            raise GateError(f"{stage} request or response parsing failed without retry") from exc
        if response_recorder is not None:
            # This intentionally runs before classification and strict-success
            # assertions.  A completed HTTP response must remain diagnosable even
            # when the fail-closed contract rejects it or retry attempts exhaust.
            response_recorder(attempt, payload)
        decision, classification, observation = classifier(payload, http_status)
        require(decision in {"selected", "retryable", "rejected"}, "capture retry classifier returned an invalid decision")
        exhausted = decision == "retryable" and attempt == STAGE_LOCAL_MAX_ATTEMPTS
        outcome = (
            "selected" if decision == "selected"
            else "transient-exhausted" if exhausted
            else "retryable-transient" if decision == "retryable"
            else "rejected-no-retry"
        )
        ledger.record(
            stage=stage,
            attempt=attempt,
            outcome=outcome,
            classification=classification,
            observation=observation,
        )
        if decision == "selected":
            return payload
        if decision == "rejected":
            return payload
        if exhausted:
            raise GateError(f"{stage} exhausted {STAGE_LOCAL_MAX_ATTEMPTS} allowlisted transient attempts")
        sleeper(STAGE_LOCAL_BACKOFF_SECONDS[attempt - 1])
    raise GateError(f"{stage} retry controller reached an impossible state")


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


def prepare_private_capture_run(
    run_id: str,
    *,
    private_root: Path = PRIVATE,
    protected_inputs: Sequence[Path] = (),
) -> Path:
    """Remove only known legacy/generated capture paths and create one run root.

    Canonical Alibaba sources and unrelated private inputs are never candidates
    for deletion.  Previous adjudication snapshots under ``.artifacts`` are
    outside this root and are therefore also untouched.  Target validation is
    completed before the first removal so a symlink or unexpected file type
    fails closed without a partial cleanup.
    """

    require(
        re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", run_id) is not None,
        "capture run id is invalid",
    )
    lexical_root = Path(os.path.abspath(private_root))
    try:
        resolved_root = private_root.resolve()
        resolved_root.relative_to(REPO.resolve())
    except (OSError, RuntimeError, ValueError) as exc:
        raise GateError("private capture root escaped the repository") from exc
    private_root.mkdir(parents=True, exist_ok=True)
    resolved_root = private_root.resolve()
    require(
        resolved_root == lexical_root and not private_root.is_symlink() and private_root.is_dir(),
        "private capture root is not a regular project directory",
    )
    protected = [source.resolve() for source in protected_inputs]
    for name in sorted(CANONICAL_PRIVATE_SOURCE_NAMES):
        source = private_root / name
        if source.exists() or source.is_symlink():
            require(
                source.is_file()
                and not source.is_symlink()
                and source.resolve() == resolved_root / name,
                f"canonical private source {name} is not a regular file",
            )
    targets: list[Path] = []
    for name in sorted(LEGACY_PRIVATE_GENERATED_NAMES):
        require(name not in CANONICAL_PRIVATE_SOURCE_NAMES, "private cleanup policy overlaps a canonical source")
        target = private_root / name
        if not target.exists() and not target.is_symlink():
            continue
        require(not target.is_symlink(), f"private generated path {name} is a symlink")
        require(target.is_file() or target.is_dir(), f"private generated path {name} has an unsupported type")
        resolved_target = target.resolve()
        require(
            resolved_target == resolved_root / name,
            f"private generated path {name} traverses a link or reparse point",
        )
        require(
            all(source != resolved_target and resolved_target not in source.parents for source in protected),
            f"private input overlaps generated cleanup path {name}",
        )
        targets.append(target)
    for target in targets:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    run_dir = private_root / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    return run_dir


def set_active_private_output_dir(path: Path) -> None:
    global _ACTIVE_PRIVATE_OUTPUT_DIR
    require(path.is_dir() and not path.is_symlink(), "active private capture run is not a regular directory")
    try:
        path.resolve().relative_to(PRIVATE.resolve())
    except ValueError as exc:
        raise GateError("active private capture run escaped demo/private-originals") from exc
    _ACTIVE_PRIVATE_OUTPUT_DIR = path


def private_output_path(name: str) -> Path:
    require(_ACTIVE_PRIVATE_OUTPUT_DIR is not None, "private capture run was not initialized")
    relative = Path(name)
    require(
        not relative.is_absolute() and len(relative.parts) == 1 and relative.name == name,
        "private capture output name must be a single relative filename",
    )
    return _ACTIVE_PRIVATE_OUTPUT_DIR / relative


def validate_live_origin(value: str) -> str:
    require(value == DEFAULT_BASE_URL, f"live credential destination must be exactly {DEFAULT_BASE_URL}")
    parsed = urlparse.urlparse(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise GateError("live credential destination has an invalid port") from exc
    require(
        parsed.scheme == "https"
        and parsed.hostname == PINNED_LIVE_HOST
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
        and parsed.hostname == PINNED_LIVE_HOST
        and port in {None, 443}
        and parsed.username is None
        and parsed.password is None
    )


class PinnedHttpsJsonTransport:
    """One fail-closed, reusable TLS connection to the exact live origin.

    Body-free GET probes may reconnect on transport failures.  Any request with
    a body, and every mutation, is attempted exactly once because a broken
    connection cannot prove whether the server applied it.
    """

    TRANSPORT_ERRORS = (httpclient.HTTPException, ssl.SSLError, TimeoutError, OSError)

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        ssl_context: ssl.SSLContext | None = None,
        connection_factory: Any = httpclient.HTTPSConnection,
    ) -> None:
        self.base_url = validate_live_origin(base_url)
        context = ssl_context or ssl.create_default_context(purpose=ssl.Purpose.SERVER_AUTH)
        require(context.check_hostname is True, "live transport TLS context must verify the pinned hostname")
        require(
            context.verify_mode == ssl.CERT_REQUIRED,
            "live transport TLS context must require certificate validation",
        )
        self._ssl_context = context
        self._connection_factory = connection_factory
        self._connection: Any | None = None

    def close(self) -> None:
        connection = self._connection
        self._connection = None
        if connection is not None:
            try:
                connection.close()
            except (httpclient.HTTPException, OSError):
                pass

    def _connection_for(self, timeout: float) -> Any:
        if self._connection is None:
            self._connection = self._connection_factory(
                PINNED_LIVE_HOST,
                PINNED_LIVE_PORT,
                timeout=timeout,
                context=self._ssl_context,
            )
        else:
            self._connection.timeout = timeout
            sock = getattr(self._connection, "sock", None)
            if sock is not None:
                sock.settimeout(timeout)
        return self._connection

    def _request_once(
        self,
        method: str,
        path: str,
        data: bytes | None,
        headers: dict[str, str],
        timeout: float,
    ) -> tuple[int, bytes, dict[str, str]]:
        connection = self._connection_for(timeout)
        response: Any | None = None
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            status = response.status
            if status != 200:
                # Never parse or expose an untrusted error/redirect body.  Drop
                # the connection instead of draining it, while preserving the
                # authoritative HTTP result and zero-retry contract.
                self.close()
                return status, b"", {}
            raw = response.read()
            response_headers = {str(key).lower(): str(value) for key, value in response.getheaders()}
            return status, raw, response_headers
        finally:
            if response is not None:
                try:
                    response.close()
                except self.TRANSPORT_ERRORS:
                    # A response status/body already received is authoritative.
                    # Cleanup failure only invalidates future reuse; it must not
                    # turn this completed request into a retry (especially after
                    # a mutation or an HTTP error response).
                    self.close()

    def request_json(
        self,
        method: str,
        base_url: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        reviewer_token: str | None = None,
        timeout: float = 90.0,
    ) -> tuple[Any, dict[str, str]]:
        require(validate_live_origin(base_url) == self.base_url, "live transport origin changed during capture")
        require(path.startswith("/") and not path.startswith("//"), "live request path must be origin-relative")

        data = json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json", "User-Agent": "Archon-MemoryAgent-Media-Gate/1.0"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if reviewer_token:
            headers["Authorization"] = f"Bearer {reviewer_token}"

        retry_delays = GET_TRANSPORT_RETRY_DELAYS_SECONDS if method == "GET" and body is None else ()
        retry_index = 0
        while True:
            try:
                status, raw, response_headers = self._request_once(method, path, data, headers, timeout)
            except self.TRANSPORT_ERRORS:
                self.close()
                if retry_index >= len(retry_delays):
                    attempts = retry_index + 1
                    suffix = f" after {attempts} transport attempts" if attempts > 1 else ""
                    raise GateError(f"{method} {path} was unreachable{suffix}") from None
                time.sleep(retry_delays[retry_index])
                retry_index += 1
                continue
            break

        if 300 <= status < 400:
            raise GateError(f"{method} {path} attempted a forbidden HTTP redirect")
        require(status == 200, f"{method} {path} returned HTTP {status}")
        try:
            return json.loads(raw.decode("utf-8")), response_headers
        except (UnicodeError, json.JSONDecodeError):
            raise GateError(f"{method} {path} did not return JSON") from None


LIVE_JSON_TRANSPORT = PinnedHttpsJsonTransport()
atexit.register(LIVE_JSON_TRANSPORT.close)


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
    path = private_output_path(name)
    path.write_text(json.dumps(scrub_json(value), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_private_semantic_response(attempt: int, value: Any) -> None:
    """Retain each full response privately before any semantic success gate."""

    require(1 <= attempt <= STAGE_LOCAL_MAX_ATTEMPTS, "semantic response attempt is out of bounds")
    write_private_json(f"04-semantic-audit-response-attempt-{attempt:02d}.json", value)
    # Keep the established diagnostic name as an always-current pointer while
    # preserving every bounded attempt separately for post-failure diagnosis.
    write_private_json("04-semantic-audit-response.json", value)


def request_json(
    method: str,
    base_url: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    reviewer_token: str | None = None,
    timeout: float = 90.0,
) -> tuple[Any, dict[str, str]]:
    return LIVE_JSON_TRANSPORT.request_json(
        method,
        base_url,
        path,
        body=body,
        reviewer_token=reviewer_token,
        timeout=timeout,
    )


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


def draw_live_footer(
    draw: ImageDraw.ImageDraw,
    *,
    left_text: str,
    right_text: str,
) -> str:
    """Draw a collision-free evidence footer inside the 1920x1080 safe area."""
    left_face = font(22, bold=True)
    right_face = font(20)
    left_width = float(draw.textlength(left_text, font=left_face))
    right_width = float(draw.textlength(right_text, font=right_face))
    available_width = 1760
    require(left_width <= available_width, "live footer URL is too wide for the publication frame")
    require(right_width <= available_width, "live footer provenance is too wide for the publication frame")

    draw.rectangle((0, 990, 1920, 1080), fill="#091612")
    if left_width + right_width + 56 <= available_width:
        left_box = draw.textbbox((80, 1018), left_text, font=left_face)
        right_box = draw.textbbox((1840, 1018), right_text, anchor="ra", font=right_face)
        require(left_box[2] + 56 <= right_box[0], "single-row live footer geometry collides")
        require(left_box[3] <= 1070 and right_box[3] <= 1070, "single-row live footer escapes the safe area")
        draw.text((80, 1018), left_text, font=left_face, fill="#d3f6e8")
        draw.text((1840, 1018), right_text, anchor="ra", font=right_face, fill="#89a79b")
        return "single-row"

    # Long repository URLs and full source provenance use two deliberate rows.
    # This keeps both strings readable instead of letting a fixed x-offset collide.
    stacked_left_face = font(20, bold=True)
    stacked_right_face = font(19)
    left_box = draw.textbbox((80, 1001), left_text, font=stacked_left_face)
    right_box = draw.textbbox((1840, 1037), right_text, anchor="ra", font=stacked_right_face)
    require(left_box[3] + 5 <= right_box[1], "two-row live footer geometry collides")
    require(left_box[2] <= 1840 and right_box[0] >= 80 and right_box[3] <= 1070, "two-row live footer escapes the safe area")
    draw.text((80, 1001), left_text, font=stacked_left_face, fill="#d3f6e8")
    draw.text((1840, 1037), right_text, anchor="ra", font=stacked_right_face, fill="#89a79b")
    return "two-row"


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
    draw_live_footer(
        draw,
        left_text=f"LIVE HTTPS · {base_url}",
        right_text=f"{source_label} {expected_sha[:12]} · observed {observed_at}",
    )
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
    draw.text((82, 185), "The correction is a durable, cited memory record. It is not autonomous training or a model-weight update.", font=font(27), fill="#b9aecf")

    citation_count = int(session_b["citationCount"])
    citation_label = "citation" if citation_count == 1 else "citations"
    panels = (
        (80, "SESSION A · REVIEWER FEEDBACK", "Persisted correction", proof["preferenceDisplay"], "Original synthetic fact superseded · correction provenance retained"),
        (980, "SESSION B · NEW CLIENT", "Grounded application", str(session_b["answer"]), f"{citation_count} {citation_label} · {session_b['modelId']} · corrected memory recalled"),
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
    intermediate = private_output_path("alibaba-ecs-overview-sanitized.png")
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
    y = 374
    for label, value in facts:
        label_face = font(14, bold=True)
        value_face = font(20, bold=True)
        value_lines = wrap(draw, value, value_face, 310)
        require(len(value_lines) <= 2, f"Alibaba release fact does not fit without truncation: {label}")
        row_height = max(48, 10 + 25 * len(value_lines))
        require(y + row_height <= 836, f"Alibaba release fact row overflows its card: {label}")
        label_box = draw.textbbox((1320, y + 4), label.upper(), font=label_face)
        require(label_box[2] <= 1490, f"Alibaba release label collides with its value: {label}")
        draw.text((1320, y + 4), label.upper(), font=label_face, fill="#7f8b98")
        line_y = y
        for line in value_lines:
            value_box = draw.textbbox((1510, line_y), line, font=value_face)
            require(value_box[2] <= 1820, f"Alibaba release value escapes its card: {label}")
            draw.text((1510, line_y), line, font=value_face, fill="#eef3f8")
            line_y += 25
        draw.line((1320, y + row_height - 8, 1815, y + row_height - 8), fill="#303944", width=1)
        y += row_height
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
    attempt_ledger: CaptureAttemptLedger,
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
        def explorer_recall_operation() -> tuple[Any, int]:
            page.wait_for_function(
                "document.querySelector('#askBtn') && !document.querySelector('#askBtn').disabled"
            )
            with page.expect_response(
                lambda response: response.url.endswith("/recall") and response.request.method == "POST"
            ) as pending:
                page.locator("#askBtn").click()
            recall_response = pending.value
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
            if recall_response.status != 200:
                return None, recall_response.status
            return recall_response.json(), recall_response.status

        recall = run_stage_local_retry(
            stage="explorer-recall",
            operation=explorer_recall_operation,
            classifier=classify_narrator_stage,
            ledger=attempt_ledger,
        )
        require(isinstance(recall, dict), "Explorer recall returned a non-object response")
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
        raw_recall = private_output_path("01-grounded-cross-session-recall-raw.png")
        page.locator("#result").screenshot(path=str(raw_recall), animations="disabled")
        composite_live_capture(
            raw_recall,
            GALLERY / PRIMARY_OUTPUTS[0],
            eyebrow="Fresh session · bounded recall",
            title="Qwen answers from durable memory, with citations",
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
        raw_field = private_output_path("03-field-audit-raw.png")
        target_locator.screenshot(path=str(raw_field), animations="disabled")
        composite_live_capture(
            raw_field,
            GALLERY / PRIMARY_OUTPUTS[2],
            eyebrow="Read-only self-audit",
            title="Both values stay visible. Policy recommends. It never rewrites.",
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
        def semantic_audit_operation() -> tuple[Any, int]:
            page.wait_for_function(
                "document.querySelector('#semanticBtn') && !document.querySelector('#semanticBtn').disabled"
            )
            with page.expect_response(
                lambda response: response.url.endswith("/consistency/semantic")
                and response.request.method == "POST"
            ) as pending:
                page.locator("#semanticBtn").click()
            semantic_response = pending.value
            validate_canonical_semantic_request(semantic_response.request.post_data_json)
            if semantic_response.status != 200:
                return None, semantic_response.status
            return semantic_response.json(), semantic_response.status

        try:
            semantic = run_stage_local_retry(
                stage="semantic-audit",
                operation=semantic_audit_operation,
                classifier=classify_semantic_stage,
                ledger=attempt_ledger,
                response_recorder=write_private_semantic_response,
            )
        finally:
            page.locator("#judgeToken").fill("")
            page.evaluate("sessionStorage.removeItem('archon_memory_reviewer_token')")
        require(isinstance(semantic, dict), "semantic audit returned a non-object response")
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
        require(page.locator("#judgeToken").input_value() == "", "reviewer token remained in the page before capture")
        semantic_locator = page.locator(".audit-flag").filter(has_text="chronically late").first
        semantic_locator.wait_for()
        raw_semantic = private_output_path("04-semantic-audit-raw.png")
        semantic_locator.screenshot(path=str(raw_semantic), animations="disabled")
        composite_live_capture(
            raw_semantic,
            GALLERY / PRIMARY_OUTPUTS[3],
            eyebrow="Meaning-level self-audit",
            title="Qwen catches the contradiction metadata rules cannot see",
            subtitle="Original synthetic vendor claims share no numeric field. The configured Qwen judge detects their opposed meaning and returns a read-only recommendation.",
            badges=(str(judge["model"]), f"{semantic.get('compared')} pair compared", "credential not rendered"),
            base_url=base_url,
            expected_sha=expected_sha,
            observed_at=observed_at,
        )
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
        raw_control = private_output_path("05-human-control-raw.png")
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

        # 11 · public repository landing page. API facts are validated below;
        # the browser capture is judge-readable visual context. Keep it in a fresh,
        # credential-isolated context: the live context is deliberately pinned to
        # the MemoryAgent origin and must never be relaxed for a second site.
        repo_context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
            locale="en-US",
            color_scheme="dark",
            service_workers="block",
        )

        def guard_repo_request(route: Any) -> None:
            request = route.request
            parsed = urlparse.urlparse(request.url)
            host = (parsed.hostname or "").lower()
            secure_public_host = (
                parsed.scheme == "https"
                and parsed.username is None
                and parsed.password is None
                and (parsed.port or 443) == 443
                and host in ({PINNED_REPO_HOST} | PINNED_REPO_ASSET_HOSTS)
            )
            if request.is_navigation_request():
                exact_repo_navigation = (
                    request.redirected_from is None
                    and request.url.rstrip("/") == repo_url.rstrip("/")
                )
                if secure_public_host and exact_repo_navigation:
                    route.continue_()
                else:
                    route.abort("blockedbyclient")
                return
            if secure_public_host:
                route.continue_()
            else:
                route.abort("blockedbyclient")

        repo_context.route("**/*", guard_repo_request)
        repo_context.route_web_socket(
            "**/*",
            lambda websocket: websocket.close(code=1008, reason="network destination not permitted"),
        )
        repo_page = repo_context.new_page()
        repo_page.set_default_timeout(90_000)
        try:
            repo_navigation = repo_page.goto(repo_url, wait_until="domcontentloaded")
            require(repo_navigation is not None, "public repository navigation returned no response")
            require(repo_navigation.request.redirected_from is None, "public repository navigation attempted a redirect")
            require(repo_page.url.rstrip("/") == repo_url.rstrip("/"), "public repository navigation left the pinned URL")
            repo_page.locator("body").wait_for()
            require("archon-qwen-memoryagent" in repo_page.title().lower(), "public repository landing page did not load")
            raw_repo = private_output_path("11-public-repository-raw.png")
            repo_page.screenshot(path=str(raw_repo), animations="disabled")
            results["repoRaw"] = raw_repo
        finally:
            repo_context.close()

        require(not console_errors, "Explorer emitted browser-console errors during canonical capture")
        context.close()
        browser.close()
    return results


def contained_browser_capture(*args: Any, **kwargs: Any) -> dict[str, Any]:
    """Keep browser profile/temp/cache scratch inside the ignored project tree."""
    scratch = private_output_path("browser-runtime")
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
    attempt_ledger: CaptureAttemptLedger,
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
        session_b_body = {
            "question": f"{marker}: apply the stored reviewer preference. Which workforce-cost figure should appear first?",
            "company": company,
            "limit": 5,
            "hybrid": True,
            "rerank": True,
        }

        def session_b_recall_operation() -> tuple[Any, int]:
            payload, _ = request_json(
                "POST", base_url, "/recall",
                body=session_b_body,
                reviewer_token=reviewer_token,
                timeout=150,
            )
            return payload, 200

        recall = run_stage_local_retry(
            stage="session-b-recall",
            operation=session_b_recall_operation,
            classifier=classify_narrator_stage,
            ledger=attempt_ledger,
        )
        hits = recall.get("hits") if isinstance(recall, dict) else None
        require(isinstance(hits, list) and any(hit.get("id") == corrected_id for hit in hits if isinstance(hit, dict)), "fresh Session B did not recall the persisted correction")
        citations = recall.get("citations")
        require(isinstance(citations, list) and any(marker in str(citation.get("content", "")) for citation in citations if isinstance(citation, dict)), "fresh Session B answer did not cite the persisted preference")
        answer = recall.get("answer")
        require(recall.get("modelId") == EXPECTED_NARRATOR and isinstance(answer, str), "fresh Session B did not return a qwen-plus answer")
        grounding = recall.get("grounding")
        grounding_result = (
            grounding.get("status"), grounding.get("attempts")
        ) if isinstance(grounding, dict) else (None, None)
        require(
            isinstance(grounding, dict)
            and type(grounding.get("attempts")) is int
            and grounding_result in VALID_GROUNDING_RESULTS,
            "fresh Session B did not pass strict grounding within the bounded two-attempt contract",
        )
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


def normalize_caption_windows(raw: Any, label: str) -> list[tuple[float, float, str]]:
    require(isinstance(raw, list) and raw, f"{label} must be a non-empty array")
    rows: list[tuple[float, float, str]] = []
    previous_end = 0.0
    for row in raw:
        require(isinstance(row, list) and len(row) == 3, f"{label} has a row with the wrong shape")
        start, end, text = row
        require(isinstance(start, (int, float)) and isinstance(end, (int, float)), f"{label} has a non-numeric time")
        require(isinstance(text, str) and text.strip(), f"{label} has empty text")
        start_f, end_f = float(start), float(end)
        require(start_f >= previous_end - 0.001 and end_f > start_f, f"{label} is not monotonic")
        rows.append((start_f, end_f, text.strip()))
        previous_end = end_f
    return rows


def parse_caption_windows_snapshot(
    snapshot: ProjectFileSnapshot,
    label: str,
) -> list[tuple[float, float, str]]:
    try:
        raw = json.loads(snapshot.text())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{label} is not valid UTF-8 JSON") from exc
    return normalize_caption_windows(raw, label)


def parse_measured_windows(path: Path) -> list[tuple[float, float, str]]:
    return parse_caption_windows_snapshot(snapshot_project_file(path, "caption windows"), "caption windows")


def validate_canonical_caption_windows(
    measured_snapshot: ProjectFileSnapshot,
    contract_snapshot: ProjectFileSnapshot,
) -> list[tuple[float, float, str]]:
    """Bind one read-once ignored measurement to one inert tracked contract."""
    measured = parse_caption_windows_snapshot(measured_snapshot, "caption windows")
    canonical = parse_caption_windows_snapshot(contract_snapshot, "canonical caption-video timeline")
    require(
        measured == canonical,
        "caption windows do not exactly match the canonical ten-beat final-video timeline",
    )
    require(len(canonical) == 10 and canonical[0][0] == 0.0 and canonical[-1][1] == 172.0, "canonical caption-video timeline is not the exact ten-beat 172-second contract")
    return measured


def validate_production_caption_inputs(
    *,
    caption_windows: str | None,
    allow_canonical_fallback: bool,
    video_manifest: str | None,
    web_narration: str | None,
) -> None:
    """Reject caption inputs that cannot produce the canonical final video.

    The legacy web-narration pair adds an eleventh subtitle beat.  Keeping that
    path in ``emit_srt`` is useful for explicitly non-production drafts, but a
    canonical capture must fail before it reads evidence, creates a run, calls a
    model, or mutates judge data.
    """
    require(
        caption_windows is not None or allow_canonical_fallback,
        "final capture requires --caption-windows; draft fallback must be explicit",
    )
    require(
        video_manifest is None and web_narration is None,
        "canonical capture rejects legacy --video-manifest/--web-narration inputs because they add a non-canonical eleventh subtitle beat",
    )


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
    measured_windows: ProjectFileSnapshot | Path | None,
    allow_canonical_fallback: bool,
    video_manifest: ProjectFileSnapshot | None,
    web_narration: ProjectFileSnapshot | None,
) -> str:
    if measured_windows is not None:
        if isinstance(measured_windows, ProjectFileSnapshot):
            rows = parse_caption_windows_snapshot(measured_windows, "caption windows")
        else:
            rows = parse_measured_windows(measured_windows)
        source = "measured-caption-windows"
    else:
        require(allow_canonical_fallback, "final SRT requires --caption-windows; use --allow-canonical-caption-fallback only for an explicit draft")
        rows = parse_canonical_captions(REPO / "scripts" / "captions.txt")
        source = "canonical-unmeasured-draft"

    if video_manifest is not None or web_narration is not None:
        require(video_manifest is not None and web_narration is not None, "web narration timing requires both --video-manifest and --web-narration")
        try:
            manifest = json.loads(video_manifest.text())
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GateError("video manifest is not valid UTF-8 JSON") from exc
        require(isinstance(manifest, dict), "video manifest must be an object")
        title = float(manifest.get("title_dur"))
        screencast = float(manifest.get("screencast_dur"))
        web_duration = float(manifest.get("web_dur"))
        web_audio = float(manifest.get("a_web"))
        narration = web_narration.text().strip()
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


def thumbnail_evidence_panel(source: Image.Image) -> Image.Image:
    """Make a wide proof crop while retaining at least 90% of source width."""
    target = (570, 410)
    target_aspect = target[0] / target[1]
    source_aspect = source.width / source.height
    require(source_aspect >= target_aspect, "thumbnail evidence source is unexpectedly narrow")
    retained_width = int(round(source.height * target_aspect))
    excess = source.width - retained_width
    left = int(round(excess * 0.40))
    right = left + retained_width
    require(retained_width / source.width >= 0.90, "thumbnail evidence crop discards too much horizontal context")
    require(left <= int(round(source.width * 0.04)), "thumbnail evidence crop cuts the leading-label safe area")
    require(0 <= left < right <= source.width, "thumbnail evidence crop escapes its source")
    return source.crop((left, 0, right, source.height)).resize(target, Image.Resampling.LANCZOS)


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
    draw.text((181, 504), "SESSION A", anchor="mm", font=font(34, bold=True), fill="#f6fff9")
    draw.text((455, 504), "SESSION B", anchor="mm", font=font(34, bold=True), fill="#86efc1")
    draw.text((318, 583), "RECOMMEND · DON'T REWRITE", anchor="mm", font=font(23, bold=True), fill="#a8c0b6")

    # A wide, deliberate crop of the real field-audit composite anchors the right
    # side while preserving the full leading labels. The prior tall crop cut
    # "AUDIT" and the opening words of the headline at thumbnail size.
    panel = thumbnail_evidence_panel(source)
    rounded(draw, (650, 105, 1242, 647), "#0a1713", radius=28, outline="#3e6d5a", width=3)
    canvas.alpha_composite(panel.convert("RGBA"), (661, 171))
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
    caption_contract: ProjectFileSnapshot,
    caption_windows: ProjectFileSnapshot | None,
    base_url: str,
    observed_at: str,
    probes: dict[str, Any],
    feedback_proof: dict[str, Any],
    vision_canary: dict[str, Any],
    hashes: dict[str, str],
    srt_source: str,
    attempt_ledger: CaptureAttemptLedger,
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
        "captureRun": attempt_ledger.review_provenance(),
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
        "subtitleTimeline": {
            "canonicalContract": {
                "path": caption_contract.relative_path,
                "sha256": caption_contract.sha256,
                "size": caption_contract.size,
            },
            "measuredInput": (
                {
                    "path": caption_windows.relative_path,
                    "sha256": caption_windows.sha256,
                    "size": caption_windows.size,
                }
                if caption_windows is not None
                else None
            ),
            "matchesCanonicalContract": caption_windows is not None,
        },
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


def capture_resilience_self_test(root: Path) -> None:
    """Exercise the typed retry controller and stale-output cleanup offline."""

    def narrator_success() -> dict[str, Any]:
        return {
            "answer": "Synthetic grounded answer [1].",
            "hits": [{"id": "memory-1"}],
            "citations": [{"marker": "[1]", "content": "Synthetic fact."}],
            "modelId": EXPECTED_NARRATOR,
            "consistency": {},
            "retrieval": {},
            "grounding": {"status": "passed", "attempts": 1},
        }

    def narrator_transient() -> dict[str, Any]:
        return {
            "answer": "Synthetic fallback [1].",
            "hits": [{"id": "memory-1"}],
            "citations": [{"marker": "[1]", "content": "Synthetic fact."}],
            "modelId": "degraded",
            "consistency": {},
            "retrieval": {},
            "degraded": NARRATOR_DEGRADED_MESSAGE,
            "degradationCode": "upstream_timeout",
            "degradationAttempts": 1,
        }

    def semantic_result(*, transient: bool) -> dict[str, Any]:
        failed = 1 if transient else 0
        return {
            "totalMemories": 2,
            "audited": 2,
            "candidatePairs": 1,
            "compared": 1,
            "modelCalls": 1,
            "judged": 1 - failed,
            "failed": failed,
            "embeddingFailed": 0,
            "truncated": False,
            "status": "partial" if transient else "complete",
            "errors": (
                [{"memoryIds": ["memory-1", "memory-2"], "reason": "judge unavailable"}]
                if transient else []
            ),
            "embeddingErrors": [],
            "semanticContradictions": [] if transient else [{"type": "semantic-contradiction"}],
            "ok": False,
        }

    ledger = CaptureAttemptLedger("20000101T000000Z-00000001", root / "selected-run")
    session_outcomes = [narrator_transient(), narrator_success()]
    run_stage_local_retry(
        stage="session-b-recall",
        operation=lambda: (session_outcomes.pop(0), 200),
        classifier=classify_narrator_stage,
        ledger=ledger,
        sleeper=lambda _delay: None,
    )
    run_stage_local_retry(
        stage="explorer-recall",
        operation=lambda: (narrator_success(), 200),
        classifier=classify_narrator_stage,
        ledger=ledger,
        sleeper=lambda _delay: None,
    )
    semantic_outcomes = [semantic_result(transient=True), semantic_result(transient=False)]
    semantic_recorded: list[tuple[int, Any]] = []
    run_stage_local_retry(
        stage="semantic-audit",
        operation=lambda: (semantic_outcomes.pop(0), 200),
        classifier=classify_semantic_stage,
        ledger=ledger,
        sleeper=lambda _delay: None,
        response_recorder=lambda attempt, payload: semantic_recorded.append((attempt, payload)),
    )
    require(
        [attempt for attempt, _payload in semantic_recorded] == [1, 2]
        and semantic_recorded[0][1]["status"] == "partial"
        and semantic_recorded[1][1]["status"] == "complete",
        "semantic pre-classification response recording self-test failed",
    )
    provenance = ledger.review_provenance()
    require(
        {stage: row["selectedAttempt"] for stage, row in provenance["selectedAttempts"].items()}
        == {"session-b-recall": 2, "explorer-recall": 1, "semantic-audit": 2},
        "capture retry selected-attempt provenance self-test failed",
    )

    exhausted_ledger = CaptureAttemptLedger("20000101T000001Z-00000002", root / "exhausted-run")
    exhausted = False
    try:
        run_stage_local_retry(
            stage="explorer-recall",
            operation=lambda: (narrator_transient(), 200),
            classifier=classify_narrator_stage,
            ledger=exhausted_ledger,
            sleeper=lambda _delay: None,
        )
    except GateError:
        exhausted = True
    require(exhausted and len(exhausted_ledger.records) == 3, "capture retry exhaustion self-test failed")

    rejected_ledger = CaptureAttemptLedger("20000101T000002Z-00000003", root / "rejected-run")
    calls = 0

    def rejected_operation() -> tuple[Any, int]:
        nonlocal calls
        calls += 1
        return {"modelId": "unknown"}, 200

    run_stage_local_retry(
        stage="explorer-recall",
        operation=rejected_operation,
        classifier=classify_narrator_stage,
        ledger=rejected_ledger,
        sleeper=lambda _delay: None,
    )
    require(calls == 1 and rejected_ledger.records[0]["outcome"] == "rejected-no-retry", "capture no-retry self-test failed")
    require(
        all(
            quota["workUnitsPerAttempt"] * STAGE_LOCAL_MAX_ATTEMPTS <= quota["limit"]
            for quota in STAGE_LOCAL_RETRY_QUOTA.values()
        ),
        "capture retry quota-bound self-test failed",
    )
    require(
        STAGE_LOCAL_RETRY_QUOTA["semantic-audit"]["workUnitsPerAttempt"] == 1
        and STAGE_LOCAL_RETRY_QUOTA["semantic-audit"]["workUnitsPerAttempt"] * STAGE_LOCAL_MAX_ATTEMPTS == 3,
        "bounded semantic capture quota self-test failed",
    )
    validate_canonical_semantic_request(dict(CANONICAL_SEMANTIC_REQUEST))
    rejected_scope = False
    try:
        validate_canonical_semantic_request({"company": "Northwind Trading", "kind": "insight"})
    except GateError:
        rejected_scope = True
    require(rejected_scope, "canonical semantic request self-test accepted an unbounded request")

    rejected_public_detail = False
    try:
        validate_semantic_public_observation({
            "httpStatus": 200,
            "payloadShape": "object",
            "memoryIds": ["private-memory-id"],
        })
    except GateError:
        rejected_public_detail = True
    require(rejected_public_detail, "semantic public evidence self-test accepted raw memory IDs")

    for reason, expected_class, expected_decision in (
        ("judge unavailable", "judge-unavailable", "retryable"),
        ("unparseable judge response", "unparseable-response", "rejected"),
        ("statement exceeds judge input limit", "input-limit", "rejected"),
        ("private arbitrary provider text", "other", "rejected"),
    ):
        payload = semantic_result(transient=True)
        payload["errors"][0]["reason"] = reason
        decision, _classification, observation = classify_semantic_stage(payload, 200)
        serialized_observation = json.dumps(observation, ensure_ascii=False)
        require(
            decision == expected_decision
            and observation["errorClasses"] == [expected_class]
            and reason not in serialized_observation
            and "memory-1" not in serialized_observation,
            "semantic fixed-enum public evidence self-test failed",
        )

    private_fixture = root / "private-originals"
    private_fixture.mkdir()
    source = private_fixture / "alibaba-ecs-overview-raw.png"
    source.write_bytes(b"canonical-source")
    stale = private_fixture / "04-semantic-audit-response.json"
    stale.write_text("{}\n", encoding="utf-8")
    snapshot = root / "attempt-snapshots" / "prior.json"
    snapshot.parent.mkdir()
    snapshot.write_text("{}\n", encoding="utf-8")
    prepare_private_capture_run(
        "20000101T000003Z-00000004",
        private_root=private_fixture,
        protected_inputs=(source,),
    )
    require(source.is_file() and not stale.exists() and snapshot.is_file(), "private stale-output cleanup self-test failed")


def collect_live_submission_evidence(
    *,
    base_url: str,
    repo_url: str,
    reviewer_token: str,
    expected_sha: str,
    observed_at: str,
    attempt_ledger: CaptureAttemptLedger,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Run live gates with the scarce document-ingest reservation last.

    The qwen-vl-max dry run atomically reserves ten authenticated ingest work
    units.  Session-B recall and the Explorer's recall/semantic/browser proof are
    availability-sensitive, so they must pass before that reservation is made.
    The vision result remains fresh, live, zero-write evidence from this same
    capture run; only its position changes.
    """

    print("[2/10] public health/readiness, authenticated deep readiness, seed and selected-company P&L")
    probes = public_release_probes(base_url, reviewer_token)

    print("[3/10] Session-A feedback, fresh Session-B application, one-row lifecycle + cleanup")
    feedback_proof = feedback_persistence_and_lifecycle_proof(
        base_url, reviewer_token, probes, attempt_ledger
    )

    print("[4/10] canonical Explorer recall, field audit, semantic audit and honest Defer-only capture")
    captured = contained_browser_capture(
        base_url, repo_url, reviewer_token, expected_sha, observed_at, probes, attempt_ledger
    )

    # Keep this after every stochastic recall/semantic/browser gate.  A failure
    # above therefore cannot consume the scarce 10-unit document-ingest charge.
    print("[5/10] original-synthetic qwen-vl-max dry-run canary + exact absence gate")
    vision_canary = vision_document_canary(base_url, reviewer_token, expected_sha)
    probes["visionCanary"] = vision_canary
    return probes, feedback_proof, captured, vision_canary


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
    long_footer_canvas = Image.new("RGB", CANVAS, "#06110e")
    long_footer_mode = draw_live_footer(
        ImageDraw.Draw(long_footer_canvas),
        left_text="L" * 110,
        right_text="R" * 110,
    )
    require(long_footer_mode == "two-row", "long-footer self-test did not exercise the collision-safe layout")
    strip_and_save(long_footer_canvas, root / "long-footer.png", size=CANVAS, min_bytes=1_000)
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
    alibaba_fixture = root / "alibaba-3x2.png"
    render_alibaba_card(
        alibaba_fixture,
        raw,
        probes,
        base_url=DEFAULT_BASE_URL,
        expected_sha="0" * 40,
        observed_at="2000-01-01T00:00:00Z",
    )
    repository_fixture = root / "repository-3x2.png"
    render_repository_card(
        raw_path,
        repository_fixture,
        repo_url=DEFAULT_REPO_URL,
        remote_main="0" * 40,
        observed_at="2000-01-01T00:00:00Z",
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
    require(Image.open(alibaba_fixture).size == GALLERY_CANVAS, "Alibaba-card self-test failed")
    require(Image.open(repository_fixture).size == GALLERY_CANVAS, "repository-card self-test failed")
    require(Image.open(root / "youtube-thumbnail.png").size == (1280, 720), "YouTube thumbnail self-test failed")
    capture_resilience_self_test(root / "capture-resilience")
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
    parser.add_argument("--video-manifest", help="legacy draft input; rejected by the canonical capture gate")
    parser.add_argument("--web-narration", help="legacy draft input; rejected by the canonical capture gate")
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
        validate_production_caption_inputs(
            caption_windows=args.caption_windows,
            allow_canonical_fallback=args.allow_canonical_caption_fallback,
            video_manifest=args.video_manifest,
            web_narration=args.web_narration,
        )
        expected_sha = str(args.expected_sha).lower()
        deployment_output = snapshot_project_file(args.deployment_output, "deployment output")
        deployment_status = snapshot_project_file(args.deployment_status, "deployment status")
        raw_alibaba_source = project_path(args.alibaba_raw, "Alibaba raw capture", must_exist=True)
        redaction_profile = project_path(args.alibaba_redaction_profile, "Alibaba redaction profile", must_exist=True)
        caption_windows = snapshot_project_file(args.caption_windows, "caption windows") if args.caption_windows else None
        caption_contract = snapshot_project_file(CAPTION_CONTRACT, "canonical caption-video timeline")
        video_manifest = None
        web_narration = None
        reviewer_credential_source = (
            project_path(args.reviewer_credential_json, "reviewer credential JSON", must_exist=True)
            if args.reviewer_credential_json
            else None
        )

        if caption_windows is not None:
            # Fail before run setup, live Qwen calls, mutations, or quota use when
            # an ignored measured-timeline artifact has drifted from the tracked
            # final-video contract.
            validate_canonical_caption_windows(caption_windows, caption_contract)
        base_url = validate_live_origin(str(args.base_url))
        reviewer_token = reviewer_token_from_args(args)

        PRIVATE.mkdir(parents=True, exist_ok=True)
        GALLERY.mkdir(parents=True, exist_ok=True)
        FINAL_MEDIA.mkdir(parents=True, exist_ok=True)
        require(ARCHITECTURE.is_file(), "canonical architecture image is missing")

        run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{secrets.token_hex(4)}"
        capture_run_dir = prepare_private_capture_run(
            run_id,
            protected_inputs=tuple(
                path
                for path in (
                    raw_alibaba_source,
                    redaction_profile,
                    caption_windows.path if caption_windows is not None else None,
                    video_manifest.path if video_manifest is not None else None,
                    web_narration.path if web_narration is not None else None,
                    reviewer_credential_source,
                )
                if path is not None
            ),
        )
        set_active_private_output_dir(capture_run_dir)
        attempt_ledger = CaptureAttemptLedger(run_id, capture_run_dir)
        # A failed new run must never leave an older PASS manifest looking current.
        previous_review = GALLERY / "CAPTURE_REVIEW.json"
        if previous_review.exists() or previous_review.is_symlink():
            require(previous_review.is_file() and not previous_review.is_symlink(), "prior capture review path is unsafe")
            previous_review.unlink()

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

        probes, feedback_proof, captured, vision_canary = collect_live_submission_evidence(
            base_url=base_url,
            repo_url=args.repo_url,
            reviewer_token=reviewer_token,
            expected_sha=expected_sha,
            observed_at=observed_at,
            attempt_ledger=attempt_ledger,
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
            caption_contract=caption_contract,
            caption_windows=caption_windows,
            base_url=base_url,
            observed_at=observed_at,
            probes=probes,
            feedback_proof=feedback_proof,
            vision_canary=vision_canary,
            hashes=hashes,
            srt_source=srt_source,
            attempt_ledger=attempt_ledger,
        )
        print(f"submission media gate: PASS · exact runtime {expected_sha[:12]} · {len(hashes)} reviewed artifacts")
        return 0
    except GateError as exc:
        print(f"submission media gate: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
