/**
 * Runs chain-derived history reconciliation (#113) against the local store.
 *
 * - `reconcile()` is what the history view's "Sync from chain" button calls.
 * - With `autoOnEmpty`, a fresh device (hydrated, empty local history for
 *   this cluster) reconciles once per cluster + wallet per session.
 *
 * Status lives in a shared store so the view reflects a sync started from
 * app boot.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { reconcileHistory, type ChainHistoryFetcher } from "../lib/history-reconciliation";
import { createHorizonHistoryFetcher } from "../lib/chainHistoryFetchers";
import { useTxHistoryStore, type TxHistoryEntry } from "../store/txHistoryStore";
import { useGhostAddressStore } from "../store/ghostAddressStore";

export type ReconcileStatus = "idle" | "syncing" | "done" | "error";

interface ReconcileState {
  status: ReconcileStatus;
  addedCount: number;
  error: string | null;
}

export const useReconcileStatusStore = create<ReconcileState>()(() => ({
  status: "idle",
  addedCount: 0,
  error: null,
}));

/** Cluster:address keys already auto-reconciled this session. */
const autoAttempted = new Set<string>();

/** Test hook: forget auto-reconcile attempts and reset status. */
export function resetHistoryReconciliationState(): void {
  autoAttempted.clear();
  useReconcileStatusStore.setState({ status: "idle", addedCount: 0, error: null });
}

function subscribeHydration(cb: () => void): () => void {
  return useTxHistoryStore.persist?.onFinishHydration(() => cb()) ?? (() => {});
}

function getHydrated(): boolean {
  return useTxHistoryStore.persist?.hasHydrated() ?? true;
}

export interface UseHistoryReconciliationOptions {
  cluster: string;
  address: string | null | undefined;
  enabled?: boolean;
  autoOnEmpty?: boolean;
  /** Override for tests; defaults to the Horizon fetcher. */
  fetcher?: ChainHistoryFetcher;
}

export function useHistoryReconciliation({
  cluster,
  address,
  enabled = true,
  autoOnEmpty = false,
  fetcher,
}: UseHistoryReconciliationOptions) {
  const hydrated = useSyncExternalStore(subscribeHydration, getHydrated, getHydrated);
  const localCount = useTxHistoryStore((s) => s.byChain[cluster]?.length ?? 0);
  const ghostEntries = useGhostAddressStore((s) => s.entries);
  const ghostAddresses = useMemo(
    () =>
      ghostEntries
        .filter((e) => e.cluster === cluster && !!e.stealthStellarAddress)
        .map((e) => e.stealthStellarAddress!),
    [ghostEntries, cluster],
  );
  const status = useReconcileStatusStore();

  const reconcile = useCallback(async () => {
    if (!address) return;
    if (useReconcileStatusStore.getState().status === "syncing") return;
    useReconcileStatusStore.setState({ status: "syncing", error: null });
    try {
      const chain = await (fetcher ?? createHorizonHistoryFetcher(address))({
        cluster,
        ghostAddresses,
      });
      // Read local after the fetch so rows pushed meanwhile aren't dropped.
      const local = useTxHistoryStore.getState().getForCluster(cluster);
      const result = reconcileHistory(local, chain);
      // reconcileHistory only carries hash-bearing rows; keep the rest.
      const hashless = local.filter((e) => !e.txHash);
      const merged: TxHistoryEntry[] = [...result.entries, ...hashless].sort(
        (a, b) => b.timestamp - a.timestamp,
      );
      useTxHistoryStore.getState().replaceForCluster(cluster, merged);
      useReconcileStatusStore.setState({ status: "done", addedCount: result.addedCount });
    } catch (err) {
      useReconcileStatusStore.setState({
        status: "error",
        error: err instanceof Error ? err.message : "History sync failed",
      });
    }
  }, [address, cluster, ghostAddresses, fetcher]);

  useEffect(() => {
    if (!enabled || !autoOnEmpty || !hydrated || !address || localCount > 0) return;
    const key = `${cluster}:${address}`;
    if (autoAttempted.has(key)) return;
    autoAttempted.add(key);
    void reconcile();
  }, [enabled, autoOnEmpty, hydrated, address, cluster, localCount, reconcile]);

  return { ...status, reconcile, canReconcile: enabled && !!address };
}
