import { Keypair } from "@stellar/stellar-sdk";
import { openBox } from "./shared/box.ts";
import {
  decodePoolWithdrawPayload,
  hashPoolWithdrawPayloadHex,
  type PoolWithdrawPayload,
} from "./shared/payload.ts";
import { bytesToHex } from "./shared/bytes.ts";
import {
  makeBid,
  validateAdvert,
  validatePayload,
  type EncryptedPayload,
  type JobAdvert,
  type RelayerBid,
} from "./messages.ts";
import type { JobLedger } from "./reconciler.ts";

export type OnChainJob = {
  exists: boolean;
  status: "open" | "accepted" | "submitted" | "slashed" | "canceled";
  fee: bigint;
  deadline: number;
  payloadHash: string;
};

export type OnChainRelayer = {
  registered: boolean;
  x25519Pk: string;
  endpoint: string;
  freeStake: bigint;
};

export interface RelayerChainAdapter {
  getJob(jobId: string): Promise<OnChainJob | null>;
  getRelayer(operator: string): Promise<OnChainRelayer | null>;
  /**
   * Latest finalized ledger. The engine needs this to measure how much deadline
   * is left before bidding (#974) — a job's `deadline` is a ledger number, not a
   * wall-clock time, so it can only be compared against the chain's current head.
   */
  latestLedger(): Promise<number>;
  simulatePoolWithdraw(payload: PoolWithdrawPayload): Promise<void>;
  acceptJob(jobId: string): Promise<string>;
  submitPoolWithdraw(jobId: string, payload: PoolWithdrawPayload): Promise<string>;
}

export interface RelayerEngineConfig {
  operator: Keypair;
  x25519PublicKey: Uint8Array;
  x25519SecretKey: Uint8Array;
  endpoint?: string;
  minFee: bigint;
  chain: RelayerChainAdapter;
  /** Optional ledger that records each successfully submitted job for reconciliation. */
  jobLedger?: JobLedger;
  /**
   * Ledgers of deadline headroom a job must still have before the engine bids on
   * it (#974). Accepting a job commits this operator to two sequential on-chain
   * transactions — `accept_job`, then `submit_pool_withdraw` — so a job that is
   * about to expire cannot realistically be completed and would end in a slash
   * for a deadline the operator never had time to meet.
   */
  deadlineMarginLedgers?: number;
  /**
   * Called once a job this operator accepted has resolved, so the result can be
   * gossiped to the hub for completion-rate scoring (#973). A throwing or
   * rejecting hook is contained here — it must never turn a settled job into a
   * failed payload delivery.
   */
  onSettled?: (jobId: string, result: "completed" | "failed") => void | Promise<void>;
}

export type RelayerEngineStats = {
  jobsSeen: number;
  bidsSent: number;
  payloadsSeen: number;
  accepted: number;
  submitted: number;
  rejected: number;
  /** Adverts declined because the job had less deadline headroom than the margin (#974). */
  deadlineDeclined: number;
  lastError: string | null;
};

export type HealthReport = {
  ok: boolean;
  uptime: number;
  queueDepth: number;
  oldestPendingJobAge: number | null;
  stats: RelayerEngineStats;
  dependencies: {
    rpc: { ok: boolean; latencyMs?: number };
  };
};

type IdempotencyEntry = {
  result: { acceptedTx: string; submittedTx: string };
  expiresAt: number;
};

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Expiry time for old bids (90 days). */
const BID_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Default deadline headroom required before bidding (#974). `accept_job` and
 * `submit_pool_withdraw` are sequential, each confirmed against the RPC before
 * the next is sent, and Stellar closes a ledger roughly every 5s — so 30 ledgers
 * (~2.5 min) covers accept-plus-submit latency with room to spare. Operators on
 * faster or slower networks can widen or narrow it.
 */
const DEFAULT_DEADLINE_MARGIN_LEDGERS = 30;

type BidEntry = RelayerBid & { addedAt: number };

export class RelayerEngine {
  readonly stats: RelayerEngineStats = {
    jobsSeen: 0,
    bidsSent: 0,
    payloadsSeen: 0,
    accepted: 0,
    submitted: 0,
    rejected: 0,
    deadlineDeclined: 0,
    lastError: null,
  };

  private bids = new Map<string, BidEntry[]>();
  private idempotencyStore = new Map<string, IdempotencyEntry>();
  private pendingIdempotency = new Map<string, Promise<{ acceptedTx: string; submittedTx: string } | null>>();
  private pendingJobs = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number;
  private readonly deadlineMarginLedgers: number;

  constructor(private cfg: RelayerEngineConfig) {
    this.startedAt = Date.now();
    const margin = cfg.deadlineMarginLedgers ?? DEFAULT_DEADLINE_MARGIN_LEDGERS;
    this.deadlineMarginLedgers = Number.isFinite(margin) && margin >= 0 ? margin : DEFAULT_DEADLINE_MARGIN_LEDGERS;
  }

  bidsFor(jobId: string): RelayerBid[] {
    return this.bids.get(jobId.toLowerCase()) ?? [];
  }

  async healthCheck(): Promise<HealthReport> {
    const queueDepth = this.pendingJobs.size;
    let oldestPendingJobAge: number | null = null;
    const now = Date.now();
    for (const submittedAt of this.pendingJobs.values()) {
      const age = now - submittedAt;
      if (oldestPendingJobAge === null || age > oldestPendingJobAge) {
        oldestPendingJobAge = age;
      }
    }

    let rpcOk = true;
    let rpcLatency: number | undefined;
    try {
      const start = Date.now();
      await this.cfg.chain.getRelayer(this.cfg.operator.publicKey());
      rpcLatency = Date.now() - start;
    } catch {
      rpcOk = false;
    }

    return {
      ok: rpcOk,
      uptime: now - this.startedAt,
      queueDepth,
      oldestPendingJobAge,
      stats: { ...this.stats },
      dependencies: {
        rpc: { ok: rpcOk, latencyMs: rpcLatency },
      },
    };
  }

  async handleAdvert(raw: unknown): Promise<RelayerBid | null> {
    const advert = validateAdvert(raw);
    this.stats.jobsSeen += 1;
    try {
      const relayer = await this.cfg.chain.getRelayer(this.cfg.operator.publicKey());
      if (!relayer?.registered) return null;
      if (normalizeHex(relayer.x25519Pk) !== normalizeHex(bytesToHex(this.cfg.x25519PublicKey))) {
        return null;
      }
      const job = await this.cfg.chain.getJob(advert.jobId);
      if (!job?.exists || job.status !== "open") return null;
      if (job.fee < this.cfg.minFee || relayer.freeStake < job.fee) return null;
      // #974: a deadline is a ledger number, so compare it against the chain head
      // rather than wall-clock time. Bids on a job that is about to expire get
      // accepted and then slashed for a deadline there was no time to meet.
      const latestLedger = await this.cfg.chain.latestLedger();
      if (job.deadline - latestLedger < this.deadlineMarginLedgers) {
        this.stats.deadlineDeclined += 1;
        return null;
      }
      if (
        job.fee.toString() !== advert.fee ||
        job.deadline !== advert.deadline ||
        job.payloadHash.toLowerCase() !== advert.payloadHash.toLowerCase()
      ) {
        return null;
      }
      const bid = makeBid({
        advert,
        operator: this.cfg.operator,
        x25519Pk: this.cfg.x25519PublicKey,
        endpoint: this.cfg.endpoint,
        freeStake: relayer.freeStake,
      });
      this.rememberBid(bid);
      this.stats.bidsSent += 1;
      return bid;
    } catch (err) {
      this.stats.rejected += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  rememberBid(bid: RelayerBid): void {
    const key = bid.jobId.toLowerCase();
    const list = this.bids.get(key) ?? [];
    if (!list.some((b) => b.operator === bid.operator)) {
      list.push({ ...bid, addedAt: Date.now() });
      this.bids.set(key, list);
    }
  }

  async handlePayload(raw: unknown): Promise<{ acceptedTx: string; submittedTx: string } | null> {
    const payloadMsg: EncryptedPayload = validatePayload(raw);
    this.stats.payloadsSeen += 1;
    const ownPk = bytesToHex(this.cfg.x25519PublicKey).toLowerCase();
    if (payloadMsg.to.toLowerCase() !== ownPk) return null;

    if (payloadMsg.idempotencyKey) {
      const existing = this.idempotencyStore.get(payloadMsg.idempotencyKey);
      if (existing && existing.expiresAt > Date.now()) {
        return existing.result;
      }
      this.idempotencyStore.delete(payloadMsg.idempotencyKey);

      const pending = this.pendingIdempotency.get(payloadMsg.idempotencyKey);
      if (pending) {
        return pending;
      }
    }

    const processPayload = async (): Promise<{ acceptedTx: string; submittedTx: string } | null> => {
      this.pendingJobs.set(payloadMsg.jobId.toLowerCase(), Date.now());
      // An outcome is only owed for a job this operator actually accepted —
      // anything that fails before accept_job (a hash mismatch, a job someone
      // else already took) was never this operator's to complete, and reporting
      // it would let a third party drag the completion-rate score down.
      let acceptedJob = false;
      try {
        const plaintext = openBox(payloadMsg.box, this.cfg.x25519SecretKey);
        const payload = decodePoolWithdrawPayload(plaintext);
        const job = await this.cfg.chain.getJob(payloadMsg.jobId);
        if (!job?.exists || job.status !== "open") return null;
        if (hashPoolWithdrawPayloadHex(payload).toLowerCase() !== job.payloadHash.toLowerCase()) {
          throw new Error("Payload hash mismatch.");
        }
        await this.cfg.chain.simulatePoolWithdraw(payload);
        const acceptedTx = await this.cfg.chain.acceptJob(payloadMsg.jobId);
        acceptedJob = true;
        this.stats.accepted += 1;
        const submittedTx = await this.cfg.chain.submitPoolWithdraw(payloadMsg.jobId, payload);
        this.stats.submitted += 1;
        const result = { acceptedTx, submittedTx };

        this.cfg.jobLedger?.record({
          jobId: payloadMsg.jobId,
          acceptedTx,
          submittedTx,
          expectedFee: job.fee,
          submittedAt: Date.now(),
        });

        await this.notifySettled(payloadMsg.jobId, "completed");

        if (payloadMsg.idempotencyKey) {
          this.idempotencyStore.set(payloadMsg.idempotencyKey, {
            result,
            expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
          });
        }

        return result;
      } catch (err) {
        this.stats.rejected += 1;
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        if (acceptedJob) {
          await this.notifySettled(payloadMsg.jobId, "failed");
        }
        throw err;
      } finally {
        this.pendingJobs.delete(payloadMsg.jobId.toLowerCase());
      }
    };

    if (payloadMsg.idempotencyKey) {
      const promise = processPayload().finally(() => {
        this.pendingIdempotency.delete(payloadMsg.idempotencyKey!);
      });
      this.pendingIdempotency.set(payloadMsg.idempotencyKey, promise);
      return promise;
    }

    return processPayload();
  }

  /**
   * Report a settled job to the `onSettled` hook. Awaited so that by the time
   * `handlePayload` resolves the outcome has actually been published — a
   * completed job that is never reported leaves the operator permanently
   * unscored at the hub. A throwing or rejecting hook is contained here: the job
   * is already on-chain, so failing the delivery would be strictly worse than
   * losing the completion-rate datapoint.
   */
  private async notifySettled(jobId: string, result: "completed" | "failed"): Promise<void> {
    const hook = this.cfg.onSettled;
    if (!hook) return;
    try {
      await hook(jobId, result);
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Prune expired entries from memory maps. Runs on a timer. Safe to call multiple times. */
  startPruneWatch(intervalMs: number = 60 * 60 * 1000): void {    if (this.pruneTimer !== null) return;
    this.pruneTimer = setInterval(() => this.prune(), intervalMs);
  }

  stopPruneWatch(): void {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private prune(now: number = Date.now()): void {
    for (const [jobId, bidList] of this.bids) {
      const fresh = bidList.filter((bid) => now - bid.addedAt < BID_EXPIRY_MS);
      if (fresh.length === 0) {
        this.bids.delete(jobId);
      } else if (fresh.length !== bidList.length) {
        this.bids.set(jobId, fresh);
      }
    }

    for (const [key, entry] of this.idempotencyStore) {
      if (now >= entry.expiresAt) {
        this.idempotencyStore.delete(key);
      }
    }
  }
}

function normalizeHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, "");
}
