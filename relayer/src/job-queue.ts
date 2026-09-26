/**
 * Durable record of jobs this operator has accepted but not yet submitted
 * (issue #975).
 *
 * `acceptJob` and `submitPoolWithdraw` are two separate on-chain transactions.
 * When a process died between them the job was already bonded to this operator
 * and nobody would ever submit it, so it missed its deadline and the stake was
 * slashed — for a crash, not a failure to deliver.
 *
 * The entry is therefore written (and awaited) *before* the submit is attempted,
 * carrying the payload needed to submit it. On boot the engine walks the queue
 * and finishes anything still outstanding, so a restart recovers the job instead
 * of abandoning it.
 */
import type { SerializablePoolWithdrawPayload } from "./shared/payload.ts";
import type { AcceptedJobStore } from "./store.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("relayer");

/** One accepted-but-unsubmitted job. */
export type AcceptedJobEntry = {
  jobId: string;
  /** Transaction hash returned by `accept_job`. */
  acceptedTx: string;
  /** The withdraw payload, serialized so the job can be submitted after a restart. */
  payload: SerializablePoolWithdrawPayload;
  /** Job deadline as a ledger number. */
  deadline: number;
  /** Fee agreed at accept time, decimal string. */
  fee: string;
  /** Unix ms when `accept_job` confirmed. */
  acceptedAt: number;
  /** Submit attempts made so far. */
  attempts: number;
  /** Last submit error, for operator diagnosis. */
  lastError?: string;
};

/**
 * The accepted-jobs queue. Backed by an {@link AcceptedJobStore} so the contents
 * outlive the process.
 */
export class AcceptedJobQueue {
  private entries = new Map<string, AcceptedJobEntry>();
  private loaded = false;

  constructor(private readonly store?: AcceptedJobStore) {}

  async hydrate(): Promise<void> {
    if (this.loaded || !this.store) return;
    this.loaded = true;
    try {
      const saved = await this.store.load();
      if (!saved) return;
      for (const entry of saved) {
        this.entries.set(entry.jobId.toLowerCase(), entry);
      }
    } catch (err) {
      log.error("accepted-jobs hydrate failed", { error: err });
    }
  }

  /**
   * Record an accepted job. Awaited by the engine so the entry is durable before
   * the submit is attempted — that ordering is the whole point of this queue.
   */
  async enqueue(entry: AcceptedJobEntry): Promise<void> {
    this.entries.set(entry.jobId.toLowerCase(), entry);
    await this.persist();
  }

  /** Still awaiting submission, oldest acceptance first. */
  pending(): AcceptedJobEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => a.acceptedAt - b.acceptedAt);
  }

  get(jobId: string): AcceptedJobEntry | undefined {
    return this.entries.get(jobId.toLowerCase());
  }

  size(): number {
    return this.entries.size;
  }

  /** Drop a job that has been submitted (or abandoned). */
  async resolve(jobId: string): Promise<void> {
    this.entries.delete(jobId.toLowerCase());
    await this.persist();
  }

  /** Note a failed submit attempt; the entry stays queued for another try. */
  async recordFailure(jobId: string, error: string): Promise<void> {
    const entry = this.entries.get(jobId.toLowerCase());
    if (!entry) return;
    entry.attempts += 1;
    entry.lastError = error;
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.save(this.pending());
    } catch (err) {
      log.error("accepted-jobs persist failed", { error: err });
    }
  }
}
