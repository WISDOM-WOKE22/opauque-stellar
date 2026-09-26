// @ts-nocheck
/**
 * Live testnet smoke for the Phase 6 relayer-market control plane.
 *
 * It registers the relayer when needed, creates an escrowed blind job, verifies the
 * relayer engine bids only after reading the on-chain job, accepts the job, then waits
 * for expiry and slashes it. The accepted-but-unsubmitted slash path proves the bond
 * and refund accounting without needing to generate a fresh pool proof.
 *
 * Run:
 *   DEPLOYER_SECRET="$(stellar keys show opaque-deployer)" npm run smoke:market
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { RelayerEngine } from "../src/engine.ts";
import { StellarRelayerChain } from "../src/chains/stellar.ts";
import { makeAdvert } from "../src/messages.ts";
import { generateX25519Keypair } from "../src/shared/box.ts";
import { bytesToHex } from "../src/shared/bytes.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const manifest = JSON.parse(readFileSync(join(ROOT, "deployments/v1/testnet.json"), "utf8"));
const RPC_URL = process.env.STELLAR_RPC_URL ?? manifest.rpcUrl;
const NETWORK_PASSPHRASE = manifest.networkPassphrase;
const registryId = process.env.RELAYER_REGISTRY_ID ?? manifest.contracts.relayerRegistry?.id;
const server = new rpc.Server(RPC_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!registryId) throw new Error("relayerRegistry is not deployed in deployments/v1/testnet.json");

function bytesScVal(bytes: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

async function invoke(kp: Keypair, contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const acct = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return r.returnValue ? scValToNative(r.returnValue) : null;
    if (r.status === "FAILED") throw new Error(`${method} failed: ${sent.hash}`);
  }
  throw new Error(`${method} not confirmed: ${sent.hash}`);
}

async function simulate(kp: Keypair, contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown | null> {
  const acct = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
  return scValToNative(sim.result.retval);
}

async function latestLedger(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}

async function main() {
  const secret = process.env.RELAYER_OPERATOR_SECRET ?? process.env.DEPLOYER_SECRET;
  if (!secret) throw new Error("set DEPLOYER_SECRET or RELAYER_OPERATOR_SECRET");
  const operator = Keypair.fromSecret(secret);
  const x25519Seed = createHash("sha256").update(secret).update("opaque-relayer-x25519-v1").digest();
  const x25519 = generateX25519Keypair(Uint8Array.from(x25519Seed));
  const endpoint = process.env.RELAYER_ENDPOINT ?? "http://127.0.0.1:8787";

  console.log(`Registry ${registryId}`);
  console.log(`Operator ${operator.publicKey()}`);
  console.log(`X25519 ${bytesToHex(x25519.publicKey)}`);

  const relayer = await simulate(operator, registryId, "get_relayer", [
    new Address(operator.publicKey()).toScVal(),
  ]);
  if (!relayer) {
    console.log("• Registering relayer…");
    await invoke(operator, registryId, "register", [
      new Address(operator.publicKey()).toScVal(),
      bytesScVal(x25519.publicKey),
      nativeToScVal(endpoint, { type: "string" }),
      nativeToScVal(1_000_000n, { type: "i128" }),
    ]);
  } else {
    console.log("• Relayer already registered");
  }

  const jobId = Uint8Array.from(createHash("sha256").update(`${Date.now()}`).digest());
  const payloadHash = Uint8Array.from(createHash("sha256").update(jobId).digest());
  const fee = 100_000n;
  const deadline = (await latestLedger()) + 20;

  console.log("• Creating blind job…");
  await invoke(operator, registryId, "create_job", [
    new Address(operator.publicKey()).toScVal(),
    bytesScVal(jobId),
    bytesScVal(payloadHash),
    nativeToScVal(deadline, { type: "u32" }),
    nativeToScVal(fee, { type: "i128" }),
  ]);

  const chain = new StellarRelayerChain({
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    registryId,
    operator,
  });
  const engine = new RelayerEngine({
    operator,
    x25519PublicKey: x25519.publicKey,
    x25519SecretKey: x25519.secretKey,
    endpoint,
    minFee: 1n,
    chain,
    // This script creates its job with `latestLedger() + 20` of runway, so it
    // opts into a margin that fits that deliberately short deadline instead of
    // the production default (#974).
    deadlineMarginLedgers: 5,
  });
  const advert = makeAdvert({ jobId, fee, deadline, payloadHash });
  console.log("• Asking engine to bid…");
  const bid = await engine.handleAdvert(advert);
  if (!bid) throw new Error("relayer engine did not bid on valid on-chain job");

  console.log("• Accepting job…");
  await chain.acceptJob(advert.jobId);

  console.log("• Waiting for deadline, then slashing accepted job…");
  while ((await latestLedger()) <= deadline) await sleep(3000);
  await invoke(operator, registryId, "slash_job", [
    new Address(operator.publicKey()).toScVal(),
    bytesScVal(jobId),
  ]);
  const job = await chain.getJob(advert.jobId);
  if (job?.status !== "slashed") throw new Error(`expected slashed job, got ${job?.status}`);
  console.log("\n✅ smoke:market passed — register → create → bid → accept → slash");
}

main().catch((err) => {
  console.error(`\n✗ ${err?.message ?? err}`);
  process.exit(1);
});
