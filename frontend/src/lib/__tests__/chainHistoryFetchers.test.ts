/**
 * Horizon wiring for history reconciliation / pending-tx polling (#113, #114).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const horizon = vi.hoisted(() => ({
  txCall: vi.fn(),
  paymentsByAccount: {} as Record<string, unknown[] | Error>,
}));

vi.mock("../stellar", () => ({
  getHorizonServer: () => ({
    transactions: () => ({ transaction: () => ({ call: horizon.txCall }) }),
    payments: () => {
      let account = "";
      const builder = {
        forAccount: (a: string) => ((account = a), builder),
        includeFailed: () => builder,
        order: () => builder,
        limit: () => builder,
        call: async () => {
          const r = horizon.paymentsByAccount[account];
          if (r instanceof Error) throw r;
          return { records: r ?? [] };
        },
      };
      return builder;
    },
  }),
}));

import {
  createHorizonHistoryFetcher,
  horizonTxStatusFetcher,
  paymentToHistoryItem,
  xlmToStroops,
} from "../chainHistoryFetchers";

const WALLET = "GWALLET000000000000000000000000000000000000000000000001";
const GHOST = "GGHOST0000000000000000000000000000000000000000000000002";
const OTHER = "GOTHER0000000000000000000000000000000000000000000000003";

function notFound(): Error {
  return Object.assign(new Error("Not Found"), { response: { status: 404 } });
}

beforeEach(() => {
  horizon.txCall.mockReset();
  horizon.paymentsByAccount = {};
});

describe("xlmToStroops", () => {
  it("converts Horizon decimal amounts", () => {
    expect(xlmToStroops("12.5000000")).toBe("125000000");
    expect(xlmToStroops("0.0000001")).toBe("1");
    expect(xlmToStroops("3")).toBe("30000000");
  });
});

describe("paymentToHistoryItem", () => {
  const base = {
    transaction_hash: "h1",
    created_at: "2026-01-01T00:00:00Z",
    transaction_successful: true,
  };

  it("classifies sent / received / ghost withdrawals", () => {
    const ghosts = new Set([GHOST]);
    const sent = paymentToHistoryItem(
      { ...base, type: "create_account", funder: WALLET, account: OTHER, starting_balance: "2.0000000" },
      WALLET,
      ghosts,
      "testnet",
    );
    expect(sent).toMatchObject({ kind: "sent", amountStroops: "20000000", status: "confirmed" });

    const received = paymentToHistoryItem(
      { ...base, type: "payment", asset_type: "native", from: OTHER, to: WALLET, amount: "1.0000000" },
      WALLET,
      ghosts,
      "testnet",
    );
    expect(received?.kind).toBe("received");

    const withdrawal = paymentToHistoryItem(
      { ...base, type: "payment", asset_type: "native", from: GHOST, to: OTHER, amount: "1.0000000" },
      GHOST,
      ghosts,
      "testnet",
    );
    expect(withdrawal).toMatchObject({ kind: "ghost", stealthAddress: GHOST });
  });

  it("marks failed transactions and skips non-native assets", () => {
    const failed = paymentToHistoryItem(
      { ...base, transaction_successful: false, type: "payment", asset_type: "native", from: WALLET, to: OTHER, amount: "1" },
      WALLET,
      new Set(),
      "testnet",
    );
    expect(failed?.status).toBe("failed");
    expect(
      paymentToHistoryItem(
        { ...base, type: "payment", asset_type: "credit_alphanum4", from: WALLET, to: OTHER, amount: "1" },
        WALLET,
        new Set(),
        "testnet",
      ),
    ).toBeNull();
  });
});

describe("createHorizonHistoryFetcher", () => {
  it("queries the wallet and ghost addresses and tolerates unfunded accounts", async () => {
    horizon.paymentsByAccount[WALLET] = [
      {
        type: "payment",
        asset_type: "native",
        from: WALLET,
        to: OTHER,
        amount: "1.0000000",
        transaction_hash: "w1",
        transaction_successful: true,
        created_at: "2026-01-02T00:00:00Z",
      },
    ];
    horizon.paymentsByAccount[GHOST] = notFound();
    const items = await createHorizonHistoryFetcher(WALLET)({
      cluster: "testnet",
      ghostAddresses: [GHOST],
    });
    expect(items.map((i) => i.txHash)).toEqual(["w1"]);
  });

  it("propagates non-404 errors", async () => {
    horizon.paymentsByAccount[WALLET] = new Error("boom");
    await expect(
      createHorizonHistoryFetcher(WALLET)({ cluster: "testnet", ghostAddresses: [] }),
    ).rejects.toThrow("boom");
  });
});

describe("horizonTxStatusFetcher", () => {
  it("maps Horizon responses to poller states", async () => {
    horizon.txCall.mockResolvedValueOnce({ successful: true });
    await expect(horizonTxStatusFetcher("h")).resolves.toEqual({ state: "confirmed" });
    horizon.txCall.mockResolvedValueOnce({ successful: false });
    await expect(horizonTxStatusFetcher("h")).resolves.toMatchObject({ state: "failed" });
    horizon.txCall.mockRejectedValueOnce(notFound());
    await expect(horizonTxStatusFetcher("h")).resolves.toEqual({ state: "notFound" });
    horizon.txCall.mockRejectedValueOnce(new Error("network"));
    await expect(horizonTxStatusFetcher("h")).rejects.toThrow("network");
  });
});
