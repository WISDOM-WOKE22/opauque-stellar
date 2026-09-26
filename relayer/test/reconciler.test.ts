import { describe, it, expect, vi, beforeEach } from "vitest";
import { JobLedger, PayoutReconciler, type JobLedgerEntry } from "../src/reconciler.ts";
import type { RelayerChainAdapter, OnChainJob, OnChainRelayer } from "../src/engine.ts";
import type { PoolWithdrawPayload } from "../src/shared/payload.ts";

// ---------------------------------------------------------------------------
// Minimal chain adapter stub
// ---------------------------------------------------------------------------

type JobMap = Map<string, OnChainJob>;

class StubChain implements RelayerChainAdapter {
  constructor(private jobs: JobMap = new Map()) {}

  async getJob(jobId: string): Promise<OnChainJob | null> {
    return this.jobs.get(jobId.toLowerCase()) ?? null;
  }

  async getRelayer(_operator: string): Promise<OnChainRelayer | null> {
    return null;
  }

  async latestLedger(): Promise<number> {
    return 0;
  }

  async simulatePoolWithdraw(_payload: PoolWithdrawPayload): Promise<void> {}
  async acceptJob(_jobId: string): Promise<string> { return "acc-tx"; }
  async submitPoolWithdraw(_jobId: string, _payload: PoolWithdrawPayload): Promise<string> { return "sub-tx"; }
}

function makeEntry(overrides: Partial<JobLedgerEntry> = {}): JobLedgerEntry {
  return {
    jobId: "0xdeadbeef",
    acceptedTx: "acc-tx-1",
    submittedTx: "sub-tx-1",
    expectedFee: 100n,
    submittedAt: Date.now(),
    ...overrides,
  };
}

function makeJob(overrides: Partial<OnChainJob> = {}): OnChainJob {
  return {
    exists: true,
    status: "submitted",
    fee: 100n,
    deadline: 9999,
    payloadHash: "0xabc",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// JobLedger
// ---------------------------------------------------------------------------

describe("JobLedger", () => {
  it("records and retrieves entries", () => {
    const ledger = new JobLedger();
    const entry = makeEntry({ jobId: "0x01" });
    ledger.record(entry);
    expect(ledger.get("0x01")).toEqual(entry);
    expect(ledger.size()).toBe(1);
  });

  it("normalises jobId to lowercase", () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0xABCD" }));
    expect(ledger.get("0xabcd")).toBeDefined();
    expect(ledger.get("0xABCD")).toBeDefined();
  });

  it("returns all entries", () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0x01" }));
    ledger.record(makeEntry({ jobId: "0x02" }));
    expect(ledger.all()).toHaveLength(2);
  });

  it("overwrites duplicate jobId", () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0x01", expectedFee: 50n }));
    ledger.record(makeEntry({ jobId: "0x01", expectedFee: 99n }));
    expect(ledger.size()).toBe(1);
    expect(ledger.get("0x01")?.expectedFee).toBe(99n);
  });
});

// ---------------------------------------------------------------------------
// PayoutReconciler — clean run
// ---------------------------------------------------------------------------

describe("PayoutReconciler.reconcile() — clean run", () => {
  it("returns clean summary when ledger is empty", async () => {
    const ledger = new JobLedger();
    const chain = new StubChain();
    const rec = new PayoutReconciler({ chain, ledger });

    const report = await rec.reconcile();

    expect(report.totalChecked).toBe(0);
    expect(report.cleanCount).toBe(0);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.summary).toBe("clean");
    expect(report.coveredRange).toBeNull();
  });

  it("marks job as clean when fee and status match", async () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0xaaa", expectedFee: 200n }));

    const chain = new StubChain(
      new Map([["0xaaa", makeJob({ fee: 200n, status: "submitted" })]]),
    );
    const rec = new PayoutReconciler({ chain, ledger });

    const report = await rec.reconcile();

    expect(report.cleanCount).toBe(1);
    expect(report.discrepancyCount).toBe(0);
    expect(report.summary).toBe("clean");
    expect(report.discrepancies).toHaveLength(0);
  });

  it("accepts slashed and canceled as clean terminal statuses", async () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0xslash", expectedFee: 10n }));
    ledger.record(makeEntry({ jobId: "0xcancel", expectedFee: 10n }));

    const jobs = new Map<string, OnChainJob>([
      ["0xslash", makeJob({ fee: 10n, status: "slashed" })],
      ["0xcancel", makeJob({ fee: 10n, status: "canceled" })],
    ]);
    const rec = new PayoutReconciler({ chain: new StubChain(jobs), ledger });

    const report = await rec.reconcile();
    expect(report.cleanCount).toBe(2);
    expect(report.discrepancies).toHaveLength(0);
  });

  it("records coveredRange from entry submittedAt timestamps", async () => {
    const ledger = new JobLedger();
    const t1 = 1_000_000;
    const t2 = 2_000_000;
    ledger.record(makeEntry({ jobId: "0x01", submittedAt: t1, expectedFee: 10n }));
    ledger.record(makeEntry({ jobId: "0x02", submittedAt: t2, expectedFee: 10n }));

    const jobs = new Map<string, OnChainJob>([
      ["0x01", makeJob({ fee: 10n })],
      ["0x02", makeJob({ fee: 10n })],
    ]);
    const rec = new PayoutReconciler({ chain: new StubChain(jobs), ledger });

    const report = await rec.reconcile();
    expect(report.coveredRange).toEqual({ fromMs: t1, toMs: t2 });
  });

  it("persists report as lastReport after run", async () => {
    const rec = new PayoutReconciler({ chain: new StubChain(), ledger: new JobLedger() });
    expect(rec.getLastReport()).toBeNull();
    const report = await rec.reconcile();
    expect(rec.getLastReport()).toBe(report);
  });

  it("increments runCount on each reconcile call", async () => {
    const rec = new PayoutReconciler({ chain: new StubChain(), ledger: new JobLedger() });
    expect(rec.getRunCount()).toBe(0);
    await rec.reconcile();
    await rec.reconcile();
    expect(rec.getRunCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PayoutReconciler — discrepancy detection
// ---------------------------------------------------------------------------

describe("PayoutReconciler.reconcile() — discrepancies", () => {
  it("flags fee mismatch as discrepancy", async () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0xfee", expectedFee: 100n }));

    const chain = new StubChain(
      new Map([["0xfee", makeJob({ fee: 50n, status: "submitted" })]]),
    );
    const rec = new PayoutReconciler({ chain, ledger });

    const report = await rec.reconcile();

    expect(report.summary).toBe("discrepancies_found");
    expect(report.discrepancyCount).toBe(1);
    const d = report.discrepancies[0];
    expect(d.outcome).toBe("discrepancy");
    expect(d.detail).toMatch(/fee mismatch/);
    expect(d.expectedFee).toBe("100");
    expect(d.onChainFee).toBe("50");
  });

  it("flags wrong on-chain status as discrepancy", async () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0xstatus", expectedFee: 10n }));

    const chain = new StubChain(
      new Map([["0xstatus", makeJob({ fee: 10n, status: "open" })]]),
    );
    const rec = new PayoutReconciler({ chain, ledger });

    const report = await rec.reconcile();
    expect(report.discrepancyCount).toBe(1);
    expect(report.discrepancies[0].detail).toMatch(/unexpected status/);
  });

  it("flags missing on-chain job as not_found", async () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0xmissing", expectedFee: 10n }));

    const rec = new PayoutReconciler({ chain: new StubChain(), ledger });
    const report = await rec.reconcile();

    expect(report.notFoundCount).toBe(1);
    expect(report.discrepancies[0].outcome).toBe("not_found");
    expect(report.discrepancies[0].detail).toMatch(/not found on-chain/);
  });

  it("handles chain errors gracefully and records job as not_found", async () => {
    const ledger = new JobLedger();
    ledger.record(makeEntry({ jobId: "0xerr", expectedFee: 10n }));

    const faultyChain = new StubChain();
    vi.spyOn(faultyChain, "getJob").mockRejectedValue(new Error("RPC timeout"));

    const rec = new PayoutReconciler({ chain: faultyChain, ledger });
    const report = await rec.reconcile();

    expect(report.notFoundCount).toBe(1);
    expect(report.summary).toBe("discrepancies_found");
  });

  it("invokes onReport callback after each run", async () => {
    const callback = vi.fn();
    const rec = new PayoutReconciler({
      chain: new StubChain(),
      ledger: new JobLedger(),
      onReport: callback,
    });

    await rec.reconcile();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toHaveProperty("summary");
  });
});

// ---------------------------------------------------------------------------
// PayoutReconciler — scheduler
// ---------------------------------------------------------------------------

describe("PayoutReconciler scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not start timer when intervalMs is 0", () => {
    const rec = new PayoutReconciler({
      chain: new StubChain(),
      ledger: new JobLedger(),
      intervalMs: 0,
    });
    rec.start();
    // no timer means no internal state change; stop should be safe
    rec.stop();
  });

  it("fires reconcile on schedule and stops cleanly", async () => {
    const callback = vi.fn();
    const rec = new PayoutReconciler({
      chain: new StubChain(),
      ledger: new JobLedger(),
      intervalMs: 1000,
      onReport: callback,
    });

    rec.start();
    await vi.advanceTimersByTimeAsync(3500);
    rec.stop();

    // 3 full intervals elapsed
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("calling start twice does not create two timers", async () => {
    const callback = vi.fn();
    const rec = new PayoutReconciler({
      chain: new StubChain(),
      ledger: new JobLedger(),
      intervalMs: 1000,
      onReport: callback,
    });

    rec.start();
    rec.start();
    await vi.advanceTimersByTimeAsync(2500);
    rec.stop();

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("stop prevents further scheduled runs", async () => {
    const callback = vi.fn();
    const rec = new PayoutReconciler({
      chain: new StubChain(),
      ledger: new JobLedger(),
      intervalMs: 1000,
      onReport: callback,
    });

    rec.start();
    await vi.advanceTimersByTimeAsync(1500);
    rec.stop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
