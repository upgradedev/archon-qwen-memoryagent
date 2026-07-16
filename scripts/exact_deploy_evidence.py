"""Shared, fail-closed validation for exact Alibaba deployment evidence.

Alibaba Cloud Assistant can return a successful terminal invocation while its
captured output tail stops immediately after an app-specific success marker.  A
missing aggregate marker is accepted only in that narrow case: the independent
status artifact must prove a terminal successful, project-contained invocation
whose output was captured, and the captured prefix must bind both checkout and
app deployment to the expected MemoryAgent SHA. The producer status must also
name its invocation and command and bind the exact captured output SHA-256 and
byte length; legacy independently supplied status/output pairs are rejected.

When an aggregate ``EXACT_DEPLOY_SUCCESS`` marker is present, it remains the
strict source of truth and must itself bind the same SHA.  Error, malformed, or
conflicting markers always fail closed.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any


STRICT_FINAL_MARKER = "strict-final-marker"
TERMINAL_SUCCESS_TRUNCATED_OUTPUT = "terminal-success-truncated-output"

_SHA40 = re.compile(r"[0-9a-f]{40}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_PRODUCER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")
_CHECKOUT = re.compile(r"EXACT_CHECKOUT_OK app=memoryagent sha=([0-9a-f]{40})")
_APP_DEPLOY_SUCCESS = re.compile(r"EXACT_APP_DEPLOY_OK app=memoryagent sha=([0-9a-f]{40})")
_APP_REUSE_SUCCESS = re.compile(r"EXACT_APP_REUSE_OK app=memoryagent sha=([0-9a-f]{40}) health=ok")
_FINAL_SUCCESS = re.compile(r"EXACT_DEPLOY_SUCCESS memory=([0-9a-f]{40}) autopilot=([0-9a-f]{40})")


class ExactDeployEvidenceError(RuntimeError):
    """Deployment evidence is incomplete, contradictory, or not SHA-bound."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ExactDeployEvidenceError(message)


def _marker_events(
    lines: list[str],
    prefix: str,
    pattern: re.Pattern[str],
    label: str,
) -> list[tuple[int, str]]:
    relevant = [(index, line) for index, line in enumerate(lines) if line.lstrip().startswith(prefix)]
    parsed: list[tuple[int, str]] = []
    for index, line in relevant:
        match = pattern.fullmatch(line)
        _require(match is not None, f"deployment output contains a malformed {label} marker")
        parsed.append((index, match.group(1)))
    return parsed


def validate_exact_deploy_evidence(expected_sha: str, status: Any, output: str | bytes) -> str:
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
    invocation_id = status.get("invocationId")
    command_id = status.get("commandId")
    _require(
        isinstance(invocation_id, str) and _PRODUCER_ID.fullmatch(invocation_id) is not None,
        "deployment status has no safe producer invocationId",
    )
    _require(
        isinstance(command_id, str) and _PRODUCER_ID.fullmatch(command_id) is not None,
        "deployment status has no safe producer commandId",
    )

    _require(isinstance(output, (str, bytes)), "deployment output must be UTF-8 text bytes")
    raw_output = output.encode("utf-8") if isinstance(output, str) else output
    try:
        output_text = raw_output.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ExactDeployEvidenceError("deployment output is not valid UTF-8") from exc
    expected_output_sha = status.get("outputSha256")
    expected_output_bytes = status.get("outputBytes")
    _require(
        isinstance(expected_output_sha, str) and _SHA256.fullmatch(expected_output_sha) is not None,
        "deployment status has no exact lowercase outputSha256",
    )
    _require(type(expected_output_bytes) is int and expected_output_bytes >= 0, "deployment status has no exact outputBytes")
    _require(hashlib.sha256(raw_output).hexdigest() == expected_output_sha, "deployment status outputSha256 does not bind the supplied output")
    _require(len(raw_output) == expected_output_bytes, "deployment status outputBytes does not bind the supplied output")

    lines = output_text.splitlines()
    nonempty_indexes = [index for index, line in enumerate(lines) if line.strip()]
    _require(nonempty_indexes, "deployment output is empty")
    terminal_index = nonempty_indexes[-1]
    _require(
        not any("EXACT_DEPLOY_ERROR" in line for line in lines),
        "deployment output contains an exact-deploy error marker",
    )

    checkout_events = _marker_events(
        lines,
        "EXACT_CHECKOUT_OK app=memoryagent",
        _CHECKOUT,
        "MemoryAgent checkout",
    )
    _require(len(checkout_events) == 1, "deployment output must contain exactly one MemoryAgent checkout marker")
    _require(checkout_events[0][1] == expected_sha, "deployment output checkout marker does not bind the expected MemoryAgent SHA")

    app_events = _marker_events(
        lines,
        "EXACT_APP_DEPLOY_OK app=memoryagent",
        _APP_DEPLOY_SUCCESS,
        "MemoryAgent app success",
    ) + _marker_events(
        lines,
        "EXACT_APP_REUSE_OK app=memoryagent",
        _APP_REUSE_SUCCESS,
        "MemoryAgent app success",
    )
    app_events.sort(key=lambda event: event[0])
    _require(len(app_events) == 1, "deployment output must contain exactly one successful MemoryAgent app marker")
    _require(app_events[0][1] == expected_sha, "deployment output app success marker does not bind the expected MemoryAgent SHA")
    _require(checkout_events[0][0] < app_events[0][0], "MemoryAgent app success marker precedes its checkout marker")

    final_events = _marker_events(lines, "EXACT_DEPLOY_SUCCESS", _FINAL_SUCCESS, "final exact-deploy success")
    _require(len(final_events) <= 1, "deployment output contains multiple final exact-deploy success markers")
    if final_events:
        _require(final_events[0][1] == expected_sha, "final exact-deploy success marker does not bind the expected MemoryAgent SHA")
        _require(app_events[0][0] < final_events[0][0], "final exact-deploy success marker precedes MemoryAgent app success")
        _require(final_events[0][0] == terminal_index, "final exact-deploy success marker is not the terminal captured line")
        return STRICT_FINAL_MARKER

    # The controller status is independent of the bounded captured output.  Only
    # after every terminal/capture/containment gate and both SHA-bound prefix
    # markers pass may a missing provider-truncated tail be accepted. The app
    # marker must be the terminal captured line; any later output disproves this
    # narrow truncation shape and fails closed.
    _require(app_events[0][0] == terminal_index, "truncated deployment output continues after MemoryAgent app success")
    return TERMINAL_SUCCESS_TRUNCATED_OUTPUT
