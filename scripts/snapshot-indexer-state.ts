#!/usr/bin/env -S npx tsx
/**
 * Snapshot and restore ASP indexer state (#626)
 *
 * The ASP persists its reconcile cursor and approved-set membership decisions in
 * `<dataDir>/state/<poolId>.json` (see asp/src/store.ts `FileStore`). This tool
 * copies that file into a checksummed snapshot, and puts it back on restore, so a
 * lost disk does not force a full rescan from the deployment ledger.
 *
 * Usage: npx tsx scripts/snapshot-indexer-state.ts [create|restore|list] [options]
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SNAPSHOT_PATH = ".indexer-state/snapshot.json";
const SNAPSHOT_VERSION = 2;
const STALE_SNAPSHOT_DAYS = 7;

/** The persisted shape written by asp/src/store.ts `FileStore` (asp/src/types.ts `PoolState`). */
interface PoolState {
  poolId: string;
  scope: number;
  approvedIndices: number[];
  rejectedIndices?: number[];
  deferredIndices?: number[];
  lastIndex: number;
  lastLedger: number;
}

interface IndexerSnapshot {
  version: number;
  timestamp: string;
  network: string;
  poolId: string;
  dataDir: string;
  stateFile: string;
  /** Ledger cursor the indexer had processed at snapshot time. */
  lastProcessedLedger: number;
  /** Highest deposit index the indexer had seen. */
  lastIndex: number;
  /** Deposits covered by the cursor (deposit indices are sequential from 0). */
  depositsIndexed: number;
  approvedLeaves: number;
  rejectedLeaves: number;
  deferredLeaves: number;
  /** sha256 over the canonical serialization of `state`; verified on restore. */
  stateChecksum: string;
  state: PoolState;
}

interface Options {
  command: string;
  output?: string;
  input?: string;
  dataDir?: string;
  poolId?: string;
  network: string;
  force: boolean;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string>();
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const [name, inlineValue] = arg.slice(2).split(/=(.*)/s);
    if (name === undefined) continue;
    const value = inlineValue ?? argv[++i];
    if (value === undefined) fail(`Option --${name} needs a value`);
    flags.set(name, value);
  }

  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const opt = (name: string): string | undefined => flags.get(name);

  return {
    command: positional[0] ?? "create",
    output: opt("output"),
    input: opt("input"),
    dataDir: opt("data-dir"),
    poolId: opt("pool-id"),
    network: (opt("network") ?? process.env.OPAQUE_NETWORK ?? process.env.STELLAR_NETWORK ?? "testnet")
      .trim()
      .toLowerCase(),
    force,
  };
}

function getSnapshotPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  return join(process.cwd(), DEFAULT_SNAPSHOT_PATH);
}

/** Mirrors the data directory the indexer itself uses (asp/scripts/indexer.ts `loadConfig`). */
function getDataDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.ASP_DATA_DIR) return resolve(process.env.ASP_DATA_DIR);
  return join(ROOT, "asp", "data");
}

function statePathFor(dataDir: string, poolId: string): string {
  return join(dataDir, "state", `${poolId}.json`);
}

function manifestPoolId(network: string): string | undefined {
  const manifestPath = join(ROOT, "deployments", "v1", `${network}.json`);
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    contracts?: Record<string, { id?: string } | undefined>;
  };
  return manifest.contracts?.privacyPool?.id;
}

/**
 * Find the state file to operate on. Prefers an explicitly requested pool, then the
 * manifest's pool id, then — after a redeploy, where the manifest id no longer matches
 * the file the old pool wrote — the single state file present in the data directory.
 */
function locateState(opts: Options, dataDir: string): { poolId: string; stateFile: string } {
  const explicit = opts.poolId ?? process.env.PRIVACY_POOL_ID?.trim();
  if (explicit) {
    return { poolId: explicit, stateFile: statePathFor(dataDir, explicit) };
  }

  const manifestId = manifestPoolId(opts.network);
  if (manifestId && existsSync(statePathFor(dataDir, manifestId))) {
    return { poolId: manifestId, stateFile: statePathFor(dataDir, manifestId) };
  }

  const stateDir = join(dataDir, "state");
  const candidates = existsSync(stateDir)
    ? readdirSync(stateDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
    : [];
  if (candidates.length === 1) {
    const poolId = candidates[0] as string;
    if (manifestId && manifestId !== poolId) {
      console.warn(
        `⚠ No state for manifest pool ${manifestId}; using the only state file present (${poolId}).`,
      );
      console.warn(`  Set --pool-id to override. Network from manifest: ${opts.network}.`);
    }
    return { poolId, stateFile: statePathFor(dataDir, poolId) };
  }
  if (candidates.length > 1) {
    return fail(
      `Multiple pools have state in ${stateDir} (${candidates.join(", ")}); pass --pool-id to choose one.`,
    );
  }

  return fail(
    `No ASP indexer state found in ${stateDir}. Has the indexer run against this data directory?\n` +
      `  Set ASP_DATA_DIR/--data-dir to the indexer's data directory, or --pool-id to its pool.`,
  );
}

/** Deterministic serialization (recursively key-sorted) so the checksum is stable. */
function canonicalState(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalState).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalState(v)}`);
  return `{${entries.join(",")}}`;
}

function checksumOf(state: PoolState): string {
  return createHash("sha256").update(canonicalState(state)).digest("hex");
}

function readPoolState(stateFile: string): PoolState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (err) {
    return fail(`Unreadable ASP state file ${stateFile}: ${(err as Error).message}`);
  }
  const state = parsed as PoolState;
  if (typeof state.poolId !== "string" || typeof state.lastLedger !== "number") {
    return fail(`${stateFile} does not look like ASP indexer state (missing poolId/lastLedger).`);
  }
  if (!Array.isArray(state.approvedIndices) || typeof state.lastIndex !== "number") {
    return fail(`${stateFile} does not look like ASP indexer state (missing approvedIndices/lastIndex).`);
  }
  return state;
}

function describe(state: PoolState): string[] {
  return [
    `  Pool:                  ${state.poolId}`,
    `  Scope:                 ${state.scope}`,
    `  Last processed ledger: ${state.lastLedger}`,
    `  Last deposit index:    ${state.lastIndex}`,
    `  Deposits indexed:      ${state.lastIndex + 1}`,
    `  Approved leaves:       ${state.approvedIndices.length}`,
    `  Rejected leaves:       ${state.rejectedIndices?.length ?? 0}`,
    `  Deferred leaves:       ${state.deferredIndices?.length ?? 0}`,
  ];
}

function createSnapshot(opts: Options): void {
  const dataDir = getDataDir(opts.dataDir);
  const { poolId, stateFile } = locateState(opts, dataDir);
  if (!existsSync(stateFile)) {
    fail(`No ASP indexer state at ${stateFile}. Has the indexer run against ${dataDir}?`);
  }
  const state = readPoolState(stateFile);

  const snapshot: IndexerSnapshot = {
    version: SNAPSHOT_VERSION,
    timestamp: new Date().toISOString(),
    network: opts.network,
    poolId,
    dataDir,
    stateFile,
    lastProcessedLedger: state.lastLedger,
    lastIndex: state.lastIndex,
    depositsIndexed: state.lastIndex + 1,
    approvedLeaves: state.approvedIndices.length,
    rejectedLeaves: state.rejectedIndices?.length ?? 0,
    deferredLeaves: state.deferredIndices?.length ?? 0,
    stateChecksum: checksumOf(state),
    state,
  };

  const snapshotPath = getSnapshotPath(opts.output);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  console.log(`✓ Snapshot created: ${snapshotPath}`);
  console.log(`  Source state file:  ${stateFile}`);
  console.log(`  Created:            ${snapshot.timestamp}`);
  console.log(`  Checksum:           sha256:${snapshot.stateChecksum}`);
  for (const line of describe(state)) console.log(line);
}

function restoreSnapshot(opts: Options): void {
  const snapshotPath = getSnapshotPath(opts.input);
  if (!existsSync(snapshotPath)) fail(`Snapshot not found: ${snapshotPath}`);

  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as IndexerSnapshot;
  if (snapshot.version !== SNAPSHOT_VERSION) {
    if (snapshot.version === 1) {
      fail(
        `${snapshotPath} is a version 1 snapshot (ledger ${snapshot.lastProcessedLedger}).\n` +
          "  Version 1 recorded only a ledger number and no indexer state, so there is nothing to restore.\n" +
          "  Take a version 2 snapshot from a running indexer instead.",
      );
    }
    return fail(`Unsupported snapshot version: ${snapshot.version} (expected ${SNAPSHOT_VERSION})`);
  }

  const state = snapshot.state;
  if (checksumOf(state) !== snapshot.stateChecksum) {
    fail(
      `Snapshot checksum mismatch in ${snapshotPath} — the file is corrupt or was edited.\n` +
        `  expected sha256:${snapshot.stateChecksum}\n  computed sha256:${checksumOf(state)}`,
    );
  }

  const dataDir = getDataDir(opts.dataDir);
  if (opts.poolId && opts.poolId !== snapshot.poolId) {
    fail(`Snapshot is for pool ${snapshot.poolId}, not ${opts.poolId}.`);
  }

  const target = statePathFor(dataDir, snapshot.poolId);
  if (existsSync(target) && !opts.force) {
    fail(
      `Live ASP state already exists at ${target}.\n` +
        "  Stop the indexer first, then re-run with --force to overwrite it.",
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);

  const ageDays = (Date.now() - Date.parse(snapshot.timestamp)) / 86_400_000;
  console.log(`✓ Restored ASP indexer state: ${target}`);
  console.log(`  From snapshot:         ${snapshotPath}`);
  console.log(`  Snapshot taken:         ${snapshot.timestamp} (${ageDays.toFixed(1)} days ago)`);
  console.log(`  Checksum verified:      sha256:${snapshot.stateChecksum}`);
  for (const line of describe(state)) console.log(line);
  console.log("");
  console.log("  Restart the indexer to resume from this cursor:");
  console.log(`    ASP_DATA_DIR=${dataDir} cd asp && npm run indexer`);

  if (ageDays > STALE_SNAPSHOT_DAYS) {
    console.warn("");
    console.warn(`⚠ Snapshot is ${ageDays.toFixed(1)} days old.`);
    console.warn("  Consider re-indexing recent ledgers to ensure consistency.");
  }
}

function listSnapshots(opts: Options): void {
  const snapshotDir = dirname(getSnapshotPath(opts.output));
  if (!existsSync(snapshotDir)) {
    console.log("No snapshots found.");
    return;
  }

  const files = readdirSync(snapshotDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No snapshots found.");
    return;
  }

  console.log(`Available snapshots in ${snapshotDir}:`);
  for (const file of files) {
    const filePath = join(snapshotDir, file);
    const stat = statSync(filePath);
    console.log(`  ${file} (${stat.size} bytes, ${stat.mtime.toISOString()})`);
  }
}

const opts = parseArgs(process.argv.slice(2));

switch (opts.command) {
  case "create":
    createSnapshot(opts);
    break;
  case "restore":
    restoreSnapshot(opts);
    break;
  case "list":
    listSnapshots(opts);
    break;
  default:
    console.log(`
Usage: npx tsx scripts/snapshot-indexer-state.ts [command] [options]

Commands:
  create    Snapshot the ASP indexer state (default)
  restore   Restore ASP indexer state from a snapshot
  list      List available snapshots

Options:
  --data-dir DIR    ASP data directory (default: $ASP_DATA_DIR or asp/data)
  --pool-id ID      Pool contract id (default: $PRIVACY_POOL_ID or the manifest's privacyPool)
  --network NAME    Manifest network used to resolve the pool id (default: testnet)
  --output FILE     Snapshot path for create/list (default: ${DEFAULT_SNAPSHOT_PATH})
  --input FILE      Snapshot path for restore (default: ${DEFAULT_SNAPSHOT_PATH})
  --force           Overwrite existing live state on restore

Examples:
  npx tsx scripts/snapshot-indexer-state.ts create
  npx tsx scripts/snapshot-indexer-state.ts restore --force
  npx tsx scripts/snapshot-indexer-state.ts list
`);
}
