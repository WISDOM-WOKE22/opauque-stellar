import type { RelayerChainAdapter } from "./engine.ts";
import type { LedgerStore } from "./store.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("relayer");

// ---------------------------------------------------------------------------
// Job ledger
// ---------------------------------------------------------------------------

/** One entry written to the ledger when a job is fully submitted. */
export type JobLedgerEntry = {
  jobId: string;
  acceptedTx: string;
  submittedTx: string;
  /** Fee agreed upon and expected to be settled on-chain. */
  expectedFee: bigint;
  /** Unix milliseconds when the submit transaction was confirmed. */
  submittedAt: number;
};

/**
 * In-memory job ledger appended to by the engine after every successful
 * submit. The reconciler reads from this to compare against on-chain state.
 */
export class JobLedger {
  private entries = new Map<string, JobLedgerEntry>();
  private loaded = false;

  constructor(private readonly store?: LedgerStore) {}

  record(entry: JobLedgerEntry): void {
    this.entries.set(entry.jobId.toLowerCase(), entry);
    void this.persist();
  }

  all(): JobLedgerEntry[] {
    return Array.from(this.entries.values());
  }

  get(jobId: string): JobLedgerEntry | undefined {
    return this.entries.get(jobId.toLowerCase());
  }

  size(): number {
    return this.entries.size;
  }

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
      log.error("job ledger hydrate failed", { error: err });
    }
  }

  remove(jobId: string): void {
    this.entries.delete(jobId.toLowerCase());
    void this.persist();
  }

  private persist(): void {
    if (!this.store) return;
    this.store.save(this.all()).catch((err) => {
      log.error("job ledger persist failed", { error: err });
    });
  }
}

// ---------------------------------------------------------------------------
// Reconciliation report types
// ---------------------------------------------------------------------------

export type JobReconciliationResult = {
  jobId: string;
  /** Whether the on-chain state matches the local ledger. */
  outcome: "clean" | "discrepancy" | "not_found";
  expectedFee: string;
  onChainFee: string | null;
  onChainStatus: string | null;
  submittedTx: string;
  detail: string;
};

export type ReconciliationReport = {
  /** Unix ms when this run started. */
  runAt: number;
  /** Wallclock range this run covers (from earliest to latest submittedAt in the ledger). */
  coveredRange: { fromMs: number; toMs: number } | null;
  totalChecked: number;
  cleanCount: number;
  discrepancyCount: number;
  notFoundCount: number;
  /** Summary outcome for the whole run. */
  summary: "clean" | "discrepancies_found";
  discrepancies: JobReconciliationResult[];
};

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export interface ReconcilerOptions {
  chain: RelayerChainAdapter;
  ledger: JobLedger;
  /** Interval in milliseconds between scheduled runs. 0 disables scheduling. */
  intervalMs?: number;
  /** Called after every completed run. */
  onReport?: (report: ReconciliationReport) => void;
}

export class PayoutReconciler {
  private chain: RelayerChainAdapter;
  private ledger: JobLedger;
  private intervalMs: number;
  private onReport?: (report: ReconciliationReport) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReport: ReconciliationReport | null = null;
  private runCount = 0;

  constructor(opts: ReconcilerOptions) {
    this.chain = opts.chain;
    this.ledger = opts.ledger;
    this.intervalMs = opts.intervalMs ?? 0;
    this.onReport = opts.onReport;
  }

  /**
   * Run a reconciliation pass immediately and return the report.
   * Also persists the report as `lastReport` so callers can retrieve
   * it without re-running via `getLastReport()`.
   */
  async reconcile(): Promise<ReconciliationReport> {
    const runAt = Date.now();
    const entries = this.ledger.all();

    const results: JobReconciliationResult[] = [];

    for (const entry of entries) {
      const onChain = await this.chain.getJob(entry.jobId).catch(() => null);

      if (!onChain || !onChain.exists) {
        results.push({
          jobId: entry.jobId,
          outcome: "not_found",
          expectedFee: entry.expectedFee.toString(),
          onChainFee: null,
          onChainStatus: null,
          submittedTx: entry.submittedTx,
          detail: "Job not found on-chain. Possible chain reorganisation or wrong contract address.",
        });
        continue;
      }

      const feeMatches = onChain.fee === entry.expectedFee;
      const statusOk =
        onChain.status === "submitted" ||
        onChain.status === "slashed" ||
        onChain.status === "canceled";

      if (feeMatches && statusOk) {
        results.push({
          jobId: entry.jobId,
          outcome: "clean",
          expectedFee: entry.expectedFee.toString(),
          onChainFee: onChain.fee.toString(),
          onChainStatus: onChain.status,
          submittedTx: entry.submittedTx,
          detail: "OK",
        });
      } else {
        const reasons: string[] = [];
        if (!feeMatches) {
          reasons.push(
            `fee mismatch: expected ${entry.expectedFee}, on-chain ${onChain.fee}`,
          );
        }
        if (!statusOk) {
          reasons.push(
            `unexpected status: ${onChain.status} (expected submitted/slashed/canceled)`,
          );
        }
        results.push({
          jobId: entry.jobId,
          outcome: "discrepancy",
          expectedFee: entry.expectedFee.toString(),
          onChainFee: onChain.fee.toString(),
          onChainStatus: onChain.status,
          submittedTx: entry.submittedTx,
          detail: reasons.join("; "),
        });
      }
    }

    const discrepancies = results.filter((r) => r.outcome !== "clean");
    const cleanCount = results.filter((r) => r.outcome === "clean").length;
    const discrepancyCount = results.filter((r) => r.outcome === "discrepancy").length;
    const notFoundCount = results.filter((r) => r.outcome === "not_found").length;

    let coveredRange: ReconciliationReport["coveredRange"] = null;
    if (entries.length > 0) {
      const times = entries.map((e) => e.submittedAt);
      coveredRange = { fromMs: Math.min(...times), toMs: Math.max(...times) };
    }

    const report: ReconciliationReport = {
      runAt,
      coveredRange,
      totalChecked: entries.length,
      cleanCount,
      discrepancyCount,
      notFoundCount,
      summary: discrepancies.length === 0 ? "clean" : "discrepancies_found",
      discrepancies,
    };

    this.lastReport = report;
    this.runCount += 1;
    this.onReport?.(report);
    return report;
  }

  /** Start scheduled reconciliation. Safe to call multiple times — only one timer runs. */
  start(): void {
    if (this.timer !== null || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.reconcile().catch(() => {
        // errors surfaced via onReport discrepancies; swallow here to keep timer alive
      });
    }, this.intervalMs);
  }

  /** Stop the scheduled timer. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLastReport(): ReconciliationReport | null {
    return this.lastReport;
  }

  getRunCount(): number {
    return this.runCount;
  }

  /**
   * Verify restored ledger entries against chain on boot. Removes entries
   * whose jobs are not found on-chain (stale after reorg or contract
   * migration) and surfaces fee/status discrepancies. Returns a
   * reconciliation report summarising the check.
   */
  async verifyOnBoot(): Promise<ReconciliationReport> {
    await this.ledger.hydrate();
    const report = await this.reconcile();
    for (const d of report.discrepancies) {
      if (d.outcome === "not_found") {
        this.ledger.remove(d.jobId);
        log.warn("removed stale ledger entry", { jobId: d.jobId });
      } else if (d.outcome === "discrepancy") {
        log.warn("boot discrepancy", { jobId: d.jobId, detail: d.detail });
      }
    }
    return report;
  }
}
