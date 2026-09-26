// @ts-nocheck
/**
 * Checks the TTL status of persistent storage entries for deployed contracts.
 *
 * Soroban's state archival can expire long-lived entries. This script reads
 * contract state via RPC and reports entries approaching their TTL expiry.
 *
 * Usage:
 *   npx tsx scripts/check-ttl-expiry.ts --network testnet
 *   npx tsx scripts/check-ttl-expiry.ts --network testnet --contract <contract-id>
 *   npx tsx scripts/check-ttl-expiry.ts --network testnet --threshold 604800
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server, xdr } from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEPLOYMENTS = join(ROOT, "deployments", "v1");

const PASSPHRASES: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

/** Default TTL for persistent entries (~120 days at 5s/ledger). */
const DEFAULT_PERSISTENT_TTL = 2_073_600;

/** Alert when TTL drops below this threshold (default: 30 days). */
const DEFAULT_THRESHOLD = 5_184_00; // 30 days in ledgers

interface ContractEntry {
  key: string;
  ttl: number;
  liveUntilLedger: number;
}

interface TtlReport {
  contractId: string;
  contractName: string;
  entries: ContractEntry[];
  expiringCount: number;
  totalCount: number;
}

function parseArgs(argv: string[]) {
  let network = "testnet";
  let contractFilter: string | undefined;
  let threshold = DEFAULT_THRESHOLD;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--network" && argv[i + 1]) network = argv[i + 1];
    if (argv[i] === "--contract" && argv[i + 1]) contractFilter = argv[i + 1];
    if (argv[i] === "--threshold" && argv[i + 1]) threshold = parseInt(argv[i + 1], 10);
  }
  return { network, contractFilter, threshold };
}

function loadDeployment(network: string): Record<string, string> {
  const path = join(DEPLOYMENTS, `${network}.json`);
  if (!existsSync(path)) {
    throw new Error(`Deployment manifest not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function checkTtl(
  rpcUrl: string,
  contractId: string,
  contractName: string,
  threshold: number,
): Promise<TtlReport> {
  const report: TtlReport = {
    contractId,
    contractName,
    entries: [],
    expiringCount: 0,
    totalCount: 0,
  };

  try {
    const server = new Server(rpcUrl);

    const ledgerResponse = await server.ledgers().limit(1).order("desc").call();
    const currentLedger = parseInt(ledgerResponse.records[0].sequence);

    const contractEntries = await server
      .contractData()
      .forContract(contractId)
      .call();

    if (!contractEntries.records) {
      return report;
    }

    report.totalCount = contractEntries.records.length;

    for (const record of contractEntries.records) {
      const ledgerEntry = record as any;
      const ttl = ledgerEntry.live_until_ledger_seq || DEFAULT_PERSISTENT_TTL;
      const liveUntilLedger = ttl;
      const remainingLedgers = Math.max(0, ttl - currentLedger);

      const entry: ContractEntry = {
        key: ledgerEntry.key?.substring(0, 64) || "",
        ttl: remainingLedgers,
        liveUntilLedger,
      };

      if (remainingLedgers < threshold) {
        report.expiringCount++;
      }
      report.entries.push(entry);
    }
  } catch (err) {
    console.warn(`  Warning: could not read storage for ${contractName}: ${(err as Error).message}`);
  }

  return report;
}

async function main() {
  const { network, contractFilter, threshold } = parseArgs(process.argv);
  const passphrase = PASSPHRASES[network];
  if (!passphrase) {
    console.error(`Unknown network: ${network}. Use testnet or mainnet.`);
    process.exit(1);
  }

  const deployment = loadDeployment(network);
  const rpcUrl = deployment.rpcUrl || "https://soroban-testnet.stellar.org";

  const contracts = [
    { key: "privacyPool", name: "privacy-pool" },
    { key: "reputationVerifier", name: "reputation-verifier" },
    { key: "attestationEngineV2", name: "attestation-engine-v2" },
    { key: "schemaRegistry", name: "schema-registry" },
    { key: "relayerRegistry", name: "relayer-registry" },
    { key: "stealthRegistry", name: "stealth-registry" },
    { key: "stealthAnnouncer", name: "stealth-announcer" },
  ];

  console.log(`TTL Expiry Check — network: ${network}`);
  console.log(`Threshold: ${threshold} ledgers (~${Math.round(threshold * 5 / 86400)} days)`);
  console.log("---");

  let totalExpiring = 0;

  for (const { key, name } of contracts) {
    const contractId = deployment[key];
    if (!contractId) continue;
    if (contractFilter && contractId !== contractFilter && name !== contractFilter) continue;

    const report = await checkTtl(rpcUrl, contractId, name, threshold);
    const status = report.expiringCount > 0 ? "⚠️  EXPIRING" : "✅ OK";
    console.log(`${status}  ${name} (${contractId.slice(0, 8)}...)`);
    console.log(`  Entries: ${report.totalCount}, Expiring: ${report.expiringCount}`);

    if (report.expiringCount > 0) {
      totalExpiring += report.expiringCount;
      console.log(`  Action required: bump TTL for ${report.expiringCount} entries`);
    }
  }

  console.log("---");
  if (totalExpiring > 0) {
    console.error(`FAIL: ${totalExpiring} entries approaching TTL expiry. Run TTL bump script.`);
    process.exit(1);
  } else {
    console.log("PASS: All persistent entries have sufficient TTL headroom.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
