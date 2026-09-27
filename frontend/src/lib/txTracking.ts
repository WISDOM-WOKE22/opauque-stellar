/**
 * Glue between the pending-tx tracker (#114) and transaction history.
 *
 * Submission sites call `trackSubmission` (or `markPendingTx` /
 * `resolvePendingTx` when they poll confirmation themselves) with the
 * tx hash computed *before* submitting. The entry is persisted, so a
 * reload mid-submission leaves it in `pendingTxStore`; on boot
 * `startPendingTxTracking` re-polls it and mirrors the terminal status
 * onto the matching history row.
 */

import { usePendingTxStore, type PendingTxEntry, type PendingTxStatus } from "../store/pendingTxStore";
import { useTxHistoryStore, type TxHistoryPushInput } from "../store/txHistoryStore";
import { pollPendingTransactions, type TxStatusFetcher } from "./pending-tx-poller";

export interface TrackedTxInput {
  txHash: string;
  cluster: string;
  kind: PendingTxEntry["kind"];
  /** Row to record in history; shown as pending until the tx resolves. */
  history?: TxHistoryPushInput;
}

/** Register an in-flight tx and (optionally) its pending history row. */
export function markPendingTx(input: TrackedTxInput): void {
  const { history, ...entry } = input;
  usePendingTxStore.getState().add({ ...entry, history });
  if (history) {
    useTxHistoryStore.getState().push({ ...history, txHash: input.txHash, chainStatus: "pending" });
  }
}

export function resolvePendingTx(txHash: string, status: Exclude<PendingTxStatus, "pending">, message?: string): void {
  usePendingTxStore.getState().setStatus(txHash, status, message);
}

/**
 * Horizon answers 400 when it rejected the tx outright (it never reached a
 * ledger). Anything else (timeouts, 5xx, network errors) leaves the outcome
 * unknown, so the entry stays pending for the poller to resolve.
 */
function isDefinitiveRejection(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 400;
}

/** Wrap a submit call that resolves once the tx is included on chain. */
export async function trackSubmission<T>(input: TrackedTxInput, submit: () => Promise<T>): Promise<T> {
  markPendingTx(input);
  try {
    const result = await submit();
    resolvePendingTx(input.txHash, "confirmed");
    return result;
  } catch (err) {
    if (isDefinitiveRejection(err)) {
      resolvePendingTx(input.txHash, "failed", "Rejected by the network");
    }
    throw err;
  }
}

/** Mirror one pending entry's terminal status onto transaction history. */
function syncEntryToHistory(entry: PendingTxEntry): void {
  const history = useTxHistoryStore.getState();
  if (entry.status === "confirmed" || entry.status === "failed") {
    if (entry.history) {
      // No-op when the row already exists (dedup by tx hash).
      history.push({ ...entry.history, txHash: entry.txHash, chainStatus: entry.status });
    }
    history.setChainStatus(entry.txHash, entry.status);
  }
  // `timed_out` leaves the row pending: the outcome is unknown and the
  // next history reconciliation settles it from chain.
}

function whenHistoryHydrated(run: () => void): () => void {
  const persistApi = useTxHistoryStore.persist;
  if (!persistApi || persistApi.hasHydrated()) {
    run();
    return () => {};
  }
  return persistApi.onFinishHydration(() => run());
}

export interface PendingTxTrackingOptions {
  fetchStatus: TxStatusFetcher;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Start the poller and keep history in sync with resolved entries.
 * Returns a cancel function for effect cleanup.
 */
export function startPendingTxTracking(opts: PendingTxTrackingOptions): () => void {
  let stopPolling: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let cancelled = false;

  const cancelHydrationWait = whenHistoryHydrated(() => {
    if (cancelled) return;
    // Entries that resolved in an earlier session but were never mirrored.
    for (const entry of Object.values(usePendingTxStore.getState().byHash)) {
      syncEntryToHistory(entry);
    }
    unsubscribe = usePendingTxStore.subscribe((state, prev) => {
      for (const entry of Object.values(state.byHash)) {
        if (prev.byHash[entry.txHash]?.status !== entry.status) syncEntryToHistory(entry);
      }
    });
    stopPolling = pollPendingTransactions(opts);
  });

  return () => {
    cancelled = true;
    cancelHydrationWait();
    unsubscribe?.();
    stopPolling?.();
  };
}
