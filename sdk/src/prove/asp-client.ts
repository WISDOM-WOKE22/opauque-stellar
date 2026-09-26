/**
 * ASP client for withdrawal proving (issue #972).
 *
 * A withdrawer has to prove their label is in the association set for one
 * specific root — the `aspRoot` the pool contract currently holds. The ASP
 * publishes that root's manifest and, via `GET /inclusion/:root/:label`, the
 * inclusion path for a single label, so the client no longer has to fetch every
 * approved deposit index and rebuild the whole depth-20 tree itself.
 *
 * The proof stays self-authenticating: {@link assertAspInclusionMatchesRoot}
 * replays the returned path through the same Poseidon tree the circuit uses and
 * refuses anything that does not reproduce the root, so a compromised or buggy
 * ASP still cannot forge an inclusion.
 */
import { GatewayError } from "../errors/index";
import { getPoseidon, hashFields } from "../crypto/notes";

/** One label's inclusion path, as served by the ASP. */
export interface AspInclusionProof {
  /** Root the proof was computed against, 0x-prefixed 32-byte hex. */
  root: string;
  /** The proven label, decimal field element. */
  label: string;
  /** Tree-leaf position within the set. */
  index: number;
  /** Deposit index the label was approved for, when the manifest records it. */
  depositIndex?: number | null;
  levels: number;
  /** Bottom-up sibling path — the circuit's `aspSiblings`. */
  pathElements: string[];
  /** Direction bits — the circuit's `aspIndex`. */
  pathIndices: number[];
}

/** A set manifest as published by the ASP. */
export interface AspSetManifest {
  poolId: string;
  root: string;
  version: number;
  levels: number;
  algo: string;
  labels: string[];
  indices: number[];
  generatedAt: string;
}

/** Default per-request timeout for ASP HTTP calls. */
export const DEFAULT_ASP_TIMEOUT_MS = 10_000;

const ROOT_RE = /^0x[0-9a-fA-F]{64}$/;
const LABEL_RE = /^\d{1,78}$/;

export interface FetchAspInclusionOptions {
  /** Base URL of the ASP, e.g. `https://asp.example.com`. */
  baseUrl: string;
  poolId: string;
  /** Root to fetch the proof for, 0x-prefixed 32-byte hex. */
  root: string;
  /** The caller's label, decimal field element. */
  label: string;
  /** Per-request timeout in ms (default {@link DEFAULT_ASP_TIMEOUT_MS}). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchAspManifestOptions {
  baseUrl: string;
  poolId: string;
  root: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function url(path: string, base: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function getJson<T>(
  target: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(target, {
    headers: { accept: "application/json" },
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    throw new GatewayError(`ASP returned ${res.status} for ${target}`, {
      httpStatus: res.status,
      aspUrl: target,
    });
  }
  return (await res.json()) as T;
}

/**
 * Recompute the root implied by an inclusion proof and check it equals the root
 * the proof claims. Mirrors the circuit's inclusion check: start at the leaf and
 * fold in each sibling in `pathIndices` order.
 */
export async function assertAspInclusionMatchesRoot(proof: AspInclusionProof): Promise<void> {
  if (proof.pathElements.length !== proof.pathIndices.length) {
    throw new Error(
      `ASP inclusion proof is malformed: ${proof.pathElements.length} path elements vs ${proof.pathIndices.length} indices`,
    );
  }
  if (proof.pathElements.length !== proof.levels) {
    throw new Error(
      `ASP inclusion proof covers ${proof.pathElements.length} levels, expected ${proof.levels}`,
    );
  }

  const poseidon = await getPoseidon();
  let computed = BigInt(proof.label);
  for (let level = 0; level < proof.pathElements.length; level += 1) {
    const sibling = BigInt(proof.pathElements[level]!);
    computed =
      proof.pathIndices[level] === 1
        ? hashFields(poseidon, [sibling, computed])
        : hashFields(poseidon, [computed, sibling]);
  }

  if (computed !== BigInt(proof.root)) {
    throw new Error(
      `ASP inclusion proof does not reproduce its root: computed 0x${computed.toString(16)}, proof claims ${proof.root}`,
    );
  }
}

/**
 * Fetch the inclusion path for `label` at `root` from the ASP's
 * `GET /inclusion/:root/:label` endpoint (#972).
 *
 * The path is verified against `root` before it is returned, so a proof served
 * for the wrong root is rejected here instead of becoming a witness that fails
 * to verify for an opaque reason.
 */
export async function fetchAspInclusion(
  opts: FetchAspInclusionOptions,
): Promise<AspInclusionProof> {
  if (!ROOT_RE.test(opts.root)) {
    throw new Error(`asp root must be a 0x-prefixed 32-byte hex string, got "${opts.root}"`);
  }
  if (!LABEL_RE.test(opts.label)) {
    throw new Error(`asp label must be a decimal field element, got "${opts.label}"`);
  }

  const proof = await getJson<AspInclusionProof>(
    url(
      `inclusion/${encodeURIComponent(opts.root)}/${encodeURIComponent(opts.label)}`,
      opts.baseUrl,
    ),
    opts.timeoutMs ?? DEFAULT_ASP_TIMEOUT_MS,
    opts.signal,
  );
  await assertAspInclusionMatchesRoot(proof);
  return proof;
}

/** Fetch a specific historical manifest by root (`GET /manifest/:root`). */
export async function fetchAspManifest(opts: FetchAspManifestOptions): Promise<AspSetManifest> {
  if (!ROOT_RE.test(opts.root)) {
    throw new Error(`asp root must be a 0x-prefixed 32-byte hex string, got "${opts.root}"`);
  }
  return getJson<AspSetManifest>(
    url(`manifest/${encodeURIComponent(opts.root)}`, opts.baseUrl),
    opts.timeoutMs ?? DEFAULT_ASP_TIMEOUT_MS,
    opts.signal,
  );
}
