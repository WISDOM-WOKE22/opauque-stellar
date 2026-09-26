# ADR-0008: Dataset hash format

**Date:** 2026-06-15
**Status:** Accepted
**Context:** Binding a published Merkle root to its exact leaf set for independent verification

## Problem statement

Both the pool-state/ASP publisher (ASP service) and the reputation publisher
post a Merkle root on-chain alongside a `dataset_hash`. The hash must:

1. Be deterministically reproducible by any verifier who holds the same leaf list.
2. Bind the root to a specific, ordered leaf set — not just a count or a
   summary.
3. Be cheap to compute off-chain and cheap to store on-chain (32 bytes).
4. Have no ambiguity in encoding so two implementations always agree.

Two different codebases implement the hash (the ASP and the reputation
publisher), and they must not silently diverge.

## Context

The on-chain root alone is not self-authenticating: a publisher could swap the
underlying leaf set while keeping the root unchanged (by crafting a different
tree with the same root — computationally infeasible against Poseidon, but the
dataset hash is the mechanism that makes this auditable to anyone without
requiring them to trust Poseidon collision-resistance alone). Any holder or
third-party verifier who receives the leaf list should be able to independently
reproduce the hash and confirm it matches what the contract stores.

## Decision

### ASP / pool-state root (`asp/src/publish.ts`)

```
dataset_hash = "0x" || hex(SHA256(BE32(leaf_count) || root_bytes || leaf_0 || … || leaf_N-1))
```

where `root_bytes` is the 32-byte ASP/state root and each decimal ASP label is
encoded as a 32-byte big-endian field element. State leaves are already 32-byte
hex values. This is the exact same byte layout used by the reputation publisher.

### Reputation publisher (`publisher/src/publish.ts`)

```
dataset_hash = "0x" || hex( SHA256( BE32(leaf_count) || root_bytes || leaf_0 || … || leaf_N-1 ) )
```

where:
- `BE32(leaf_count)` is the 4-byte big-endian encoding of the number of leaves.
- `root_bytes` is the 32-byte canonical encoding of the Poseidon root (as
  returned by `hex32ToBytes`).
- Each `leaf_i` is the 32-byte canonical encoding of the corresponding leaf
  commitment.

The root is included in the reputation hash so the binding is symmetric: the
hash attests to both the root and the leaf set, not just the leaf set alone.

### Shared conventions

- Both formats produce a 32-byte hex string prefixed with `0x`.
- Both use SHA256 (not Poseidon) — SHA256 is a standard preimage-resistant hash
  that any verifier can run without the circomlib dependency.
- Both operate over the same ordered list the publisher used to build the
  Merkle tree, so an independent recomputation is guaranteed to agree.

## Rationale

The two publishers serve different data models, but use one byte format:

- ASP labels are converted from decimal field elements to canonical 32-byte
  big-endian values. The root is computed first, then included in the hash.
- Reputation leaves are already canonical 32-byte values; the same root-binding
  format therefore works without a service-specific branch.

SHA256 was chosen over Poseidon for the dataset hash because: (a) it is
universally available in Node.js via `node:crypto` without extra dependencies,
(b) it is faster for bulk hashing of large leaf lists, and (c) its use here is
not in-circuit — there is no proof that depends on this hash's algebraic
properties.

## Alternatives considered

- **Poseidon over all leaves:** Consistent with the on-chain tree structure,
  but slow for large lists off-chain and requires the circomlib dependency in
  every verifier tool. Rejected.
- **Two service-specific formats:** Rejected because independent verification
  tooling repeatedly implemented incompatible encodings.
- **BLAKE3 or keccak256:** No strong reason to prefer either over SHA256 for
  this off-chain, non-circuit role. SHA256 chosen for ubiquity.

## Consequences

### Positive
- Any verifier with the leaf list can recompute and check the hash with standard
  tooling (`sha256sum`, Node.js `node:crypto`).
- The ASP and reputation publisher formats are independently documented and
  testable.

### Negative
- Two slightly different formats exist; tooling that handles both must branch on
  context (ASP vs. reputation).
- Adding a third publisher requires an explicit format decision rather than a
  default.

## Implementation notes

- ASP: `asp/src/publish.ts` → `computeDatasetHash(root, labels)`
- Reputation publisher: `publisher/src/publish.ts` → `computeDatasetHash(root, leaves)`
- The on-chain `RootEntry` struct (`contracts/privacy-pool/src/lib.rs`) stores
  `dataset_hash: BytesN<32>` alongside every root; the same pattern is used in
  the reputation verifier.

## Related decisions

- [ADR-0001](0001_off_chain_published_roots.md) — off-chain roots that the
  dataset hash authenticates.
- [ADR-0007](0007_reputation_publisher_trust_model.md) — the dataset hash is the
  primary accountability mechanism for the reputation publisher.

## References

- ASP publish implementation: `asp/src/publish.ts`
- Reputation publisher implementation: `publisher/src/publish.ts`
- On-chain root entry: `contracts/privacy-pool/src/lib.rs` (`RootEntry`)
