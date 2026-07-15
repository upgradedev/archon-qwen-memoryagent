#!/usr/bin/env python3
"""Versioned, non-overwritable Mem0 comparison evidence.

This is a deliberately narrow probe against one pinned Mem0 version/configuration:

* five objective top-5 figure-presence retrieval checks; and
* a Python ``dir()`` public-method-name inspection plus four observed conflict
  write/search cases.

An empty name match proves only that no separately named public method contained
one of the disclosed substrings. It does not prove that Mem0 lacks internal,
undocumented, differently named, or newer-version conflict handling.

Historical ``bench/external/mem0-evidence.json`` is immutable. New evidence uses:

    DASHSCOPE_API_KEY=... python bench/external/mem0_headtohead.py \
      --attempt-id=20260715T120000Z

Credentials are read from the process environment only and are never printed or
persisted. Run from a committed, clean repository. Do not use a custom provider
endpoint: comparison v2 is bound to the official DashScope international URL.
"""
from __future__ import annotations

import argparse
import atexit
import datetime
import hashlib
import importlib.metadata
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from typing import Any
from urllib.parse import urlsplit


HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
PROTOCOL_PATH = REPO / "bench" / "protocol" / "mem0-headtohead-v2.json"
DATA_PATH = HERE / "data.json"
LEDGER_PATH = HERE / "mem0-evidence-v2-attempts.jsonl"
OFFICIAL_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
METHOD_TERMS = ("consist", "contradict", "conflict", "resolve", "audit")
ATTEMPT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$")

PROTOCOL_BYTES = PROTOCOL_PATH.read_bytes()
PROTOCOL: dict[str, Any] = json.loads(PROTOCOL_BYTES)
DATA_BYTES = DATA_PATH.read_bytes()
DATA: dict[str, Any] = json.loads(DATA_BYTES)

QDRANT_DIRS: list[pathlib.Path] = []


class PreflightError(RuntimeError):
    """A safe, operator-actionable failure that occurred before provider work."""


def utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_text_bytes(value: bytes) -> bytes:
    """Make source/data attestations independent of Git checkout line endings."""
    return value.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def validate_attempt_id(value: str | None) -> str:
    if value is None or ATTEMPT_ID.fullmatch(value) is None:
        raise PreflightError("--attempt-id must be 8-80 safe letters, digits, dot, underscore or hyphen")
    return value


def normalized_provider_base_url(raw: str | None = None) -> str:
    candidate = raw or os.environ.get("DASHSCOPE_BASE_URL") or OFFICIAL_BASE_URL
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except (TypeError, ValueError):
        raise PreflightError("the official DashScope international base URL is required") from None
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname != "dashscope-intl.aliyuncs.com"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") != "/compatible-mode/v1"
    ):
        raise PreflightError("the official DashScope international base URL is required")
    return OFFICIAL_BASE_URL


def git_output(*args: str) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=REPO, text=True, encoding="utf-8", stderr=subprocess.DEVNULL
    ).strip()


def capture_clean_repository(attempt_id: str) -> dict[str, Any]:
    try:
        commit = git_output("rev-parse", "HEAD")
        branch = git_output("branch", "--show-current") or "(detached)"
        status = git_output("status", "--porcelain=v1", "--untracked-files=all")
    except (OSError, subprocess.CalledProcessError):
        raise PreflightError("a committed Git repository is required") from None
    if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        raise PreflightError("a committed Git HEAD is required")
    if status:
        raise PreflightError("a clean whole repository is required before provider work")
    return {
        "gitCommit": commit,
        "gitBranch": branch,
        "gitWholeTreeCleanAtStart": True,
        "capturedAt": utc_now(),
        "command": f"python bench/external/mem0_headtohead.py --attempt-id={attempt_id}",
    }


def source_evidence() -> dict[str, Any]:
    entries: list[dict[str, str]] = []
    bundle = hashlib.sha256()
    for relative in PROTOCOL.get("sourceFiles", []):
        if not isinstance(relative, str) or not re.fullmatch(r"[A-Za-z0-9_./-]+", relative):
            raise PreflightError("protocol source manifest contains an unsafe path")
        parts = pathlib.PurePosixPath(relative).parts
        if relative.startswith("/") or ".." in parts:
            raise PreflightError("protocol source manifest contains an unsafe path")
        path = REPO.joinpath(*parts)
        digest = sha256_bytes(canonical_text_bytes(path.read_bytes()))
        entries.append({"path": relative, "sha256": digest})
        bundle.update(relative.encode("utf-8") + b"\0" + digest.encode("ascii") + b"\n")
    return {"files": entries, "bundleSha256": bundle.hexdigest()}


def validate_protocol() -> tuple[str, str, dict[str, Any]]:
    if PROTOCOL.get("version") != "mem0-headtohead-v2":
        raise PreflightError("unexpected Mem0 comparison protocol version")
    dataset_sha = sha256_bytes(canonical_text_bytes(DATA_BYTES))
    if dataset_sha != PROTOCOL.get("datasetSha256"):
        raise PreflightError("comparison dataset changed; create a new protocol version")
    if len(DATA.get("conflictPairs", [])) != PROTOCOL.get("conflictPairs"):
        raise PreflightError("comparison conflict-pair count changed")
    if len(DATA.get("retrievalProbe", [])) != PROTOCOL.get("retrievalProbes"):
        raise PreflightError("comparison retrieval-probe count changed")
    provider = PROTOCOL.get("provider", {})
    if provider.get("baseUrl") != OFFICIAL_BASE_URL or provider.get("customEndpointsAllowed") is not False:
        raise PreflightError("comparison provider invariant changed")
    return dataset_sha, sha256_bytes(canonical_text_bytes(PROTOCOL_BYTES)), source_evidence()


def artifact_path(attempt_id: str) -> pathlib.Path:
    return HERE / f"mem0-evidence-v2-attempt-{attempt_id}.json"


def publish_exclusive(path: pathlib.Path, value: dict[str, Any]) -> None:
    if path.exists():
        raise PreflightError("attempt evidence already exists; use a new attempt id")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            raise PreflightError("attempt evidence already exists; use a new attempt id") from None
    finally:
        temporary.unlink(missing_ok=True)


def append_ledger(value: dict[str, Any]) -> None:
    line = (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    descriptor = os.open(LEDGER_PATH, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        os.write(descriptor, line)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def cleanup_workdirs() -> None:
    for path in QDRANT_DIRS:
        shutil.rmtree(path, ignore_errors=True)


atexit.register(cleanup_workdirs)


def make_memory(memory_class: Any, work_root: pathlib.Path) -> Any:
    qpath = pathlib.Path(tempfile.mkdtemp(prefix="qdrant_", dir=work_root))
    QDRANT_DIRS.append(qpath)
    models = PROTOCOL["models"]
    cfg = {
        "llm": {
            "provider": "openai",
            "config": {"model": models["llm"], "temperature": models["llmTemperature"]},
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": models["embedder"],
                "embedding_dims": models["embeddingDimensions"],
            },
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "embedding_model_dims": models["embeddingDimensions"],
                "path": str(qpath),
                "on_disk": False,
            },
        },
    }
    return memory_class.from_config(cfg)


def norm(value: Any) -> str:
    return str(value).replace(",", "").replace("€", "").lower()


def figure_present(memories: list[str], figure: Any) -> bool:
    return norm(figure) in " ".join(norm(memory) for memory in memories)


def contradiction_probe(memory: Any) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    rows: list[dict[str, Any]] = []
    public_names = sorted(name for name in dir(memory) if not name.startswith("_"))
    matching_names = [
        name for name in public_names if any(term in name.lower() for term in METHOD_TERMS)
    ]
    for pair in DATA["conflictPairs"]:
        user_id = f"probe-{pair['record']}"
        memory.add(pair["a"]["content"], user_id=user_id)
        memory.add(pair["b"]["content"], user_id=user_id)
        response = memory.search(
            f"What is the {pair['attribute']} of {pair['record']}?",
            filters={"user_id": user_id},
            version="v2",
        )
        memories = [item.get("memory", "") for item in response.get("results", [])]
        rows.append({
            "record": pair["record"],
            "attribute": pair["attribute"],
            "valueA": pair["a"]["value"],
            "valueB": pair["b"]["value"],
            "returnedMemoryStrings": memories,
            "bothValuesPresentInReturnedMemoryStrings": (
                figure_present(memories, pair["a"]["value"])
                and figure_present(memories, pair["b"]["value"])
            ),
            "searchResponseTopLevelKeys": sorted(str(key) for key in response.keys()),
        })
    return rows, matching_names, public_names


def retrieval_probe(memory: Any) -> dict[str, Any]:
    user_id = "corpus"
    for item in DATA["corpus"]:
        memory.add(item["content"], user_id=user_id)
    rows: list[dict[str, Any]] = []
    hits = 0
    for probe in DATA["retrievalProbe"]:
        response = memory.search(
            probe["question"], filters={"user_id": user_id}, version="v2", limit=5
        )
        memories = [item.get("memory", "") for item in response.get("results", [])]
        present = figure_present(memories, probe["goldFigure"])
        hits += int(present)
        rows.append({
            "id": probe["id"],
            "question": probe["question"],
            "goldFigure": probe["goldFigure"],
            "figureInTop5": present,
            "topMemoryStrings": memories[:5],
        })
    return {
        "probes": rows,
        "hits": hits,
        "total": len(rows),
        "figureRecallAt5": f"{hits}/{len(rows)}",
    }


def base_evidence(
    attempt_id: str,
    repository: dict[str, Any],
    provider_base_url: str,
    dataset_sha: str,
    protocol_sha: str,
    source: dict[str, Any],
    started_at: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "attemptId": attempt_id,
        "evaluationClass": "observed-fixture-pinned-mem0-comparison",
        "startedAt": started_at,
        "protocol": {"version": PROTOCOL["version"], "sha256": protocol_sha},
        "dataset": {
            "path": PROTOCOL["dataset"],
            "sha256": dataset_sha,
            "conflictPairs": PROTOCOL["conflictPairs"],
            "retrievalProbes": PROTOCOL["retrievalProbes"],
        },
        "source": source,
        "repository": repository,
        "provider": {
            "service": PROTOCOL["provider"]["service"],
            "baseUrl": provider_base_url,
            "region": PROTOCOL["provider"]["region"],
        },
        "models": PROTOCOL["models"],
        "caveats": [
            "Small developer-authored fixture; not production prevalence or a broad product benchmark.",
            "Mem0 writes are LLM-driven; one attempt is not a deterministic or statistically powered estimate.",
            PROTOCOL["publicMethodNameProbe"]["safeInterpretation"],
            "Figure presence is a literal number-bearing retrieval check, not semantic answer quality.",
            "No attempt is selected or discarded; compare versions/configurations only with explicit disclosure.",
        ],
    }


def run_attempt(attempt_id: str) -> pathlib.Path:
    attempt_id = validate_attempt_id(attempt_id)
    dataset_sha, protocol_sha, source = validate_protocol()
    provider_base_url = normalized_provider_base_url()
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        raise PreflightError("DASHSCOPE_API_KEY is required in the process environment")
    target = artifact_path(attempt_id)
    if target.exists():
        raise PreflightError("attempt evidence already exists; use a new attempt id")

    # This snapshot must precede work-directory creation, provider imports/calls,
    # artifact creation and ledger writes.
    repository = capture_clean_repository(attempt_id)
    started_at = utc_now()
    base = base_evidence(
        attempt_id, repository, provider_base_url, dataset_sha, protocol_sha, source, started_at
    )
    stage = "dependency_initialization"
    try:
        os.environ["OPENAI_API_KEY"] = key
        os.environ["OPENAI_BASE_URL"] = provider_base_url
        from mem0 import Memory  # type: ignore  # noqa: E402

        mem0_version = importlib.metadata.version("mem0ai")
        if mem0_version != PROTOCOL["dependencies"]["requiredMem0Version"]:
            raise RuntimeError("pinned Mem0 version mismatch")
        qdrant_version = importlib.metadata.version("qdrant-client")
        runtime = {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "mem0Version": mem0_version,
            "qdrantClientVersion": qdrant_version,
        }
        work_root = REPO / ".artifacts" / "work" / "mem0-headtohead" / attempt_id
        work_root.mkdir(parents=True, exist_ok=False)

        stage = "contradiction_probe"
        contradictions, matching_names, public_names = contradiction_probe(
            make_memory(Memory, work_root)
        )
        stage = "retrieval_probe"
        retrieval = retrieval_probe(make_memory(Memory, work_root))
        completed_at = utc_now()
        evidence = {
            **base,
            "status": "completed",
            "completedAt": completed_at,
            "runtime": runtime,
            "publicMethodNameProbe": {
                "terms": list(METHOD_TERMS),
                "matchingPublicNames": matching_names,
                "allPublicNames": public_names,
                "interpretation": PROTOCOL["publicMethodNameProbe"]["safeInterpretation"],
            },
            "contradictionObservation": contradictions,
            "retrievalParityProbe": retrieval,
        }
        publish_exclusive(target, evidence)
        try:
            append_ledger({
                "event": "attempt_completed",
                "attemptId": attempt_id,
                "artifact": f"bench/external/{target.name}",
                "completedAt": completed_at,
                "gitCommit": repository["gitCommit"],
                "protocolSha256": protocol_sha,
                "datasetSha256": dataset_sha,
                "sourceBundleSha256": source["bundleSha256"],
                "status": "completed",
            })
        except OSError:
            # The exclusive complete artifact is authoritative. Never rewrite it
            # merely because the secondary append-only index was unavailable.
            print("Mem0 comparison warning: completed artifact was published but ledger append failed", file=sys.stderr)
        return target
    except Exception:
        if target.exists():
            raise RuntimeError("Mem0 comparison attempt id was claimed concurrently") from None
        failed_at = utc_now()
        failure = {
            **base,
            "status": "failed",
            "failedAt": failed_at,
            "failure": f"{stage}_failed",
        }
        publish_exclusive(target, failure)
        try:
            append_ledger({
                "event": "attempt_failed",
                "attemptId": attempt_id,
                "artifact": f"bench/external/{target.name}",
                "failedAt": failed_at,
                "gitCommit": repository["gitCommit"],
                "protocolSha256": protocol_sha,
                "datasetSha256": dataset_sha,
                "sourceBundleSha256": source["bundleSha256"],
                "status": "failed",
                "failure": f"{stage}_failed",
            })
        except OSError:
            pass
        raise RuntimeError("Mem0 comparison attempt failed; inspect the repo-local attempt artifact") from None
    finally:
        cleanup_workdirs()


def self_test() -> None:
    assert canonical_text_bytes(b"first\r\nsecond\rthird\n") == b"first\nsecond\nthird\n"
    assert normalized_provider_base_url(OFFICIAL_BASE_URL + "/") == OFFICIAL_BASE_URL
    for invalid in (
        "http://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "https://example.test/compatible-mode/v1",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1?proxy=1",
    ):
        try:
            normalized_provider_base_url(invalid)
        except PreflightError:
            pass
        else:
            raise AssertionError("custom endpoint was accepted")
    validate_protocol()
    test_dir = REPO / ".artifacts" / "mem0-evidence-self-test"
    test_dir.mkdir(parents=True, exist_ok=True)
    path = test_dir / f"exclusive-{os.getpid()}-{uuid.uuid4().hex}.json"
    try:
        publish_exclusive(path, {"complete": True})
        assert json.loads(path.read_text(encoding="utf-8")) == {"complete": True}
        try:
            publish_exclusive(path, {"complete": False})
        except PreflightError:
            pass
        else:
            raise AssertionError("evidence overwrite was accepted")
    finally:
        path.unlink(missing_ok=True)
        try:
            test_dir.rmdir()
        except OSError:
            pass
    print("mem0 evidence self-test passed")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run versioned Mem0 comparison evidence")
    parser.add_argument("--attempt-id")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test and args.attempt_id:
        parser.error("--self-test and --attempt-id are mutually exclusive")
    if not args.self_test:
        validate_attempt_id(args.attempt_id)
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        self_test()
        return 0
    try:
        target = run_attempt(args.attempt_id)
    except PreflightError as error:
        print(f"Mem0 comparison preflight failed: {error}", file=sys.stderr)
        return 2
    except Exception:
        print("Mem0 comparison failed; inspect the repo-local attempt artifact when created", file=sys.stderr)
        return 1
    print(f"Mem0 comparison completed: bench/external/{target.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
