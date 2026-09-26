/**
 * #975 — accepted jobs survive a restart.
 *
 * `acceptJob` was followed immediately by `submitPoolWithdraw` with nothing in
 * between, so a process that died after accepting left a bonded job that nobody
 * would ever submit: it missed its deadline and the stake was slashed for a
 * crash rather than a failure to deliver.
 *
 * These tests cover both halves of the fix — the acceptance is persisted *before*
 * the submit is attempted, and a restarted node finishes what it finds — driving
 * the real engine and queue rather than a stand-in.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { MemoryGossipTransport } from "../src/gossip.ts";
import { RelayerHub } from "../src/hub.ts";
import { AcceptedJobQueue } from "../src/job-queue.ts";
import { startRelayerNode, type RelayerNode } from "../src/runtime.ts";
import { MemoryAcceptedJobStore, MemoryLedgerStore } from "../src/store.ts";
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

/** A chain whose submit can be made to fail on demand, to simulate a crash window. */
class FlakyChain implements RelayerChainAdapter {
  job: OnChainJob;
  accepted = 0;
  submitAttempts = 0;
  /** While true, every submit throws — the "process died before submitting" case. */
  submitBroken = false;
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
    this.submitAttempts += 1;
    if (this.submitBroken) throw new Error("submit unavailable");
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

async function startNode(opts: {
  chain: FlakyChain;
  acceptedJobStore: MemoryAcceptedJobStore;
  ledgerStore: MemoryLedgerStore;
  transport: MemoryGossipTransport;
  operator: Keypair;
  x25519PublicKey: Uint8Array;
  x25519SecretKey: Uint8Array;
}): Promise<RelayerNode> {
  const node = await startRelayerNode({
    operator: opts.operator,
    x25519PublicKey: opts.x25519PublicKey,
    x25519SecretKey: opts.x25519SecretKey,
    endpoint: "http://127.0.0.1:8787",
    minFee: 1n,
    chain: opts.chain,
    transport: opts.transport,
    ledgerStore: opts.ledgerStore,
    acceptedJobStore: opts.acceptedJobStore,
    reconcileIntervalMs: 0,
    heartbeatIntervalMs: 0,
    deadlineMarginLedgers: 30,
    // Keep the retry loop instant so the test doesn't wait out real backoff.
    submitRetry: { maxAttempts: 2, baseDelayMs: 0 },
    log: silentLog,
  });
  cleanups.push(() => node.stop());
  return node;
}

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

describe("durable accept-submit (#975)", () => {
  it("persists the accepted job before attempting the submit", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new FlakyChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    const acceptedJobStore = new MemoryAcceptedJobStore();

    // Watch the store at the exact moment the submit runs: by then the entry
    // must already be durable, or a crash here loses the bond.
    const persistedAtSubmitTime: number[] = [];
    const originalSubmit = chain.submitPoolWithdraw.bind(chain);
    chain.submitPoolWithdraw = async () => {
      persistedAtSubmitTime.push((await acceptedJobStore.load())?.length ?? 0);
      return originalSubmit();
    };

    const node = await startNode({
      chain,
      acceptedJobStore,
      ledgerStore: new MemoryLedgerStore(),
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    const jobId = await deliver(node, p, x25519.publicKey, 0x41);

    expect(persistedAtSubmitTime).toEqual([1]);
    // Submitted, so it is no longer outstanding.
    expect(node.acceptedJobs.size()).toBe(0);
    expect(node.ledger.get(jobId)?.submittedTx).toBe("submit-tx");
  });

  it("retries a failed submit and recovers the job on restart", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new FlakyChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    chain.submitBroken = true;

    const acceptedJobStore = new MemoryAcceptedJobStore();
    const ledgerStore = new MemoryLedgerStore();

    // ── Run 1: the job is accepted, then the submit never succeeds ──────────
    const first = await startNode({
      chain,
      acceptedJobStore,
      ledgerStore,
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    const jobId = bytesToHex(bytes(32, 0x42));
    const box = sealBox(encodePoolWithdrawPayload(p), x25519.publicKey);
    await expect(
      first.engine.handlePayload({ t: "payload", v: 1, jobId, to: bytesToHex(x25519.publicKey), box }),
    ).rejects.toThrow(/submit unavailable/);

    // Accepted on-chain, retried twice, and still queued for the next boot.
    expect(chain.accepted).toBe(1);
    expect(chain.submitAttempts).toBe(2);
    expect(first.acceptedJobs.size()).toBe(1);
    expect(first.acceptedJobs.get(jobId)?.attempts).toBe(2);
    expect(first.acceptedJobs.get(jobId)?.lastError).toMatch(/submit unavailable/);
    // Never submitted, so it is not in the reconciliation ledger yet.
    expect(first.ledger.size()).toBe(0);

    // ── Restart: a brand-new process over the same on-disk state ────────────
    await first.stop();
    cleanups.pop();
    chain.submitBroken = false;

    const restarted = await startNode({
      chain,
      acceptedJobStore,
      ledgerStore,
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    // The queued job was picked up and submitted during boot.
    expect(chain.submitAttempts).toBe(3);
    expect(restarted.acceptedJobs.size()).toBe(0);
    // …and it is now a normal reconciled entry.
    expect(restarted.ledger.get(jobId)?.submittedTx).toBe("submit-tx");
    expect(restarted.ledger.get(jobId)?.acceptedTx).toBe("accept-tx");
    expect(restarted.ledger.get(jobId)?.expectedFee).toBe(100n);
  });

  it("reports the recovered job's outcome so the hub can score it", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new FlakyChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    chain.submitBroken = true;
    const acceptedJobStore = new MemoryAcceptedJobStore();

    const first = await startNode({
      chain,
      acceptedJobStore,
      ledgerStore: new MemoryLedgerStore(),
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });
    const jobId = bytesToHex(bytes(32, 0x43));
    const box = sealBox(encodePoolWithdrawPayload(p), x25519.publicKey);
    await expect(
      first.engine.handlePayload({ t: "payload", v: 1, jobId, to: bytesToHex(x25519.publicKey), box }),
    ).rejects.toThrow();
    await first.stop();
    cleanups.pop();

    chain.submitBroken = false;
    const transport = new MemoryGossipTransport();
    const hub = new RelayerHub(transport);
    await hub.start();
    cleanups.push(() => transport.close());

    await startNode({
      chain,
      acceptedJobStore,
      ledgerStore: new MemoryLedgerStore(),
      transport,
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    // The job it missed earlier was counted failed; the recovery completes it.
    expect(hub.scoreFor(operator.publicKey()).completed).toBe(1);
  });

  it("abandons a queued job whose deadline is already inside the margin", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new FlakyChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    const acceptedJobStore = new MemoryAcceptedJobStore();

    // A job accepted long ago whose window has since closed.
    await acceptedJobStore.save([
      {
        jobId: bytesToHex(bytes(32, 0x44)),
        acceptedTx: "accept-tx-old",
        payload: {
          poolId: p.poolId,
          proofA: bytesToHex(p.proofA),
          proofB: bytesToHex(p.proofB),
          proofC: bytesToHex(p.proofC),
          withdrawnValue: p.withdrawnValue.toString(),
          stateRoot: bytesToHex(p.stateRoot),
          aspRoot: bytesToHex(p.aspRoot),
          nullifierHash: bytesToHex(p.nullifierHash),
          newCommitment: bytesToHex(p.newCommitment),
          recipient: p.recipient,
          poolFee: p.poolFee.toString(),
          poolRelayer: p.poolRelayer,
        },
        deadline: 110, // chain head is 100, margin is 30 — window already closed
        fee: "100",
        acceptedAt: Date.now() - 60_000,
        attempts: 1,
      },
    ]);

    const node = await startNode({
      chain,
      acceptedJobStore,
      ledgerStore: new MemoryLedgerStore(),
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    // Dropped rather than submitted: the attempt could only fail.
    expect(chain.submitAttempts).toBe(0);
    expect(node.acceptedJobs.size()).toBe(0);
  });

  it("keeps a job queued when the restart's submit also fails", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const chain = new FlakyChain(hashPoolWithdrawPayloadHex(p));
    chain.x25519Pk = bytesToHex(x25519.publicKey);
    chain.submitBroken = true;
    const acceptedJobStore = new MemoryAcceptedJobStore();

    const first = await startNode({
      chain,
      acceptedJobStore,
      ledgerStore: new MemoryLedgerStore(),
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });
    const jobId = bytesToHex(bytes(32, 0x45));
    const box = sealBox(encodePoolWithdrawPayload(p), x25519.publicKey);
    await expect(
      first.engine.handlePayload({ t: "payload", v: 1, jobId, to: bytesToHex(x25519.publicKey), box }),
    ).rejects.toThrow();
    await first.stop();
    cleanups.pop();

    // Restart with submit still broken: the bond must not be silently dropped.
    const restarted = await startNode({
      chain,
      acceptedJobStore,
      ledgerStore: new MemoryLedgerStore(),
      transport: new MemoryGossipTransport(),
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
    });

    expect(restarted.acceptedJobs.size()).toBe(1);
    expect(restarted.acceptedJobs.get(jobId)?.attempts).toBe(4);
    expect(restarted.ledger.size()).toBe(0);
  });
});

describe("AcceptedJobQueue", () => {
  it("round-trips entries through a store", async () => {
    const store = new MemoryAcceptedJobStore();
    const queue = new AcceptedJobQueue(store);
    const jobId = bytesToHex(bytes(32, 0x46));

    await queue.enqueue({
      jobId,
      acceptedTx: "accept-tx",
      payload: {
        poolId: CONTRACT,
        proofA: "0x00",
        proofB: "0x00",
        proofC: "0x00",
        withdrawnValue: "500",
        stateRoot: "0x00",
        aspRoot: "0x00",
        nullifierHash: "0x00",
        newCommitment: "0x00",
        recipient: ACCOUNT_A,
        poolFee: "0",
        poolRelayer: ACCOUNT_A,
      },
      deadline: 5_000,
      fee: "100",
      acceptedAt: Date.now(),
      attempts: 0,
    });

    expect(queue.size()).toBe(1);
    expect((await store.load())?.length).toBe(1);

    const rehydrated = new AcceptedJobQueue(store);
    await rehydrated.hydrate();
    expect(rehydrated.get(jobId)?.acceptedTx).toBe("accept-tx");

    await rehydrated.resolve(jobId);
    expect(rehydrated.size()).toBe(0);
    expect((await store.load())?.length).toBe(0);
  });

  it("counts failed attempts and keeps the last error", async () => {
    const store = new MemoryAcceptedJobStore();
    const queue = new AcceptedJobQueue(store);
    const jobId = bytesToHex(bytes(32, 0x47));

    await queue.enqueue({
      jobId,
      acceptedTx: "accept-tx",
      payload: {
        poolId: CONTRACT,
        proofA: "0x00",
        proofB: "0x00",
        proofC: "0x00",
        withdrawnValue: "500",
        stateRoot: "0x00",
        aspRoot: "0x00",
        nullifierHash: "0x00",
        newCommitment: "0x00",
        recipient: ACCOUNT_A,
        poolFee: "0",
        poolRelayer: ACCOUNT_A,
      },
      deadline: 5_000,
      fee: "100",
      acceptedAt: Date.now(),
      attempts: 0,
    });

    await queue.recordFailure(jobId, "submit unavailable");
    await queue.recordFailure(jobId, "submit unavailable again");

    expect(queue.get(jobId)?.attempts).toBe(2);
    expect(queue.get(jobId)?.lastError).toBe("submit unavailable again");
    expect(queue.size()).toBe(1);
  });
});
