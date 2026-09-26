/**
 * #973 — production relayer wiring.
 *
 * `JobLedger`, `PayoutReconciler`, and the hub's heartbeat/outcome handling were
 * all implemented and unit-tested, but `scripts/relayer.ts` never constructed
 * any of them, so a real relayer fed the hub no liveness signal and no outcomes
 * and `/v1/reconcile` always answered "reconciler not configured".
 *
 * These tests drive `startRelayerNode()` — the same function the entrypoint
 * calls — so they exercise the real wiring rather than a stand-in: a settled
 * payload has to reach the persisted ledger, produce a reconciliation report,
 * and gossip a heartbeat and an outcome the hub actually scores.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { MemoryGossipTransport } from "../src/gossip.ts";
import { RelayerHub, type RelayerMessage } from "../src/hub.ts";
import { startRelayerNode, type RelayerNode } from "../src/runtime.ts";
import { MemoryLedgerStore } from "../src/store.ts";
import { generateX25519Keypair, sealBox } from "../src/shared/box.ts";
import { bytesToHex } from "../src/shared/bytes.ts";
import {
  encodePoolWithdrawPayload,
  hashPoolWithdrawPayloadHex,
  type PoolWithdrawPayload,
} from "../src/shared/payload.ts";
import type { OnChainJob, OnChainRelayer, RelayerChainAdapter } from "../src/engine.ts";
import { createLogger, type Logger } from "../src/logger.ts";

const ACCOUNT_A = "GABTYFQAXDR724JAJSNZVUH56T62JJ7CLWT6YL56ME7OPA4DIIMAMOI6";
const CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

/** Keeps the reconciler's per-run logging out of the test output. */
const silentLog: Logger = {
  ...createLogger("relayer-test"),
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

function bytes(len: number, tag: number): Uint8Array {
  return new Uint8Array(len).fill(tag);
}

function payload(poolRelayer: string): PoolWithdrawPayload {
  return {
    poolId: CONTRACT,
    proofA: bytes(64, 0xa1),
    proofB: bytes(128, 0xb2),
    proofC: bytes(64, 0xc3),
    withdrawnValue: 500n,
    stateRoot: bytes(32, 0x51),
    aspRoot: bytes(32, 0xa5),
    nullifierHash: bytes(32, 0x9a),
    newCommitment: bytes(32, 0xce),
    recipient: ACCOUNT_A,
    poolFee: 0n,
    poolRelayer,
  };
}

class WiringChain implements RelayerChainAdapter {
  job: OnChainJob;
  accepted = 0;
  submitted = 0;
  failSubmit = false;
  x25519Pk = "";

  constructor(payloadHash: string) {
    this.job = {
      exists: true,
      status: "open",
      fee: 100n,
      deadline: 5_000,
      payloadHash,
    };
  }

  async getJob(): Promise<OnChainJob> {
    return this.job;
  }

  async getRelayer(): Promise<OnChainRelayer> {
    return {
      registered: true,
      x25519Pk: this.x25519Pk,
      endpoint: "http://127.0.0.1:8787",
      freeStake: 1_000n,
    };
  }

  async latestLedger(): Promise<number> {
    return 100;
  }

  async simulatePoolWithdraw(): Promise<void> {}

  async acceptJob(): Promise<string> {
    this.accepted += 1;
    this.job.status = "accepted";
    return "accept-tx";
  }

  async submitPoolWithdraw(): Promise<string> {
    this.submitted += 1;
    if (this.failSubmit) throw new Error("submit rejected");
    this.job.status = "submitted";
    return "submit-tx";
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/**
 * Start a node through the production wiring, recording every message it
 * publishes so the test can assert on the gossip side as well.
 */
async function startWiredNode(opts: {
  chain: WiringChain;
  store: MemoryLedgerStore;
  transport: MemoryGossipTransport;
  operator: Keypair;
  x25519PublicKey: Uint8Array;
  x25519SecretKey: Uint8Array;
}): Promise<{ node: RelayerNode; published: RelayerMessage[] }> {
  const published: RelayerMessage[] = [];
  const original = opts.transport.publish.bind(opts.transport);
  opts.transport.publish = async (message: RelayerMessage) => {
    published.push(message);
    await original(message);
  };

  const node = await startRelayerNode({
    operator: opts.operator,
    x25519PublicKey: opts.x25519PublicKey,
    x25519SecretKey: opts.x25519SecretKey,
    endpoint: "http://127.0.0.1:8787",
    minFee: 1n,
    chain: opts.chain,
    transport: opts.transport,
    ledgerStore: opts.store,
    reconcileIntervalMs: 0,
    heartbeatIntervalMs: 0,
    deadlineMarginLedgers: 30,
    log: silentLog,
  });
  cleanups.push(() => node.stop());
  return { node, published };
}

/** Deliver a payload the chain will accept. `p` must be the hash-matched payload. */
async function deliver(
  node: RelayerNode,
  p: PoolWithdrawPayload,
  x25519PublicKey: Uint8Array,
  tag: number,
): Promise<string> {
  const jobId = bytesToHex(bytes(32, tag));
  const box = sealBox(encodePoolWithdrawPayload(p), x25519PublicKey);
  await node.engine.handlePayload({
    t: "payload",
    v: 1,
    jobId,
    to: bytesToHex(x25519PublicKey),
    box,
  });
  return jobId;
}

describe("relayer entrypoint wiring (#973)", () => {
  it("records every settled job to the persisted ledger", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new WiringChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    const store = new MemoryLedgerStore();
    const { node } = await startWiredNode({
      chain,
      store,
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    const jobId = await deliver(node, p, x25519.publicKey, 0x31);

    expect(chain.accepted).toBe(1);
    expect(chain.submitted).toBe(1);
    expect(node.ledger.size()).toBe(1);
    const entry = node.ledger.get(jobId);
    expect(entry?.acceptedTx).toBe("accept-tx");
    expect(entry?.submittedTx).toBe("submit-tx");
    expect(entry?.expectedFee).toBe(100n);
    // …and it reached the store, so a restart has something to reconcile.
    const persisted = await store.load();
    expect(persisted?.map((e) => e.jobId)).toContain(jobId);
  });

  it("reconciles the recorded ledger against the chain", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new WiringChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    const { node } = await startWiredNode({
      chain,
      store: new MemoryLedgerStore(),
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    await deliver(node, p, x25519.publicKey, 0x32);
    const report = await node.reconciler.reconcile();

    expect(report.totalChecked).toBe(1);
    expect(report.cleanCount).toBe(1);
    expect(report.summary).toBe("clean");
  });

  it("surfaces a fee mismatch as a reconciliation discrepancy", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new WiringChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    const { node } = await startWiredNode({
      chain,
      store: new MemoryLedgerStore(),
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    await deliver(node, p, x25519.publicKey, 0x36);
    // The chain reports a different fee than the ledger recorded.
    chain.job.fee = 250n;
    const report = await node.reconciler.reconcile();

    expect(report.discrepancyCount).toBe(1);
    expect(report.summary).toBe("discrepancies_found");
    expect(report.discrepancies[0]?.detail).toMatch(/fee mismatch/i);
  });

  it("publishes a heartbeat on startup so the hub sees the node as alive", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new WiringChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    const transport = new MemoryGossipTransport();
    const hub = new RelayerHub(transport);
    await hub.start();
    cleanups.push(() => transport.close());

    const { published } = await startWiredNode({
      chain,
      store: new MemoryLedgerStore(),
      transport,
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    expect(published.some((m) => m.t === "heartbeat")).toBe(true);
    expect(hub.stats.heartbeatsSeen).toBeGreaterThanOrEqual(1);
    expect(hub.isNodeAlive(operator.publicKey())).toBe(true);
  });

  it("gossips an outcome the hub scores", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new WiringChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    const transport = new MemoryGossipTransport();
    const hub = new RelayerHub(transport);
    await hub.start();
    cleanups.push(() => transport.close());

    const { node, published } = await startWiredNode({
      chain,
      store: new MemoryLedgerStore(),
      transport,
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });
    await deliver(node, p, x25519.publicKey, 0x33);

    const outcomes = published.filter((m) => m.t === "outcome");
    expect(outcomes).toHaveLength(1);
    expect(hub.stats.outcomesSeen).toBe(1);
    expect(hub.scoreFor(operator.publicKey()).completed).toBe(1);
    expect(hub.scoreFor(operator.publicKey()).score).toBe(1);
  });

  it("reports a failed outcome only for a job it had already accepted", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new WiringChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    chain.failSubmit = true;
    const transport = new MemoryGossipTransport();
    const hub = new RelayerHub(transport);
    await hub.start();
    cleanups.push(() => transport.close());

    const { node } = await startWiredNode({
      chain,
      store: new MemoryLedgerStore(),
      transport,
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    // Accepted, then the submit failed: the operator owes an honest "failed".
    await expect(deliver(node, p, x25519.publicKey, 0x34)).rejects.toThrow(/submit rejected/);
    expect(hub.scoreFor(operator.publicKey()).failed).toBe(1);
    // Never submitted, so nothing is owed to the reconciliation ledger.
    expect(node.ledger.size()).toBe(0);

    // A payload rejected before accept_job is not this operator's job at all —
    // reporting it would let anyone else drag the score down.
    chain.job.status = "open";
    const other = payload(ACCOUNT_A);
    await expect(deliver(node, other, x25519.publicKey, 0x37)).rejects.toThrow(/hash mismatch/i);
    expect(hub.scoreFor(operator.publicKey()).failed).toBe(1);
  });

  it("rehydrates a persisted ledger on boot and verifies it against the chain", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new WiringChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    const store = new MemoryLedgerStore();

    const first = await startWiredNode({
      chain,
      store,
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });
    const jobId = await deliver(first.node, p, x25519.publicKey, 0x35);
    await first.node.stop();
    cleanups.pop();

    // A fresh node over the same store sees the job recorded by the previous run.
    const { node: restarted } = await startWiredNode({
      chain,
      store,
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    expect(restarted.ledger.size()).toBe(1);
    expect(restarted.ledger.get(jobId)?.submittedTx).toBe("submit-tx");
    // verifyOnBoot() ran during startup.
    expect(restarted.reconciler.getLastReport()?.totalChecked).toBe(1);
  });
});
