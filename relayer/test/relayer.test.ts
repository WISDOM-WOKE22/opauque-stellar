import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createRelayerHttpServer } from "../src/http.ts";
import { RelayerEngine, type RelayerChainAdapter, type OnChainJob, type OnChainRelayer } from "../src/engine.ts";
import { HttpGossipTransport, MemoryGossipTransport } from "../src/gossip.ts";
import { HEARTBEAT_MISS_THRESHOLD_MS, RelayerHub, attachRelayerEngineToGossip } from "../src/hub.ts";
import { generateX25519Keypair, openBox, sealBox } from "../src/shared/box.ts";
import { bytesToHex, hexToBytes } from "../src/shared/bytes.ts";
import {
  encodePoolWithdrawPayload,
  hashPoolWithdrawPayloadHex,
  type PoolWithdrawPayload,
} from "../src/shared/payload.ts";
import { makeAdvert, verifyBid, type RelayerBid } from "../src/messages.ts";
import { RateLimiter } from "../src/rate-limit.ts";

const ACCOUNT_A = "GABTYFQAXDR724JAJSNZVUH56T62JJ7CLWT6YL56ME7OPA4DIIMAMOI6";
const ACCOUNT_B = "GDKPRDH3AGALVIZ3OX5LJGNIXZOWUBCIX5HA36YXOSQOGEZLDCJOSGDR";
const CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

function bytes(len: number, tag: number): Uint8Array {
  return new Uint8Array(len).fill(tag);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBids(base: string, jobId: string): Promise<unknown[]> {
  for (let i = 0; i < 20; i += 1) {
    const listed = await fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}/bids`);
    const body = (await listed.json()) as { bids?: unknown[] };
    if ((body.bids ?? []).length > 0) return body.bids ?? [];
    await sleep(25);
  }
  return [];
}

function payload(poolRelayer = ACCOUNT_B): PoolWithdrawPayload {
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

class FakeChain implements RelayerChainAdapter {
  job: OnChainJob;
  relayer: OnChainRelayer;
  accepted = 0;
  submitted = 0;
  simulated = 0;
  latest = 100;

  constructor(payloadHash: string, x25519Pk: string) {
    this.job = {
      exists: true,
      status: "open",
      fee: 100n,
      deadline: 150,
      payloadHash,
    };
    this.relayer = {
      registered: true,
      x25519Pk,
      endpoint: "http://127.0.0.1:8787",
      freeStake: 1_000n,
    };
  }

  async getJob(): Promise<OnChainJob> {
    return this.job;
  }

  async getRelayer(): Promise<OnChainRelayer> {
    return this.relayer;
  }

  async latestLedger(): Promise<number> {
    return this.latest;
  }

  async simulatePoolWithdraw(): Promise<void> {
    this.simulated += 1;
  }

  async acceptJob(): Promise<string> {
    this.accepted += 1;
    return "accept-tx";
  }

  async submitPoolWithdraw(): Promise<string> {
    this.submitted += 1;
    this.job.status = "submitted";
    return "submit-tx";
  }
}

describe("relayer market shared crypto", () => {
  it("encrypts payloads only the selected relayer can open", () => {
    const recipient = generateX25519Keypair();
    const other = generateX25519Keypair();
    const plaintext = new TextEncoder().encode("blind job");
    const box = sealBox(plaintext, recipient.publicKey);
    expect(new TextDecoder().decode(openBox(box, recipient.secretKey))).toBe("blind job");
    expect(() => openBox(box, other.secretKey)).toThrow(/decrypt/i);
  });
});

describe("relayer market messages", () => {
  it("matches the contract payload hash fixture", () => {
    expect(hashPoolWithdrawPayloadHex(payload(ACCOUNT_B))).toBe(
      "0x94f0acd43cc1f0b9afcc760a9a03699c5f18f52fdb6ec3044455feb3b39599d2",
    );
  });

  it("signs and verifies bids", () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const advert = makeAdvert({
      jobId: bytes(32, 0x11),
      fee: 100n,
      deadline: 150,
      payloadHash: hexToBytes(hashPoolWithdrawPayloadHex(p)),
    });
    const chain = new FakeChain(advert.payloadHash, bytesToHex(x25519.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    return engine.handleAdvert(advert).then((bid) => {
      expect(bid).not.toBeNull();
      expect(verifyBid(bid!)).toBe(true);
    });
  });

  it("does not bid when the registered X25519 key does not match the node key", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const registered = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const advert = makeAdvert({
      jobId: bytes(32, 0x15),
      fee: 100n,
      deadline: 150,
      payloadHash: hexToBytes(hashPoolWithdrawPayloadHex(p)),
    });
    const chain = new FakeChain(advert.payloadHash, bytesToHex(registered.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    await expect(engine.handleAdvert(advert)).resolves.toBeNull();
  });
});

describe("relayer deadline awareness (#974)", () => {
  function buildEngine(overrides: { deadline?: number; latest?: number; margin?: number } = {}) {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const advert = makeAdvert({
      jobId: bytes(32, 0x1d),
      fee: 100n,
      deadline: overrides.deadline ?? 150,
      payloadHash: hexToBytes(hashPoolWithdrawPayloadHex(p)),
    });
    const chain = new FakeChain(advert.payloadHash, bytesToHex(x25519.publicKey));
    chain.latest = overrides.latest ?? 100;
    chain.job.deadline = advert.deadline;
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
      deadlineMarginLedgers: overrides.margin ?? 30,
    });
    return { engine, chain, advert };
  }

  it("does not bid on a job whose remaining ledgers are below the margin", async () => {
    // 5 ledgers left against a 30-ledger margin: accepting it would commit the
    // operator to accept + submit with no time to spare.
    const { engine, advert } = buildEngine({ deadline: 105, latest: 100 });
    await expect(engine.handleAdvert(advert)).resolves.toBeNull();
    expect(engine.stats.bidsSent).toBe(0);
    expect(engine.stats.deadlineDeclined).toBe(1);
  });

  it("does not bid on a job that has already passed its deadline", async () => {
    const { engine, advert } = buildEngine({ deadline: 90, latest: 100 });
    await expect(engine.handleAdvert(advert)).resolves.toBeNull();
    expect(engine.stats.deadlineDeclined).toBe(1);
  });

  it("bids when the remaining ledgers clear the margin", async () => {
    const { engine, advert } = buildEngine({ deadline: 150, latest: 100 });
    const bid = await engine.handleAdvert(advert);
    expect(bid).not.toBeNull();
    expect(verifyBid(bid!)).toBe(true);
    expect(engine.stats.deadlineDeclined).toBe(0);
  });

  it("treats the margin as a hard floor — exactly the margin still bids", async () => {
    const { engine, advert } = buildEngine({ deadline: 130, latest: 100 });
    await expect(engine.handleAdvert(advert)).resolves.not.toBeNull();
  });

  it("honours a widened margin", async () => {
    const { engine, advert } = buildEngine({ deadline: 150, latest: 100, margin: 500 });
    await expect(engine.handleAdvert(advert)).resolves.toBeNull();
  });

  it("declines rather than bidding blind when the chain head is unavailable", async () => {
    const { engine, chain, advert } = buildEngine({ deadline: 150, latest: 100 });
    chain.latestLedger = async () => {
      throw new Error("rpc down");
    };
    await expect(engine.handleAdvert(advert)).resolves.toBeNull();
  });
});

describe("relayer engine", () => {
  it("accepts and submits only after decrypting a hash-matching payload", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const hash = hashPoolWithdrawPayloadHex(p);
    const chain = new FakeChain(hash, bytesToHex(x25519.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    const jobId = bytesToHex(bytes(32, 0x12));
    const box = sealBox(encodePoolWithdrawPayload(p), x25519.publicKey);
    const result = await engine.handlePayload({ t: "payload", v: 1, jobId, to: bytesToHex(x25519.publicKey), box });
    expect(result).toEqual({ acceptedTx: "accept-tx", submittedTx: "submit-tx" });
    expect(chain.simulated).toBe(1);
    expect(chain.accepted).toBe(1);
    expect(chain.submitted).toBe(1);
  });

  it("rejects encrypted payloads whose hash does not match the job", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const chain = new FakeChain(bytesToHex(bytes(32, 0xff)), bytesToHex(x25519.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    const p = payload(operator.publicKey());
    const box = sealBox(encodePoolWithdrawPayload(p), x25519.publicKey);
    await expect(
      engine.handlePayload({ t: "payload", v: 1, jobId: bytesToHex(bytes(32, 0x13)), to: bytesToHex(x25519.publicKey), box }),
    ).rejects.toThrow(/hash mismatch/i);
    expect(chain.accepted).toBe(0);
  });

  it("returns the same result for duplicate idempotency keys", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const hash = hashPoolWithdrawPayloadHex(p);
    const chain = new FakeChain(hash, bytesToHex(x25519.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    const jobId = bytesToHex(bytes(32, 0x18));
    const box = sealBox(encodePoolWithdrawPayload(p), x25519.publicKey);
    const idempotencyKey = "test-key-001";

    const first = await engine.handlePayload({
      t: "payload", v: 1, jobId, to: bytesToHex(x25519.publicKey), box, idempotencyKey,
    });
    expect(first).toEqual({ acceptedTx: "accept-tx", submittedTx: "submit-tx" });
    expect(chain.accepted).toBe(1);

    const second = await engine.handlePayload({
      t: "payload", v: 1, jobId, to: bytesToHex(x25519.publicKey), box, idempotencyKey,
    });
    expect(second).toEqual(first);
    expect(chain.accepted).toBe(1);
  });

  it("deduplicates concurrent submissions with the same idempotency key", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const hash = hashPoolWithdrawPayloadHex(p);
    const chain = new FakeChain(hash, bytesToHex(x25519.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    const jobId = bytesToHex(bytes(32, 0x19));
    const box = sealBox(encodePoolWithdrawPayload(p), x25519.publicKey);
    const idempotencyKey = "concurrent-key-001";

    const results = await Promise.all([
      engine.handlePayload({
        t: "payload", v: 1, jobId, to: bytesToHex(x25519.publicKey), box, idempotencyKey,
      }),
      engine.handlePayload({
        t: "payload", v: 1, jobId, to: bytesToHex(x25519.publicKey), box, idempotencyKey,
      }),
    ]);

    const successful = results.filter((r) => r !== null);
    expect(successful.length).toBeGreaterThanOrEqual(1);
    expect(chain.accepted).toBe(1);
  });
});

describe("relayer HTTP gateway", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("serves bids over the spec gateway endpoints", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const advert = makeAdvert({
      jobId: bytes(32, 0x14),
      fee: 100n,
      deadline: 150,
      payloadHash: hexToBytes(hashPoolWithdrawPayloadHex(p)),
    });
    const chain = new FakeChain(advert.payloadHash, bytesToHex(x25519.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    const server = createRelayerHttpServer(engine);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port.");
    const base = `http://127.0.0.1:${address.port}`;

    const post = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(advert),
    });
    expect(post.status).toBe(202);
    const listed = await fetch(`${base}/v1/jobs/${encodeURIComponent(advert.jobId)}/bids`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { bids: unknown[] };
    expect(body.bids).toHaveLength(1);
  });

  it("bridges gateway adverts and bids through gossip transport", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const advert = makeAdvert({
      jobId: bytes(32, 0x16),
      fee: 100n,
      deadline: 150,
      payloadHash: hexToBytes(hashPoolWithdrawPayloadHex(p)),
    });
    const chain = new FakeChain(advert.payloadHash, bytesToHex(x25519.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    const transport = new MemoryGossipTransport();
    const hub = new RelayerHub(transport);
    await hub.start();
    await attachRelayerEngineToGossip(engine, transport);

    const server = createRelayerHttpServer(hub);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup = async () => {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port.");
    const base = `http://127.0.0.1:${address.port}`;

    const post = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(advert),
    });
    expect(post.status).toBe(202);
    const listed = await fetch(`${base}/v1/jobs/${encodeURIComponent(advert.jobId)}/bids`);
    const body = (await listed.json()) as { bids: unknown[] };
    expect(body.bids).toHaveLength(1);
    expect(verifyBid(body.bids[0] as RelayerBid)).toBe(true);
  });

  it("lets relayer nodes subscribe to a gateway hub over HTTP gossip", async () => {
    const operator = Keypair.random();
    const x25519 = generateX25519Keypair();
    const p = payload(operator.publicKey());
    const advert = makeAdvert({
      jobId: bytes(32, 0x17),
      fee: 100n,
      deadline: 150,
      payloadHash: hexToBytes(hashPoolWithdrawPayloadHex(p)),
    });
    const chain = new FakeChain(advert.payloadHash, bytesToHex(x25519.publicKey));
    const engine = new RelayerEngine({
      operator,
      x25519PublicKey: x25519.publicKey,
      x25519SecretKey: x25519.secretKey,
      minFee: 1n,
      chain,
    });
    const hubTransport = new MemoryGossipTransport();
    const hub = new RelayerHub(hubTransport);
    await hub.start();
    const server = createRelayerHttpServer(hub);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port.");
    const base = `http://127.0.0.1:${address.port}`;
    const nodeTransport = new HttpGossipTransport(base);
    await attachRelayerEngineToGossip(engine, nodeTransport);
    cleanup = async () => {
      await nodeTransport.close();
      await hubTransport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    const post = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(advert),
    });
    expect(post.status).toBe(202);
    const bids = await waitForBids(base, advert.jobId);
    expect(bids).toHaveLength(1);
    expect(verifyBid(bids[0] as RelayerBid)).toBe(true);
  });
});

describe("relayer completion-rate scoring", () => {
  it("gives a brand-new relayer a neutral score", () => {
    const hub = new RelayerHub(new MemoryGossipTransport());
    hub.recordOutcome(ACCOUNT_A, "completed");
    expect(hub.scoreFor(ACCOUNT_B).score).toBe(0.5);
    expect(hub.scoreFor(ACCOUNT_B).completed).toBe(0);
    expect(hub.scoreFor(ACCOUNT_B).failed).toBe(0);
  });

  it("derives a score from completed vs failed jobs", () => {
    const hub = new RelayerHub(new MemoryGossipTransport());
    hub.recordOutcome(ACCOUNT_A, "completed");
    hub.recordOutcome(ACCOUNT_A, "completed");
    hub.recordOutcome(ACCOUNT_A, "completed");
    hub.recordOutcome(ACCOUNT_A, "failed");
    const score = hub.scoreFor(ACCOUNT_A);
    expect(score.completed).toBe(3);
    expect(score.failed).toBe(1);
    expect(score.score).toBeCloseTo(0.75);
  });

  it("drops outcomes that fall outside the scoring window", () => {
    const hub = new RelayerHub(new MemoryGossipTransport());
    const longAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    hub.recordOutcome(ACCOUNT_A, "failed", longAgo);
    hub.recordOutcome(ACCOUNT_A, "completed");
    const score = hub.scoreFor(ACCOUNT_A);
    expect(score.completed).toBe(1);
    expect(score.failed).toBe(0);
    expect(score.score).toBe(1);
  });

  it("exposes scores for every known relayer via the market API", async () => {
    const transport = new MemoryGossipTransport();
    const hub = new RelayerHub(transport);
    await hub.start();
    hub.recordOutcome(ACCOUNT_A, "completed");
    hub.recordOutcome(ACCOUNT_A, "failed");
    hub.recordOutcome(ACCOUNT_B, "completed");

    const server = createRelayerHttpServer(hub);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port.");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const all = await fetch(`${base}/v1/relayers/scores`);
      const allBody = (await all.json()) as { scores: Array<{ operator: string; score: number }> };
      expect(allBody.scores).toHaveLength(2);
      expect(allBody.scores.find((s) => s.operator === ACCOUNT_B)?.score).toBe(1);

      const one = await fetch(`${base}/v1/relayers/${encodeURIComponent(ACCOUNT_A)}/score`);
      const oneBody = (await one.json()) as { score: { completed: number; failed: number } };
      expect(oneBody.score.completed).toBe(1);
      expect(oneBody.score.failed).toBe(1);

      const unseen = await fetch(`${base}/v1/relayers/${encodeURIComponent(ACCOUNT_B + "X")}/score`);
      const unseenBody = (await unseen.json()) as { score: { score: number } };
      expect(unseenBody.score.score).toBe(0.5);
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("scores relayers reported over gossip as completed or failed", async () => {
    const transport = new MemoryGossipTransport();
    const hub = new RelayerHub(transport);
    await hub.start();

    await hub.handleOutcome({
      t: "outcome",
      v: 1,
      jobId: bytesToHex(bytes(32, 0x9)),
      operator: ACCOUNT_A,
      result: "completed",
    });

    expect(hub.scoreFor(ACCOUNT_A).completed).toBe(1);
  });
});

describe("relayer gateway rate limiting", () => {
  async function startServer(tight: RateLimiter, loose: RateLimiter) {
    const transport = new MemoryGossipTransport();
    const hub = new RelayerHub(transport);
    await hub.start();
    const server = createRelayerHttpServer(hub, tight, loose);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port.");
    const base = `http://127.0.0.1:${address.port}`;
    const close = async () => {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return { base, close };
  }

  function advertBody(tag: number) {
    return makeAdvert({
      jobId: bytes(32, tag),
      fee: 10n,
      deadline: 200,
      payloadHash: bytes(32, tag + 1),
    });
  }

  it("stamps standard rate-limit headers on an ordinary request", async () => {
    const { base, close } = await startServer(new RateLimiter(60_000, 120, 20), new RateLimiter(60_000, 600, 200));
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ratelimit-limit")).not.toBeNull();
      expect(res.headers.get("x-ratelimit-remaining")).not.toBeNull();
      expect(res.headers.get("x-ratelimit-reset")).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("allows a burst then rejects with retry-after guidance once it's spent", async () => {
    // Tight tier: burst of 2, effectively no sustained refill within the test's runtime.
    const { base, close } = await startServer(new RateLimiter(60_000, 2, 2), new RateLimiter(60_000, 600, 200));
    try {
      const first = await fetch(`${base}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(advertBody(0x21)),
      });
      const second = await fetch(`${base}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(advertBody(0x23)),
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);

      const third = await fetch(`${base}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(advertBody(0x25)),
      });
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).not.toBeNull();
      const body = (await third.json()) as { ok: boolean; retryAfterSeconds: number };
      expect(body.ok).toBe(false);
      expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    } finally {
      await close();
    }
  });

  it("never rate-limits a legitimate single-user polling flow", async () => {
    const { base, close } = await startServer(new RateLimiter(60_000, 120, 20), new RateLimiter(60_000, 600, 200));
    try {
      for (let i = 0; i < 20; i += 1) {
        const res = await fetch(`${base}/v1/jobs/${encodeURIComponent(bytesToHex(bytes(32, 0x40)))}/bids`);
        expect(res.status).toBe(200);
      }
    } finally {
      await close();
    }
  });
});

describe("hub-coordinated failover", () => {
  function bidFor(jobIdHex: string, operator: string): RelayerBid {
    return {
      t: "bid",
      v: 1,
      jobId: jobIdHex,
      chain: 0,
      operator,
      x25519Pk: bytesToHex(bytes(32, operator.charCodeAt(0))),
      sig: "sig",
    };
  }

  it("reassigns a job once its operator misses the heartbeat threshold", async () => {
    const jobIdHex = bytesToHex(bytes(32, 0x50));
    const deadOperator = ACCOUNT_A;
    const aliveOperator = ACCOUNT_B;
    const logged: string[] = [];
    const hub = new RelayerHub(new MemoryGossipTransport(), (jobId) => logged.push(jobId));

    hub.rememberBid(bidFor(jobIdHex, deadOperator));
    hub.rememberBid(bidFor(jobIdHex, aliveOperator));

    const now = Date.now();
    hub.recordHeartbeat(deadOperator, now - HEARTBEAT_MISS_THRESHOLD_MS - 1);
    hub.recordHeartbeat(aliveOperator, now);
    // Only a payload delivery tells the hub who currently owns the job.
    await hub.handlePayload({
      t: "payload",
      v: 1,
      jobId: jobIdHex,
      to: bidFor(jobIdHex, deadOperator).x25519Pk,
      box: "box",
    });

    const events = hub.runFailoverCheck(now);
    expect(events).toEqual([{ jobId: jobIdHex.toLowerCase(), from: deadOperator, to: aliveOperator }]);
    // Only the job identifier reaches the log — no operator, payload, or recipient data.
    expect(logged).toEqual([jobIdHex.toLowerCase()]);

    // Re-running immediately is a no-op: the job is now tracked against the live operator.
    expect(hub.runFailoverCheck(now)).toEqual([]);
  });

  it("does not reassign when no healthy alternate exists", async () => {
    const jobIdHex = bytesToHex(bytes(32, 0x51));
    const deadOperator = ACCOUNT_A;
    const hub = new RelayerHub(new MemoryGossipTransport());
    hub.rememberBid(bidFor(jobIdHex, deadOperator));
    const now = Date.now();
    hub.recordHeartbeat(deadOperator, now - HEARTBEAT_MISS_THRESHOLD_MS - 1);
    await hub.handlePayload({
      t: "payload",
      v: 1,
      jobId: jobIdHex,
      to: bidFor(jobIdHex, deadOperator).x25519Pk,
      box: "box",
    });

    expect(hub.runFailoverCheck(now)).toEqual([]);
  });

  it("stops tracking a job once its outcome resolves, so it can never be reassigned afterward", async () => {
    const jobIdHex = bytesToHex(bytes(32, 0x52));
    const deadOperator = ACCOUNT_A;
    const aliveOperator = ACCOUNT_B;
    const hub = new RelayerHub(new MemoryGossipTransport());
    hub.rememberBid(bidFor(jobIdHex, deadOperator));
    hub.rememberBid(bidFor(jobIdHex, aliveOperator));
    const now = Date.now();
    hub.recordHeartbeat(deadOperator, now - HEARTBEAT_MISS_THRESHOLD_MS - 1);
    hub.recordHeartbeat(aliveOperator, now);
    await hub.handlePayload({
      t: "payload",
      v: 1,
      jobId: jobIdHex,
      to: bidFor(jobIdHex, deadOperator).x25519Pk,
      box: "box",
    });

    await hub.handleOutcome({ t: "outcome", v: 1, jobId: jobIdHex, operator: deadOperator, result: "completed" });

    // The job resolved (e.g. the original relayer submitted just before going dark) —
    // failover must not fire and hand off a job that's already settled on-chain.
    expect(hub.runFailoverCheck(now)).toEqual([]);
  });
});
