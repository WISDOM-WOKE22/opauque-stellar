// @ts-nocheck
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { RelayerChainAdapter, OnChainJob, OnChainRelayer } from "../engine.ts";
import type { PoolWithdrawPayload } from "../shared/payload.ts";

const STATUS: Record<number, OnChainJob["status"]> = {
  0: "open",
  1: "accepted",
  2: "submitted",
  3: "slashed",
  4: "canceled",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StellarRelayerConfig {
  rpcUrl: string;
  networkPassphrase: string;
  registryId: string;
  operator: Keypair;
}

function bytesArg(bytes: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

function jobStatus(n: number): OnChainJob["status"] {
  return STATUS[n] ?? "canceled";
}

export class StellarRelayerChain implements RelayerChainAdapter {
  private server: rpc.Server;

  constructor(private cfg: StellarRelayerConfig) {
    this.server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  }

  private source(): string {
    return this.cfg.operator.publicKey();
  }

  private async simulate(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal | null> {
    const account = await this.server.getAccount(this.source());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
    return sim.result.retval;
  }

  private async invoke(contractId: string, method: string, args: xdr.ScVal[]): Promise<string> {
    const account = await this.server.getAccount(this.source());
    let tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(180)
      .build();
    tx = await this.server.prepareTransaction(tx);
    tx.sign(this.cfg.operator);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
    }
    for (let i = 0; i < 60; i += 1) {
      await sleep(1000);
      const result = await this.server.getTransaction(sent.hash);
      if (result.status === "SUCCESS") return sent.hash;
      if (result.status === "FAILED") throw new Error(`${method} failed: ${sent.hash}`);
    }
    throw new Error(`${method} not confirmed: ${sent.hash}`);
  }

  async getJob(jobId: string): Promise<OnChainJob | null> {
    const retval = await this.simulate(this.cfg.registryId, "get_job", [bytesArg(Buffer.from(jobId.replace(/^0x/, ""), "hex"))]);
    if (!retval) return null;
    const native = scValToNative(retval);
    return {
      exists: true,
      status: jobStatus(Number(native.status)),
      fee: BigInt(native.fee),
      deadline: Number(native.deadline_ledger),
      payloadHash: `0x${Buffer.from(native.payload_hash).toString("hex")}`,
    };
  }

  async getRelayer(operator: string): Promise<OnChainRelayer | null> {
    const retval = await this.simulate(this.cfg.registryId, "get_relayer", [
      nativeToScVal(operator, { type: "address" }),
    ]);
    if (!retval) return null;
    const native = scValToNative(retval);
    return {
      registered: true,
      x25519Pk: `0x${Buffer.from(native.x25519_pubkey).toString("hex")}`,
      endpoint: native.endpoint ?? "",
      freeStake: BigInt(native.free_stake),
    };
  }

  /**
   * Latest finalized ledger, used to measure remaining deadline headroom before
   * bidding (#974). Job deadlines are ledger numbers, so this is the only way to
   * tell whether a job still has time to be accepted and submitted.
   */
  async latestLedger(): Promise<number> {
    const latest = await this.server.getLatestLedger();
    return Number(latest.sequence);
  }

  async simulatePoolWithdraw(payload: PoolWithdrawPayload): Promise<void> {
    const retval = await this.simulate(payload.poolId, "withdraw", poolWithdrawArgs(payload));
    if (!retval) {
      throw new Error("privacy-pool.withdraw simulation failed.");
    }
  }

  async acceptJob(jobId: string): Promise<string> {
    return this.invoke(this.cfg.registryId, "accept_job", [
      nativeToScVal(this.source(), { type: "address" }),
      bytesArg(Buffer.from(jobId.replace(/^0x/, ""), "hex")),
    ]);
  }

  async submitPoolWithdraw(jobId: string, payload: PoolWithdrawPayload): Promise<string> {
    return this.invoke(this.cfg.registryId, "submit_pool_withdraw", [
      nativeToScVal(this.source(), { type: "address" }),
      bytesArg(Buffer.from(jobId.replace(/^0x/, ""), "hex")),
      ...poolWithdrawArgs(payload),
    ]);
  }
}

export function poolWithdrawArgs(payload: PoolWithdrawPayload): xdr.ScVal[] {
  return [
    bytesArg(payload.proofA),
    bytesArg(payload.proofB),
    bytesArg(payload.proofC),
    nativeToScVal(payload.withdrawnValue, { type: "i128" }),
    bytesArg(payload.stateRoot),
    bytesArg(payload.aspRoot),
    bytesArg(payload.nullifierHash),
    bytesArg(payload.newCommitment),
    new Address(payload.recipient).toScVal(),
    nativeToScVal(payload.poolFee, { type: "i128" }),
    new Address(payload.poolRelayer).toScVal(),
  ];
}
