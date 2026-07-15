#!/usr/bin/env python3
"""Fail-closed repository path resolution for submission/media artifacts."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]


def inside_repo(value: str | Path, label: str, *, must_exist: bool = False) -> str:
    """Resolve ``value`` under the repository and reject traversal/symlink escapes.

    Relative paths are intentionally rooted at the repository, not the caller's
    current working directory. ``Path.resolve`` follows every existing symlink in
    the path, so an apparently local output cannot redirect persistent artifacts
    outside the shared project tree.
    """

    raw_text = str(value).strip()
    if not raw_text:
        raise ValueError(f"{label} must be a non-empty repository path")
    raw = Path(raw_text).expanduser()
    candidate = raw if raw.is_absolute() else REPO_ROOT / raw
    try:
        resolved = candidate.resolve(strict=must_exist)
        resolved.relative_to(REPO_ROOT)
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        requirement = "must exist inside" if must_exist else "must resolve inside"
        raise ValueError(f"{label} {requirement} this repository") from exc
    return str(resolved)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument("--label", default="path")
    parser.add_argument("--must-exist", action="store_true")
    args = parser.parse_args()
    try:
        print(inside_repo(args.path, args.label, must_exist=args.must_exist))
    except ValueError as exc:
        print(f"repo_paths: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
