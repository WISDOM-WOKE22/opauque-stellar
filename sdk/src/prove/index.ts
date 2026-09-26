/**
 * Proving layer: build witnesses and generate Groth16 proofs for reputation
 * (and, as it lands, the privacy pool). Proof generation pulls circuit artifacts
 * through an {@link ArtifactResolver} and uses `snarkjs` (an optional peer dep,
 * imported lazily).
 */
export * from "./serialize";
export * from "./reputation";
export * from "./pool";
export * from "./pool-size";
export * from "./worker-pool";
export * from "./asp-client";
