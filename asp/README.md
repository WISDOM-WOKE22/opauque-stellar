# @opaquecash/asp

The **Association Set Provider** for the Opaque privacy pool, with a Stellar/Soroban chain
adapter. It is the off-chain curator that decides which deposits are "clean" and publishes
the **association-tree root** that the withdraw circuit proves against. For the testnet
demo it also publishes the mechanical pool **state-tree root** reconstructed from public
`Deposit`/`Withdraw` events, so the browser wallet has both roots required for withdrawal.

```
npm install
npm run typecheck
npm test            # engine reconcile, set/tree, policy, store (offline)
ASP_SECRET=S... npm run indexer:once   # one live reconcile pass against testnet
ASP_SECRET=S... npm run indexer        # loop every ASP_INTERVAL_MS
ASP_SECRET=S... npm run serve          # reconcile loop + /health, /metrics, /manifest
```

## Publication monitoring and reorg guard

Every tick (`indexer.ts`, `server.ts`) wires two safety components into `runPoolTick`:

- **`PublicationMonitor`** (`src/monitor.ts`) tracks how long ago the ASP root last
  published and alerts (logged to stderr as `[ALERT] ...`) once it exceeds
  `ASP_MAX_ROOT_AGE_MS` — the operator learns about a silently stuck publish loop
  before withdrawers do.
- **`ReorgGuard`** (`src/reorg-guard.ts`) tracks ledger continuity across ticks and
  halts publication (logged as `[REORG] ...`) if a batch starts before the last
  committed ledger, instead of baking a suspect root into the manifest.

## HTTP server (`npm run serve`)

`scripts/server.ts` runs the same reconcile loop as `indexer.ts` in the background and
additionally exposes:

| Method | Path        | Purpose                                                                 |
| ------ | ----------- | ------------------------------------------------------------------------ |
| `GET`  | `/health`   | `200` when the last tick succeeded and the root is within `ASP_MAX_ROOT_AGE_MS`; `503` otherwise. |
| `GET`  | `/metrics`  | Prometheus exposition format: tick duration, publication lag, and failure/halt/alert counters. |
| `GET`  | `/manifest` | The current association-set manifest (`data/sets/<poolId>/latest.json`), `404` before the first publish. |
| `GET`  | `/manifest/:root` | A specific historical manifest (`data/sets/<poolId>/<root>.json`). `404` once retention has pruned that root. |
| `GET`  | `/inclusion/:root/:label` | That label's inclusion path for `root`: `{ root, label, index, depositIndex, levels, pathElements, pathIndices }`. `404` if the label is not in that root's set. |

`:root` is a `0x`-prefixed 32-byte hex string and `:label` is a decimal BN254 field
element; anything else is a `400`. Both are validated before being joined into a
path, so a crafted segment cannot escape the set directory.

The inclusion endpoint exists so a withdrawing client can obtain the proof
material for the exact root its proof references instead of reconstructing the
whole association tree from every approved deposit index. The returned path is
re-derived from the manifest's own label list and checked against the root, so a
proof is never served for a set it does not belong to. The SDK consumes it via
`fetchAspInclusion()` and passes the result to `provePoolWithdraw({ aspInclusion })`.

Roots are retained per pool — the most recent `maxSetsPerPool` files (default 50),
oldest evicted first. A root that has been pruned is reported as `404` rather than
being silently substituted with a different set.

Bind host/port/CORS are configured via `ASP_HTTP_HOST` (default `127.0.0.1`),
`ASP_HTTP_PORT` (default `8791`), and `ASP_CORS_ORIGIN` (default `*`).

## What it does (per tick)

`runPoolTick` (`src/engine.ts`):

1. **Read** finalized `Deposit` events from the `privacy-pool` contract (`src/chains/stellar.ts`,
   Soroban `getEvents`, respecting the exact-length topic-match rule).
2. **Screen** each via a pluggable `Policy` (`src/policy.ts`). The shipped v1 policy is
   `approveAll` — every testnet deposit is approved — with an `allowlist` stub and a
   documented `screeningPolicy` hook for real sanctions/risk screening.
3. **Maintain** the ordered approved set and rebuild a depth-20 Poseidon(2) tree
   (`src/set.ts` + `src/merkle.ts`) byte-identical to the `privacy-pool` contract and the
   v3 circuit.
4. **Reconcile ASP**: compare the local association root to the on-chain root and, only on mismatch,
   publish the manifest (`data/sets/<poolId>/<root>.json`) and post `update_asp_root`.
   Reconcile-not-append makes it idempotent and self-healing — a crash mid-publish is
   resolved on the next tick.
5. **Reconcile state**: rebuild the pool state tree from `Deposit` commitments and
   `Withdraw` remainder commitments, then post `update_state_root` only when it differs
   from the latest on-chain state root.

## Trust boundary — liveness + curation, never integrity

The ASP **cannot mint, steal, or forge double-spends.** It only gates withdrawal
*eligibility*:

- The published label list is **self-authenticating**: a withdrawer recomputes the Merkle
  root locally and checks it equals the on-chain `aspRoot`, so a bad list simply fails
  proof generation.
- **State-tree** (commitment) membership — which proves a deposit is real and backed — is
  rebuilt from public pool events and verified against the on-chain state root. The demo
  ASP process publishes that root, but it does not choose the leaves.
- The `privacy-pool` contract enforces a **custody invariant** (aggregate withdrawals ≤
  aggregate deposits) and the SAC balance is the physical backstop, so even the state-root
  publisher cannot authorize unbacked withdrawals.

Under `approveAll`, clients can skip this service entirely and reconstruct the set straight
from on-chain `Deposit` events; the manifest/IPFS path only matters once a selective policy
is used.

## Config (env / `.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `STELLAR_RPC_URL` | testnet RPC | Soroban RPC endpoint |
| `ASP_SECRET` | — (required) | ASP authority `S…` seed (the pool admin in the demo) |
| `ASP_INTERVAL_MS` | `15000` | loop interval |
| `ASP_CONFIRMATIONS` | `1` | confirmations before a deposit is treated as final |
| `ASP_MAX_ROOT_AGE_MS` | `120000` | max age of the last published root before `PublicationMonitor` alerts / `/health` reports unhealthy |
| `ASP_HTTP_HOST` | `127.0.0.1` | `npm run serve` bind host |
| `ASP_HTTP_PORT` | `8791` | `npm run serve` bind port |
| `ASP_CORS_ORIGIN` | `*` | `npm run serve` CORS origin |
| `IPFS_API_URL` | — | optional manifest pinning endpoint |

Pool id + scope are resolved from `deployments/v1/testnet.json`.
