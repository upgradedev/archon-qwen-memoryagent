"""Shared, fail-closed validation for exact Alibaba deployment evidence.

Alibaba Cloud Assistant can return a successful terminal invocation while its
captured output tail stops immediately after an app-specific success marker.  A
missing aggregate marker is accepted only in that narrow case: the independent
status artifact must prove a terminal successful, project-contained invocation
whose output was captured, and the captured prefix must bind both checkout and
app deployment to the expected MemoryAgent SHA.

When an aggregate ``EXACT_DEPLOY_SUCCESS`` marker is present, it remains the
strict source of truth and must itself bind the same SHA.  Error, malformed, or
conflicting markers always fail closed.
"""

from __future__ import annotations

import re
from typing import Any


STRICT_FINAL_MARKER = "strict-final-marker"
TERMINAL_SUCCESS_TRUNCATED_OUTPUT = "terminal-success-truncated-output"

_SHA40 = re.compile(r"[0-9a-f]{40}")
_CHECKOUT = re.compile(r"EXACT_CHECKOUT_OK app=memoryagent sha=([0-9a-f]{40})")
_APP_SUCCESS = re.compile(r"EXACT_APP_(?:DEPLOY|REUSE)_OK app=memoryagent sha=([0-9a-f]{40})(?:\s.*)?")
_FINAL_SUCCESS = re.compile(r"EXACT_DEPLOY_SUCCESS memory=([0-9a-f]{40})(?:\s.*)?")


class ExactDeployEvidenceError(RuntimeError):
    """Deployment evidence is incomplete, contradictory, or not SHA-bound."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ExactDeployEvidenceError(message)


def _marker_shas(lines: list[str], prefix: str, pattern: re.Pattern[str], label: str) -> list[str]:
    relevant = [line for line in lines if line.startswith(prefix)]
    parsed: list[str] = []
    for line in relevant:
        match = pattern.fullmatch(line)
        _require(match is not None, f"deployment output contains a malformed {label} marker")
        parsed.append(match.group(1))
    return parsed


def validate_exact_deploy_evidence(expected_sha: str, status: Any, output: str) -> str:
    """Validate the controller status plus captured marker stream.

    Returns ``STRICT_FINAL_MARKER`` when the aggregate success marker is present,
    otherwise ``TERMINAL_SUCCESS_TRUNCATED_OUTPUT`` for the bounded Alibaba
    captured-tail fallback.
    """

    _require(_SHA40.fullmatch(expected_sha) is not None, "expected SHA must be 40 lowercase hex characters")
    _require(isinstance(status, dict), "deployment status must be a JSON object")
    _require(status.get("memorySha") == expected_sha, "deployment status records a different MemoryAgent SHA")
    _require(status.get("status") == "Success", "deployment status is not Success")
    _require(status.get("terminal") is True, "deployment invocation is not terminal")
    _require(type(status.get("exitCode")) is int and status.get("exitCode") == 0, "deployment invocation exit code is not 0")
    _require(status.get("outputCaptured") is True, "deployment output was not captured")
    _require(status.get("projectContained") is True, "deployment evidence is not project-contained")
    _require(isinstance(output, str), "deployment output must be text")

    lines = output.splitlines()
    _require(
        not any(line.startswith("EXACT_DEPLOY_ERROR") for line in lines),
        "deployment output contains an exact-deploy error marker",
    )

    checkout_shas = _marker_shas(
        lines,
        "EXACT_CHECKOUT_OK app=memoryagent",
        _CHECKOUT,
        "MemoryAgent checkout",
    )
    _require(checkout_shas, "deployment output has no exact MemoryAgent checkout marker")
    _require(set(checkout_shas) == {expected_sha}, "deployment output checkout markers do not all bind the expected MemoryAgent SHA")

    app_shas = _marker_shas(
        lines,
        "EXACT_APP_DEPLOY_OK app=memoryagent",
        _APP_SUCCESS,
        "MemoryAgent app success",
    ) + _marker_shas(
        lines,
        "EXACT_APP_REUSE_OK app=memoryagent",
        _APP_SUCCESS,
        "MemoryAgent app success",
    )
    _require(app_shas, "deployment output has no successful exact MemoryAgent deployment marker")
    _require(set(app_shas) == {expected_sha}, "deployment output app success markers do not all bind the expected MemoryAgent SHA")

    final_shas = _marker_shas(lines, "EXACT_DEPLOY_SUCCESS", _FINAL_SUCCESS, "final exact-deploy success")
    if final_shas:
        _require(set(final_shas) == {expected_sha}, "final exact-deploy success markers do not all bind the expected MemoryAgent SHA")
        return STRICT_FINAL_MARKER

    # The controller status is independent of the bounded captured output.  Only
    # after every terminal/capture/containment gate and both SHA-bound prefix
    # markers pass may a missing provider-truncated tail be accepted.
    return TERMINAL_SUCCESS_TRUNCATED_OUTPUT
