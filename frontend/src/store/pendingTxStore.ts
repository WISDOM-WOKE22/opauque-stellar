/**
 * Pending transaction tracker (#114).
 *
 * Persists the in-flight transactions a user has just submitted so a
 * mid-submission reload doesn't drop the status. On boot, the
 * companion `pending-tx-poller.ts` reads this store and re-polls
 * Horizon until each entry resolves to `confirmed` / `failed` /
 * `timed_out`.
 *
 * Storage rules:
 *   - `pending` entries survive reloads (persisted under
 *     `opaque-pending-tx`).
 *   - `confirmed` / `failed` / `timed_out` are cleared after 60s so
 *     the store doesn't grow unbounded; the UI rendering is owned
 *     by `txHistoryStore` once an entry resolves.
 *   - Submitting the same tx hash twice is a no-op (duplicate-submit
 *     guard from the issue's acceptance criteria).
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { TxHistoryPushInput } from "./txHistoryStore";

export type PendingTxStatus = "pending" | "confirmed" | "failed" | "timed_out";

export interface PendingTxEntry {
  txHash: string;
  cluster: string;
  kind: "send" | "withdraw" | "trait" | "vault";
  submittedAt: number;
  status: PendingTxStatus;
  /** Last status message from the poller / RPC (kept short). */
  message?: string;
  /** When the entry first reached a terminal status (drives cleanup). */
  resolvedAt?: number;
  /**
   * History row to record for this tx. Persisted with the entry so a reload
   * between submit and confirmation still lands the row in history.
   */
  history?: TxHistoryPushInput;
}

function isTerminalStatus(status: PendingTxStatus): boolean {
  return status === "confirmed" || status === "failed" || status === "timed_out";
}

const STORAGE_KEY = "opaque-pending-tx";
const TERMINAL_CLEANUP_MS = 60_000;

interface PendingTxState {
  byHash: Record<string, PendingTxEntry>;
  add: (entry: Omit<PendingTxEntry, "status" | "submittedAt">) => boolean;
  setStatus: (txHash: string, status: PendingTxStatus, message?: string) => void;
  remove: (txHash: string) => void;
  list: (cluster?: string) => PendingTxEntry[];
  prune: (nowMs?: number) => void;
}

/**
 * Returns a usable Storage or null. Guards against environments where
 * `localStorage` is absent (SSR) or non-functional (e.g. Node's experimental
 * localStorage without a backing file), so persistence degrades gracefully
 * to an in-memory store instead of throwing.
 */
function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    if (typeof localStorage.setItem !== "function") return null;
    return localStorage;
  } catch {
    return null;
  }
}

const storage = createJSONStorage<PendingTxState>(() => ({
  getItem: (name) => getSafeLocalStorage()?.getItem(name) ?? null,
  setItem: (name, v) => {
    getSafeLocalStorage()?.setItem(name, v);
  },
  removeItem: (name) => {
    getSafeLocalStorage()?.removeItem(name);
  },
}));

export const usePendingTxStore = create<PendingTxState>()(
  persist(
    (set, get) => ({
      byHash: {},

      add: (entry) => {
        const existing = get().byHash[entry.txHash];
        if (existing) return false; // duplicate-submit guard (#114)
        const full: PendingTxEntry = {
          ...entry,
          status: "pending",
          submittedAt: Date.now(),
        };
        set((state) => ({ byHash: { ...state.byHash, [entry.txHash]: full } }));
        return true;
      },

      setStatus: (txHash, status, message) =>
        set((state) => {
          const prev = state.byHash[txHash];
          if (!prev) return state;
          const resolvedAt = isTerminalStatus(status)
            ? prev.resolvedAt ?? Date.now()
            : undefined;
          return {
            byHash: {
              ...state.byHash,
              [txHash]: { ...prev, status, message, resolvedAt },
            },
          };
        }),

      remove: (txHash) =>
        set((state) => {
          const { [txHash]: _omitted, ...rest } = state.byHash;
          return { byHash: rest };
        }),

      list: (cluster) => {
        const all = Object.values(get().byHash);
        return cluster ? all.filter((e) => e.cluster === cluster) : all;
      },

      prune: (nowMs = Date.now()) =>
        set((state) => {
          const next: Record<string, PendingTxEntry> = {};
          for (const [hash, entry] of Object.entries(state.byHash)) {
            const terminal = isTerminalStatus(entry.status);
            const since = entry.resolvedAt ?? entry.submittedAt;
            if (terminal && nowMs - since > TERMINAL_CLEANUP_MS) continue;
            next[hash] = entry;
          }
          return { byHash: next };
        }),
    }),
    { name: STORAGE_KEY, storage },
  ),
);
