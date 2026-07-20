#!/usr/bin/env python3
"""Materialize hash-pinned deployment evidence from protected CI inputs.

The exact deploy transcript and sanitized status are intentionally ignored and
untracked. GitHub Actions receives their base64 encodings as repository secrets;
this helper decodes them without logging their contents, verifies the expected
byte counts and SHA-256 hashes, and creates the canonical ignored files once.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import Sequence


ROOT = Path(__file__).resolve().parents[2]
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SECRET_NAMES = {
    "output": "MEMORYAGENT_DEPLOY_OUTPUT_B64",
    "status": "MEMORYAGENT_DEPLOY_STATUS_B64",
}
MAX_BYTES = 64 * 1024


class EvidenceError(RuntimeError):
    pass


def require(value: bool, message: str) -> None:
    if not value:
        raise EvidenceError(message)


def project_output(raw: str, label: str) -> Path:
    candidate = Path(raw)
    require(not candidate.is_absolute(), f"{label} path must be project-relative")
    require(".." not in candidate.parts, f"{label} path contains parent traversal")
    lexical = ROOT.joinpath(candidate)
    resolved_parent = lexical.parent.resolve(strict=False)
    ignored_root = (ROOT / ".artifacts" / "deploy").resolve(strict=False)
    try:
        resolved_parent.relative_to(ignored_root)
    except ValueError as exc:
        raise EvidenceError(f"{label} path must stay under .artifacts/deploy") from exc
    require(resolved_parent == lexical.parent.absolute(), f"{label} path uses indirection")
    return lexical


def decode_secret(name: str, label: str) -> bytes:
    encoded = os.environ.pop(name, "")
    require(bool(encoded), f"protected {label} input is missing")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise EvidenceError(f"protected {label} input is not strict base64") from exc
    require(0 < len(payload) <= MAX_BYTES, f"protected {label} input has an invalid size")
    return payload


def verify(payload: bytes, *, expected_sha256: str, expected_bytes: int, label: str) -> None:
    require(SHA256.fullmatch(expected_sha256) is not None, f"{label} SHA-256 is malformed")
    require(expected_bytes > 0, f"{label} expected size is invalid")
    require(len(payload) == expected_bytes, f"{label} byte count differs from the locked release evidence")
    require(
        hashlib.sha256(payload).hexdigest() == expected_sha256,
        f"{label} SHA-256 differs from the locked release evidence",
    )


def write_once(path: Path, payload: bytes, label: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise EvidenceError(f"{label} destination already exists") from exc
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-path", required=True)
    parser.add_argument("--output-sha256", required=True)
    parser.add_argument("--output-bytes", required=True, type=int)
    parser.add_argument("--status-path", required=True)
    parser.add_argument("--status-sha256", required=True)
    parser.add_argument("--status-bytes", required=True, type=int)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        output_path = project_output(args.output_path, "deployment output")
        status_path = project_output(args.status_path, "deployment status")
        require(output_path != status_path, "deployment evidence destinations must be distinct")
        output = decode_secret(SECRET_NAMES["output"], "deployment output")
        status = decode_secret(SECRET_NAMES["status"], "deployment status")
        verify(output, expected_sha256=args.output_sha256, expected_bytes=args.output_bytes, label="deployment output")
        verify(status, expected_sha256=args.status_sha256, expected_bytes=args.status_bytes, label="deployment status")
        try:
            parsed_status = json.loads(status.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EvidenceError("deployment status is not UTF-8 JSON") from exc
        require(isinstance(parsed_status, dict), "deployment status must be a JSON object")
        write_once(output_path, output, "deployment output")
        try:
            write_once(status_path, status, "deployment status")
        except BaseException:
            output_path.unlink(missing_ok=True)
            raise
        print(
            "deployment evidence materialization: PASS | "
            f"output {args.output_sha256} | status {args.status_sha256}"
        )
        return 0
    except (EvidenceError, OSError, ValueError) as exc:
        print(f"deployment evidence materialization: FAIL | {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
