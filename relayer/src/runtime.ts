/**
 * Production relayer wiring (issue #973).
 *
 * `JobLedger`, `PayoutReconciler`, and the hub-facing `heartbeat` / `outcome`
 * messages were all implemented and unit-tested, but `scripts/relayer.ts` never
 * constructed them: the engine ran with no `jobLedger`, no reconciler was ever
 * started (so `GET/POST /v1/reconcile` stayed 404 behind its "reconciler not
 * configured" guard), and nothing ever published a heartbeat or an outcome — so
 * the hub's `isNodeAlive` and completion-rate scoring had no data from a real
 * relayer.
 *
 * This module is the single place that wiring lives, so the entrypoint and the
 * integration test exercise exactly the same code path.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { RelayerEngine, type RelayerChainAdapter, type SubmitRetryPolicy } from "./engine.ts";
import { attachRelayerEngineToGossip } from "./hub.ts";
import type { GossipTransport } from "./gossip.ts";
import { JobLedger, PayoutReconciler } from "./reconciler.ts";
import { AcceptedJobQueue } from "./job-queue.ts";
import type { AcceptedJobStore, LedgerStore } from "./store.ts";
import { createLogger, type Logger } from "./logger.ts";

/** Default gap between scheduled reconciliation runs (5 minutes). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Default heartbeat period. Must stay comfortably under the hub's
 * `HEARTBEAT_MISS_THRESHOLD_MS` (45s) or a live node looks dead and its jobs
 * get reassigned.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;

export interface RelayerNodeOptions {
  operator: Keypair;
  x25519PublicKey: Uint8Array;
  x25519SecretKey: Uint8Array;
  endpoint?: string;
  minFee: bigint;
  chain: RelayerChainAdapter;
  transport: GossipTransport;
  /** Where accepted jobs are recorded. Omit for an in-memory ledger. */
  ledgerStore?: LedgerStore;
  /** Where accepted-but-unsubmitted jobs are recorded so a restart can resume (#975). */
  acceptedJobStore?: AcceptedJobStore;
  /** Submit retry policy for the accept-then-submit sequence (#975). */
  submitRetry?: SubmitRetryPolicy;
  /** 0 disables scheduled reconciliation (the boot check still runs). */
  reconcileIntervalMs?: number;
  /** 0 disables the heartbeat timer (one heartbeat is still published). */
  heartbeatIntervalMs?: number;
  deadlineMarginLedgers?: number;
  log?: Logger;
}

export interface RelayerNode {
  engine: RelayerEngine;
  ledger: JobLedger;
  reconciler: PayoutReconciler;
  acceptedJobs: AcceptedJobQueue;
  /** Publish one heartbeat immediately. Also runs on the heartbeat timer. */
  publishHeartbeat(): Promise<void>;
  /** Stop the heartbeat timer, the reconciler, and the engine's prune watch. */
  stop(): Promise<void>;
}

/**
 * Wire a relayer engine to its ledger, reconciler, and the gossip hub. Resolves
 * once the ledger is hydrated, the boot reconciliation has run, and the first
 * heartbeat has been published.
 */
export async function startRelayerNode(opts: RelayerNodeOptions): Promise<RelayerNode> {
  const log = opts.log ?? createLogger("relayer");
  const operator = opts.operator.publicKey();

  // Accepted jobs are recorded here so a reconciliation run can compare them
  // against on-chain state; the reconciler is what turns a silent divergence
  // (wrong fee, unexpected status) into a report an operator can act on.
  const ledger = new JobLedger(opts.ledgerStore);
  await ledger.hydrate();
  if (ledger.size() > 0) {
    log.info("job ledger hydrated", { entries: ledger.size() });
  }

  // Accepted-but-unsubmitted jobs from a previous run (#975). Hydrated here so the
  // engine can finish them below before this node starts accepting new work.
  const acceptedJobs = new AcceptedJobQueue(opts.acceptedJobStore);
  await acceptedJobs.hydrate();
  if (acceptedJobs.size() > 0) {
    log.info("accepted jobs recovered from disk", { pending: acceptedJobs.size() });
  }

  const engine = new RelayerEngine({
    operator: opts.operator,
    x25519PublicKey: opts.x25519PublicKey,
    x25519SecretKey: opts.x25519SecretKey,
    endpoint: opts.endpoint,
    minFee: opts.minFee,
    chain: opts.chain,
    jobLedger: ledger,
    deadlineMarginLedgers: opts.deadlineMarginLedgers,
    acceptedJobs,
    submitRetry: opts.submitRetry,
    // The hub scores completion rate from outcomes it receives over gossip, so
    // a settled job has to be reported or the operator stays unscored forever.
    onSettled: async (jobId, result) => {
      await opts.transport.publish({ t: "outcome", v: 1, jobId, operator, result });
    },
  });

  const reconciler = new PayoutReconciler({
    chain: opts.chain,
    ledger,
    intervalMs: opts.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    onReport: (report) => {
      if (report.summary === "clean") {
        log.debug("reconciliation clean", {
          checked: report.totalChecked,
          coveredRange: report.coveredRange,
        });
        return;
      }
      log.warn("reconciliation found discrepancies", {
        checked: report.totalChecked,
        discrepancies: report.discrepancyCount,
        notFound: report.notFoundCount,
      });
    },
  });

  // Finish any job that was accepted but not submitted before this process died
  // (#975). A crash between accept_job and submit_pool_withdraw would otherwise
  // leave a bonded job nobody submits, ending in a slash.
  const resumed = await engine.resumeAcceptedJobs();
  if (resumed.submitted.length > 0 || resumed.abandoned.length > 0 || resumed.failed.length > 0) {
    log.info("accepted-job recovery complete", {
      submitted: resumed.submitted.length,
      abandoned: resumed.abandoned.length,
      failed: resumed.failed.length,
    });
  }

  // Verify restored entries against the chain before serving: entries whose jobs
  // are gone (reorg, contract migration) are dropped, real fee/status mismatches
  // are surfaced.
  const boot = await reconciler.verifyOnBoot();
  if (boot.totalChecked > 0) {
    log.info("boot reconciliation complete", {
      checked: boot.totalChecked,
      clean: boot.cleanCount,
      discrepancies: boot.discrepancyCount,
      notFound: boot.notFoundCount,
    });
  }
  reconciler.start();

  await attachRelayerEngineToGossip(engine, opts.transport);

  const publishHeartbeat = async (): Promise<void> => {
    await opts.transport.publish({ t: "heartbeat", v: 1, operator });
  };

  // Publish once up front so the hub sees the node as alive immediately rather
  // than after a full heartbeat period.
  await publishHeartbeat();

  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          publishHeartbeat().catch((err) => {
            log.warn("heartbeat publish failed", { error: err });
          });
        }, heartbeatIntervalMs)
      : null;

  return {
    engine,
    ledger,
    reconciler,
    acceptedJobs,
    publishHeartbeat,
    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reconciler.stop();
      engine.stopPruneWatch();
    },
  };
}
