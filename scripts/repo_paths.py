#!/usr/bin/env python3
"""Fail-closed repository path resolution for submission/media artifacts."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import stat
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class ProjectFileSnapshot:
    """Immutable bytes read once from one regular, singly-linked project file."""

    path: Path
    relative_path: str
    data: bytes
    sha256: str
    size: int

    def text(self, *, encoding: str = "utf-8", errors: str = "strict") -> str:
        return self.data.decode(encoding, errors=errors)


def _is_symlink_or_reparse(metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    file_attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(reparse_flag and file_attributes & reparse_flag)


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev,
        left.st_ino,
        stat.S_IFMT(left.st_mode),
    ) == (
        right.st_dev,
        right.st_ino,
        stat.S_IFMT(right.st_mode),
    )


def _reject_reparse_components(path: Path, label: str) -> None:
    root = REPO_ROOT.resolve(strict=True)
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} must resolve inside this repository") from exc
    current = root
    for part in relative.parts:
        current /= part
        try:
            metadata = current.lstat()
        except OSError as exc:
            raise ValueError(f"{label} must exist inside this repository") from exc
        if _is_symlink_or_reparse(metadata):
            raise ValueError(f"{label} must not traverse a symlink or reparse point")


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


def read_project_file_once(value: str | Path, label: str) -> ProjectFileSnapshot:
    """Read one immutable evidence snapshot through a verified regular-file FD.

    The lexical path, every existing component, the opened descriptor, and the
    post-read path must all identify the same project-contained regular file.
    Symlinks/reparse points and multiply-linked files are rejected so a later
    external alias cannot change bytes after validation. Callers must validate
    and publish hashes from ``data``/``sha256`` rather than reopening ``path``.
    """

    raw_text = str(value).strip()
    if not raw_text:
        raise ValueError(f"{label} must be a non-empty repository path")
    raw = Path(raw_text).expanduser()
    candidate = raw if raw.is_absolute() else REPO_ROOT / raw
    lexical = Path(os.path.abspath(candidate))
    root = REPO_ROOT.resolve(strict=True)
    try:
        lexical.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} must exist inside this repository") from exc
    _reject_reparse_components(lexical, label)

    try:
        resolved = lexical.resolve(strict=True)
        relative = resolved.relative_to(root).as_posix()
        before_path = resolved.lstat()
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        raise ValueError(f"{label} must exist inside this repository") from exc
    if _is_symlink_or_reparse(before_path) or not stat.S_ISREG(before_path.st_mode):
        raise ValueError(f"{label} must be a regular file without symlinks or reparse points")
    if before_path.st_nlink != 1:
        raise ValueError(f"{label} must have exactly one filesystem link")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        descriptor = os.open(resolved, flags)
        before_fd = os.fstat(descriptor)
        if not stat.S_ISREG(before_fd.st_mode) or before_fd.st_nlink != 1:
            raise ValueError(f"{label} must remain a singly-linked regular file")
        if not _same_identity(before_path, before_fd):
            raise ValueError(f"{label} changed identity before it could be read")

        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        data = b"".join(chunks)
        after_fd = os.fstat(descriptor)
    except OSError as exc:
        raise ValueError(f"{label} could not be read as stable project evidence") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    try:
        after_path = resolved.lstat()
        _reject_reparse_components(lexical, label)
        still_resolved = lexical.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        raise ValueError(f"{label} changed path identity while it was read") from exc
    if still_resolved != resolved or not all(
        _same_identity(left, right)
        for left, right in (
            (before_path, before_fd),
            (before_fd, after_fd),
            (after_fd, after_path),
        )
    ):
        raise ValueError(f"{label} changed filesystem identity while it was read")
    if after_fd.st_nlink != 1 or after_path.st_nlink != 1:
        raise ValueError(f"{label} acquired another filesystem link while it was read")
    if (
        before_fd.st_size != after_fd.st_size
        or before_fd.st_mtime_ns != after_fd.st_mtime_ns
        or before_fd.st_ctime_ns != after_fd.st_ctime_ns
        or len(data) != after_fd.st_size
    ):
        raise ValueError(f"{label} changed bytes while it was read")

    return ProjectFileSnapshot(
        path=resolved,
        relative_path=relative,
        data=data,
        sha256=hashlib.sha256(data).hexdigest(),
        size=len(data),
    )


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
