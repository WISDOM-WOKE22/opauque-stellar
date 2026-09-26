import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPoseidon, hashFields, buildRoot, TREE_DEPTH } from "./merkle.ts";
import { bigintToHex32, hex32ToBytes } from "./bytes.ts";

export interface SnapshotExport {
  version: 1;
  verifierId: string;
  root: string;
  leafCount: number;
  leaves: string[];
  intermediateHashes: Record<string, string>;
  generatedAt: string;
}

export async function buildSnapshotLeaves(leaves: string[]): Promise<string[]> {
  return leaves.map((l) => l.toLowerCase());
}

export async function buildIntermediateHashes(leaves: string[]): Promise<Record<string, string>> {
  const poseidon = await getPoseidon();
  const zero: bigint[] = [0n];
  for (let i = 0; i < TREE_DEPTH; i += 1) {
    zero.push(hashFields(poseidon, [zero[i], zero[i]]));
  }

  const hashes: Record<string, string> = {};

  function nodeHash(start: number, level: number): bigint {
    const key = `${level}:${start}`;
    if (start >= leaves.length) {
      hashes[key] = bigintToHex32(zero[level]);
      return zero[level];
    }
    if (level === 0) {
      const val = BigInt(leaves[start]);
      hashes[key] = bigintToHex32(val);
      return val;
    }
    const half = 1 << (level - 1);
    const left = nodeHash(start, level - 1);
    const right = nodeHash(start + half, level - 1);
    const h = hashFields(poseidon, [left, right]);
    hashes[key] = bigintToHex32(h);
    return h;
  }

  nodeHash(0, TREE_DEPTH);
  return hashes;
}

export async function buildTreeSnapshot(
  verifierId: string,
  leaves: string[],
): Promise<SnapshotExport> {
  const leafValues = await buildSnapshotLeaves(leaves);
  const root = await buildRoot(leafValues);
  const intermediateHashes = await buildIntermediateHashes(leafValues);

  return {
    version: 1,
    verifierId,
    root,
    leafCount: leafValues.length,
    leaves: leafValues,
    intermediateHashes,
    generatedAt: new Date().toISOString(),
  };
}

export function computeSnapshotHash(snapshot: SnapshotExport): string {
  const h = createHash("sha256");
  const count = Buffer.alloc(4);
  count.writeUInt32BE(snapshot.leafCount >>> 0, 0);
  h.update(count);
  h.update(hex32ToBytes(snapshot.root));
  for (const leaf of snapshot.leaves) h.update(hex32ToBytes(leaf));
  return `0x${h.digest("hex")}`;
}

export function writeSnapshot(dataDir: string, snapshot: SnapshotExport): string {
  const p = join(dataDir, "snapshots", snapshot.verifierId, `${snapshot.root}.json`);
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(snapshot, null, 2)}\n`);
  return p;
}

export function verifySnapshot(snapshot: SnapshotExport): boolean {
  if (snapshot.version !== 1) return false;
  if (!snapshot.root || !snapshot.verifierId) return false;
  if (!Array.isArray(snapshot.leaves)) return false;
  if (typeof snapshot.intermediateHashes !== "object") return false;
  return true;
}
