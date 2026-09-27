/**
 * @vitest-environment jsdom
 *
 * Integration: history reconciliation (#113) and pending-tx recovery (#114)
 * driven through the History view, with only the chain side mocked.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { ChainHistoryItem } from "../lib/history-reconciliation";

const WALLET = "GWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const chainItems = vi.hoisted(() => ({ current: [] as ChainHistoryItem[] | Error }));
const fetchCalls = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("../hooks/useWallet", () => ({
  useWallet: () => ({ cluster: "testnet", address: WALLET }),
}));

vi.mock("../lib/encryptedStorage", () => ({
  createEncryptedStorage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
}));

vi.mock("../lib/chainHistoryFetchers", () => ({
  createHorizonHistoryFetcher: () => async (input: unknown) => {
    fetchCalls.current.push(input);
    if (chainItems.current instanceof Error) throw chainItems.current;
    return chainItems.current;
  },
  horizonTxStatusFetcher: vi.fn(),
}));

import { TransactionHistoryView } from "../components/TransactionHistoryView";
import { useTxHistoryStore } from "../store/txHistoryStore";
import { usePendingTxStore } from "../store/pendingTxStore";
import { resetHistoryReconciliationState } from "../hooks/useHistoryReconciliation";
import { startPendingTxTracking, trackSubmission } from "../lib/txTracking";
import type { ChainStatusResult } from "../lib/pending-tx-poller";

function chainItem(overrides: Partial<ChainHistoryItem>): ChainHistoryItem {
  return {
    txHash: "h",
    cluster: "testnet",
    kind: "received",
    counterparty: "GSENDE…ABCD",
    amountStroops: "10000000",
    amount: "1",
    tokenSymbol: "XLM",
    tokenAddress: null,
    timestamp: 1_700_000_000_000,
    status: "confirmed",
    ...overrides,
  };
}

function rowFor(hash: string): HTMLElement {
  const link = screen.getByTitle(hash);
  return link.closest("li") as HTMLElement;
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

beforeEach(() => {
  // Node's built-in localStorage stub shadows jsdom's and is non-functional.
  vi.stubGlobal("localStorage", memoryStorage());
  chainItems.current = [];
  fetchCalls.current = [];
  resetHistoryReconciliationState();
  useTxHistoryStore.setState({ byChain: {} });
  usePendingTxStore.setState({ byHash: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("History view ↔ chain reconciliation (#113)", () => {
  it("rebuilds history from chain on a fresh device, including failed txs", async () => {
    chainItems.current = [
      chainItem({ txHash: "aaa1", amount: "2.5", timestamp: 1_700_000_002_000 }),
      chainItem({ txHash: "bbb2", kind: "sent", status: "failed", timestamp: 1_700_000_001_000 }),
    ];

    render(<TransactionHistoryView />);

    expect(await screen.findByText("Recovered 2 transactions from chain.")).toBeInTheDocument();
    expect(fetchCalls.current).toHaveLength(1);
    expect(rowFor("aaa1")).toHaveTextContent("Confirmed");
    expect(rowFor("aaa1")).toHaveTextContent("2.5 XLM");
    expect(rowFor("bbb2")).toHaveTextContent("Failed");
    // Persisted into the store, so it survives the view unmounting.
    expect(useTxHistoryStore.getState().getForCluster("testnet").map((e) => e.txHash)).toEqual([
      "aaa1",
      "bbb2",
    ]);
  });

  it("does not auto-sync when local history exists; the button merges and dedupes", async () => {
    useTxHistoryStore.getState().push({
      cluster: "testnet",
      kind: "sent",
      counterparty: "GLOCAL…0001",
      amountStroops: "30000000",
      tokenSymbol: "XLM",
      tokenAddress: null,
      amount: "3",
      txHash: "local1",
      chainStatus: "pending",
    });
    useTxHistoryStore.getState().push({
      cluster: "testnet",
      kind: "trait",
      counterparty: "Issuer",
      amountStroops: "0",
      tokenSymbol: "XLM",
      tokenAddress: null,
      amount: "Trait without hash",
    });
    chainItems.current = [
      chainItem({ txHash: "local1", kind: "sent", status: "confirmed" }),
      chainItem({ txHash: "new1" }),
    ];

    render(<TransactionHistoryView />);
    expect(rowFor("local1")).toHaveTextContent("Pending");
    expect(fetchCalls.current).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Sync from chain" }));

    expect(await screen.findByText("Recovered 1 transaction from chain.")).toBeInTheDocument();
    expect(rowFor("local1")).toHaveTextContent("Confirmed");
    // Local metadata wins on the deduped row.
    expect(rowFor("local1")).toHaveTextContent("3 XLM");
    expect(rowFor("new1")).toBeInTheDocument();
    expect(screen.getByText("Trait without hash")).toBeInTheDocument();
    expect(useTxHistoryStore.getState().getForCluster("testnet")).toHaveLength(3);
  });

  it("surfaces chain fetch errors in the view", async () => {
    render(<TransactionHistoryView />);
    await screen.findByText("History is up to date with chain.");

    chainItems.current = new Error("Horizon unreachable");
    fireEvent.click(screen.getByRole("button", { name: "Sync from chain" }));
    expect(await screen.findByText("History sync failed: Horizon unreachable")).toBeInTheDocument();
  });
});

describe("Pending tx recovery through the History view (#114)", () => {
  it("restores a pending tx after reload and resolves it via the poller", async () => {
    // A tx submitted just before the reload: only the persisted pending
    // entry survives (the history row was never written).
    localStorage.setItem(
      "opaque-pending-tx",
      JSON.stringify({
        state: {
          byHash: {
            reload1: {
              txHash: "reload1",
              cluster: "testnet",
              kind: "send",
              submittedAt: Date.now(),
              status: "pending",
              history: {
                cluster: "testnet",
                kind: "sent",
                counterparty: "GSTEAL…WXYZ",
                amountStroops: "50000000",
                tokenSymbol: "XLM",
                tokenAddress: null,
                amount: "5",
                txHash: "reload1",
              },
            },
          },
        },
        version: 0,
      }),
    );
    await usePendingTxStore.persist.rehydrate();
    expect(usePendingTxStore.getState().byHash.reload1?.status).toBe("pending");

    // Seed one history row so the view doesn't auto-reconcile.
    useTxHistoryStore.getState().push({
      cluster: "testnet",
      kind: "received",
      counterparty: "x",
      amountStroops: "1",
      tokenSymbol: "XLM",
      tokenAddress: null,
      amount: "0.0000001",
      txHash: "older",
    });

    let answer: ChainStatusResult = { state: "notFound" };
    const fetchStatus = vi.fn(async () => answer);
    render(<TransactionHistoryView />);
    const stop = startPendingTxTracking({ fetchStatus, intervalMs: 10 });

    try {
      await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith("reload1"));
      expect(screen.queryByTitle("reload1")).toBeNull();

      await act(async () => {
        answer = { state: "confirmed" };
      });
      await waitFor(() => expect(rowFor("reload1")).toHaveTextContent("Confirmed"));
      expect(rowFor("reload1")).toHaveTextContent("5 XLM");
      expect(usePendingTxStore.getState().byHash.reload1?.status).toBe("confirmed");
    } finally {
      stop();
      localStorage.removeItem("opaque-pending-tx");
    }
  });

  it("shows a submitted tx as pending, then failed when the network rejects it", async () => {
    render(<TransactionHistoryView />);
    await screen.findByText("History is up to date with chain.");
    const stop = startPendingTxTracking({ fetchStatus: async () => ({ state: "notFound" }), intervalMs: 50 });

    let reject!: (e: unknown) => void;
    const submitted = trackSubmission(
      {
        txHash: "sub1",
        cluster: "testnet",
        kind: "send",
        history: {
          cluster: "testnet",
          kind: "sent",
          counterparty: "GSTEAL…0000",
          amountStroops: "10000000",
          tokenSymbol: "XLM",
          tokenAddress: null,
          amount: "1",
          txHash: "sub1",
        },
      },
      () => new Promise((_, r) => (reject = r)),
    );

    try {
      await waitFor(() => expect(rowFor("sub1")).toHaveTextContent("Pending"));
      // Persisted so a reload here would keep it.
      expect(JSON.parse(localStorage.getItem("opaque-pending-tx") ?? "{}").state?.byHash?.sub1?.status).toBe(
        "pending",
      );

      await act(async () => {
        reject({ response: { status: 400 } });
        await submitted.catch(() => {});
      });
      await waitFor(() => expect(rowFor("sub1")).toHaveTextContent("Failed"));
    } finally {
      stop();
      localStorage.removeItem("opaque-pending-tx");
    }
  });
});
