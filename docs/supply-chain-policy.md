# Supply-Chain Policy

> Tracking issue: [#486 — Add wasm-pack dependency vulnerability monitoring](https://github.com/collinsadi/opaque-stellar/issues/486)
>
> Companion to [CONTRIBUTING.md § 12 (Dependency update policy)](../.github/CONTRIBUTING.md#12-dependency-update-policy).
> Linked from the dependency policy and from the `dependency-audit.yml` scanner job.

This document records the supply-chain guarantees Opaque Stellar commits to, and
the automated gates that enforce them.

## 1. Scope

| Component | Build chain | Pinned artifact |
| --- | --- | --- |
| Soroban contracts (`contracts/`) | `cargo build --target wasm32v1-none` | WASM hash in `deployments/v1/<network>.json` |
| Scanner (`scanner/`) | `wasm-pack` (Rust → WASM) | WASM hash in `artifacts/manifest.json` |
| Circuits (`circuits/`) | `circom` + `snarkjs` | zkey / VK hashes in `deployments/` + ceremony transcript |
| Frontend (`frontend/`) | `vite` | build provenance via pinned `package-lock.json` |

Every binary that ships is **hash-pinned**: its expected hash is recorded in a
manifest and verified by deployment/release gates, so a changed build input
(dependency bump, toolchain change) cannot silently alter shipped bytes.

## 2. Dependency monitoring

### 2.1 Rust (contracts workspace)

Routine: `cargo audit` + `cargo deny check` run on every PR and push to `main`
(the `supply-chain` job in `ci.yml`, path-gated to dependency changes) and on a
weekly schedule (`dependency-audit.yml`, `cargo-audit` job, schedule/manual only
so no event runs the pass twice). The tools are installed as pinned prebuilt
binaries via `.github/actions/install-audit-tools` (single place to bump
versions), not compiled from source. Response windows are in
CONTRIBUTING.md § 12.

### 2.2 Rust WASM build chain (`scanner/`, wasm-pack)

`scanner/` is **not** part of the contracts workspace, so its tree — including
`wasm-bindgen` and the rest of the `wasm32` closure — is audited **separately
and PR-blockingly** (#486):

- The `scanner-audit` job in `dependency-audit.yml` runs `cargo audit` in
  `scanner/` on **every pull request** (and on the weekly schedule). `cargo
  audit` exits non-zero on advisories, which blocks the PR.
- A dedicated step explicitly tracks `wasm-bindgen`, `wasm-bindgen-backend`,
  `wasm-bindgen-macro`, and `wasm-bindgen-macro-support` advisories and fails
  the PR if any are present.
- Advisories follow the CONTRIBUTING.md § 12 SLA (Critical 24–48h, High 7 days,
  …). A Critical/High finding must be fixed or carry a justified
  `cargo audit --ignore` exception before merge.

Local reproduction: `cd scanner && cargo install cargo-audit --locked && cargo audit`.

### 2.3 npm (root + `frontend/`)

`npm audit` across both workspaces on the weekly schedule
(`dependency-audit.yml`, `npm-audit` job), plus `npm run audit:supply-chain`
in release prep.

### 2.4 GitHub Actions

`dependabot.yml` monitors action versions monthly and opens security PRs
immediately on advisory publication.

## 3. Reproducible builds & hash pinning

- **Contracts:** release WASM is built from a tagged source; the resulting hash
  is written to the deployment manifest and verified by
  `scripts/verify-deployment-manifest.ts --strict --check-wasm` (release gate).
- **Scanner:** `npm run build:scanner` produces the WASM the frontend/SDK
  consume; `npm run update:manifest-wasm` refreshes the pinned hash in
  `artifacts/manifest.json`. Re-running the build on a clean checkout must
  reproduce the same hash; a mismatch fails the release gate.
- **Circuits:** zkey / VK hashes are recorded in `deployments/` and the
  ceremony transcript (`circuits/ceremony/`), and can be independently verified
  — see `docs/TRUSTED_SETUP_VERIFICATION.md`.

## 4. Exception handling

Any `cargo audit` / `npm audit` / advisory exception (ignore file, version
hold, or accepted risk) must be:

- Recorded with a rationale and an owner.
- Re-reviewed at the next routine batch (monthly) or sooner if exploited.
- Never silent: the ignore must reference the advisory ID and the tracking
  issue.

## 5. Workflow hardening baseline

Every workflow in `.github/workflows/` must meet this baseline (issue #988):

- **Least-privilege token.** A top-level `permissions:` block declares the
  minimum. The default for a read-only check is `contents: read`. Grant more only
  at the smallest scope that needs it (job level where possible), e.g.
  `security-events: write` for CodeQL, `issues: write` + `pull-requests: write`
  for the stale bot, `pull-requests: read` for the `changes` job's path detection.
- **Every job has `timeout-minutes`**, sized at roughly 2-3x the normal runtime, so a
  hung job cannot burn runner minutes for the 6-hour default.
- **Pinned tooling.** Security tools installed in CI (`cargo-audit`, `cargo-deny`)
  use explicit versions from the shared composite action.

New workflows and new jobs must follow this baseline in review.

## 6. References

- [CONTRIBUTING.md § 12](../.github/CONTRIBUTING.md#12-dependency-update-policy)
- [`dependency-audit.yml`](../.github/workflows/dependency-audit.yml)
- [TRUSTED_SETUP_VERIFICATION.md](TRUSTED_SETUP_VERIFICATION.md)
- [ADMIN_KEY_COMPROMISE_PLAYBOOKS.md](ADMIN_KEY_COMPROMISE_PLAYBOOKS.md)
