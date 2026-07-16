# Production image supply-chain gate

The production-image gate is
[`.github/workflows/supply-chain.yml`](../.github/workflows/supply-chain.yml).
It builds the same root `Dockerfile` used for deployment, inventories the exact
local image ID, retains two standard SBOM formats, and scans the sealed Syft JSON
inventory. A green hosted run means that this defined program completed for its
recorded commit and dated vulnerability database. It is **not a security
certification** and does not prove that no vulnerability exists.

## Security invariant

The release boundary fails closed unless all of these statements hold:

1. `Dockerfile`, `.dockerignore`, `.gitattributes`, `package-lock.json`,
   `.syft.yaml`, and `.grype.yaml` match reviewed SHA-256 identities and are
   regular, single-link, LF-only files.
2. Both stages use the exact digest-pinned Node 24.18.0 Alpine image, matching
   package metadata and CI. The Docker build selects the production `runtime`
   target, Linux AMD64, no base pull, and no build cache. The emitted
   application has no native addon, and the constrained canary imports core
   compiled application modules under the final runtime.
3. The built image ID is carried as an immutable step output. The runtime
   configuration must match the production contract, including the exact
   `docker-entrypoint.sh` inherited from the digest-pinned official Node image.
   That default entrypoint is actively exercised under no-network, read-only,
   capability-free constraints before a separate static boundary canary and
   inventory.
4. Official Syft v1.46.0 and Grype v0.115.0 Linux AMD64 archives and their
   extracted executables match independent SHA-256 anchors before every use.
   They are invoked by project-local path, never a mutable `PATH` lookup.
5. Both scanners receive explicit hash-checked policies. Syft has no catalog
   exclusion; Grype has no ignored finding, no external enrichment, and no
   implicit tool or database update.
6. The Grype v6.1.8 database archive is fetched from its exact URL and must match
   its fixed SHA-256 before import. The result is therefore only **as of
   2026-07-15**, the snapshot build date.
7. Syft inventories the exact image ID. The gate validates non-empty Syft,
   SPDX 2.3, and CycloneDX JSON documents and proves that all 203 production
   package-lock entries (196 distinct `name@version` pairs) appear in the
   inventory.
8. The Syft JSON SHA-256 is sealed and carried as a step output. Both Grype
   report generation and the independent severity gate recheck the same sealed
   file immediately before use.
9. Every **high or critical** finding fails the job, including a finding with no
   available fix. There is no current CVE allowlist and no `only-fixed`,
   `exclude`, `continue-on-error`, or equivalent weakening.

The only workflow permissions are `contents: read` and
`security-events: write`. The latter is required solely to publish the retained
Grype SARIF to GitHub code scanning. SARIF publication is skipped for untrusted
fork pull requests; image build, SBOM creation, and the local fail-closed CVE
gate still run.

## Exact pins

| Input | Reviewed identity |
|---|---|
| Build base | `node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd` |
| Runtime base | `node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd` |
| Syft archive | v1.46.0 · SHA-256 `d654f678b709eb53c393d38519d5ed7d2e57205529404018614cfefa0fb2b5ca` |
| Syft executable | SHA-256 `574df1a0862ff88ad933be214e81069e35b17618a13e019f8f1c84fe063222a2` |
| Grype archive | v0.115.0 · SHA-256 `3fad92940650e514c0aa2dad83526942a055e210cec09a8a59d9c024adc2b90e` |
| Grype executable | SHA-256 `05ffd2c28a607e48fb2269d9aac5b3d53e8a51bbac501946644745eae2119907` |
| Vulnerability DB | schema v6.1.8, built 2026-07-15 · SHA-256 `0d9ac9d49c93649ea6bf713c60960b46e33c939d49ac7de52df649453d29cf8e` |
| GitHub Actions | Full 40-character release commits; checked by `npm run test:docs` |

The final image removes npm, npx, Corepack, Yarn, and pnpm after the pinned
runtime stage is selected. The service starts compiled JavaScript with `node`;
no package manager or install path is required in production. The constrained
runtime canary fails if those tools or their global module directory return.

`package-lock.json` also integrity-locks the npm registry artifacts. The
workflow records Docker, scanner, policy, database, source-commit, image-ID, and
input hashes as provenance; this is traceability, not a claim of byte-identical
image reconstruction across Docker engines.

## Retained evidence

A successful inventory stage uploads `production-sbom-<commit>` for 30 days
**before vulnerability scanning can fail**. It contains:

- Syft JSON, SPDX 2.3 JSON, and CycloneDX JSON;
- the sealed scanned-SBOM hash and pre-scan `SBOM-SHA256SUMS`;
- source/image/tool/database provenance and effective scanner policies;
- exact snapshotted production inputs, Docker/scanner versions, image config,
  default-entrypoint output, and constrained-runtime boundary evidence.

The final `production-supply-chain-<commit>` artifact additionally retains
Grype JSON, SARIF 2.1.0, a human-readable report, a severity-only summary, and
`SHA256SUMS`. The final upload uses `always()`, so reports remain available
when the high/critical gate rejects the image. All generated files and tools
remain under the repository workspace's ignored `.artifacts/` tree.

## Change and exception policy

The pinned database is deliberately immutable. Refreshing vulnerability
intelligence requires one reviewed change to its URL, archive SHA-256, build
date, documentation, and anti-weakening test, followed by a new hosted run.

An exception is never added merely to make CI green. A future exception must
name the exact vulnerability and package, document reachability and compensating
controls, name an owner and expiry, and update the fitness test in the same
review. There are no exceptions in this revision.

`.github/CODEOWNERS` routes changes to the production image, package lock,
scanner policies, workflow, documentation, and fitness test to the repository
owner. Local contract verification is:

```bash
npm ci
npm run test:docs
```

The full image/SBOM/CVE program is authoritative only in the hosted Ubuntu
workflow because it needs Docker plus the pinned Linux scanner and database
downloads. Do not claim a green image gate until that exact commit's hosted
`Production Image Supply Chain` run succeeds.
