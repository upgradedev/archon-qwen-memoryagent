# External comparison evidence — read this first

## Correction to the historical Mem0 artifact

`mem0-evidence.json` is an immutable, pre-hardening historical capture. Its
`interpretation` field uses the over-broad phrases “NO contradiction/resolution
API” and “no conflict flag and no resolution recommendation.” Those sentences
are **not current claims** and must not be quoted as evidence of capability
absence.

The capture supports only this narrow observation: on the pinned object/version,
no separately named public method matched the disclosed contradiction/resolution
substring filter over `dir()`. That observation does not test or exclude
internal, undocumented, differently named, response-embedded, or newer-version
conflict handling. The recorded responses describe only that small fixture and
cannot establish a general product capability absence.

Do not publish or cite `mem0-evidence.json` without this correction.

## Current reproducible path

- Protocol: [`../protocol/mem0-headtohead-v2.json`](../protocol/mem0-headtohead-v2.json)
- Runner: [`mem0_headtohead.py`](./mem0_headtohead.py)
- Offline integrity check: `npm run bench:external:self-test`
- Live attempt: `python bench/external/mem0_headtohead.py --attempt-id=<unique-id>`

The v2 runner pins the package version, official provider endpoint, source and
dataset hashes (canonical LF text bytes, independent of checkout platform),
clean-tree precondition, unique non-overwriting attempt artifact,
append-only ledger, returned memory strings/response keys, and the exact public
method-name matches. A future live artifact remains a bounded comparison—not a
broad benchmark or proof about undocumented behavior.
