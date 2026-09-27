/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("../lib/stellar", () => ({
  getHorizonServer: () => ({
    loadAccount: vi.fn().mockResolvedValue({
      balances: [{ asset_type: "native", balance: "12.5000000" }],
    }),
  }),
}));

vi.mock("../lib/encryptedStorage", () => ({
  createEncryptedStorage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
}));

vi.mock("../contracts/contract-config", () => ({
  isClusterSupported: () => false,
}));

vi.mock("../contracts/poolConfig", () => ({
  getPoolConfig: () => ({ poolId: "POOL" }),
}));

import { DashboardView } from "../components/DashboardView";
import { useVaultStore } from "../store/vaultStore";
import { usePoolNoteStore } from "../store/poolNoteStore";
import type { PoolNote } from "../lib/poolNotes";

function note(overrides: Partial<PoolNote>): PoolNote {
  return {
    cluster: "testnet",
    poolId: "POOL",
    value: "10000000",
    scope: 0,
    leafIndex: 0,
    nullifier: "1",
    secret: "2",
    commitment: "0x00",
    spent: false,
    createdAt: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  useVaultStore.setState({ entries: [] });
  usePoolNoteStore.setState({ notes: [] });
});

describe("DashboardView balance summary", () => {
  it("shows wallet, stealth and pool balances", async () => {
    useVaultStore.setState({
      entries: [
        {
          stealthAddress: "0xa",
          ephemeralPubKeyHex: "0x",
          blockNumber: 1n,
          txHash: "0x1",
          amountStroops: 30_000_000n,
          isSpent: false,
        },
        {
          stealthAddress: "0xb",
          ephemeralPubKeyHex: "0x",
          blockNumber: 2n,
          txHash: "0x2",
          amountStroops: 99_000_000n,
          isSpent: true,
        },
      ],
    });
    usePoolNoteStore.setState({
      notes: [
        note({ leafIndex: 0, value: "20000000" }),
        note({ leafIndex: 1, value: "50000000", spent: true }),
        note({ leafIndex: 2, value: "70000000", cluster: "mainnet" }),
        note({ leafIndex: 3, value: "80000000", poolId: "OTHER" }),
      ],
    });

    render(<DashboardView onNavigate={() => {}} address="GABC" cluster="testnet" />);

    expect(await screen.findByText("12.5 XLM")).toBeDefined();
    expect(screen.getByText("3 XLM")).toBeDefined();
    expect(screen.getByText(/1 address · as of last scan/)).toBeDefined();
    expect(screen.getByText("2 XLM")).toBeDefined();
    expect(screen.getByText("1 unspent note")).toBeDefined();
  });

  it("describes Send as limited to registered addresses or meta-addresses", () => {
    render(<DashboardView onNavigate={() => {}} cluster="testnet" />);
    expect(screen.getByText("Send XLM to a registered address or meta-address")).toBeDefined();
    expect(screen.queryByText("Send XLM to any Stellar address")).toBeNull();
  });
});
