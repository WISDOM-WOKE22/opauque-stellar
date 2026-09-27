/**
 * Production chain wiring for history reconciliation (#113) and the
 * pending-transaction poller (#114).
 *
 * Both modules take their network side by injection; this file supplies
 * the Horizon-backed implementations the app actually runs with.
 */

import type { ChainHistoryFetcher, ChainHistoryItem } from "./history-reconciliation";
import type { ChainStatusResult, TxStatusFetcher } from "./pending-tx-poller";
import { getHorizonServer } from "./stellar";
import { formatXlm } from "./stealth";

const HISTORY_PAGE_LIMIT = 50;
const STROOPS_PER_XLM = 10_000_000n;

function isNotFound(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { name?: string; response?: { status?: number } };
  return e.name === "NotFoundError" || e.response?.status === 404;
}

/** Horizon `/transactions/<hash>`: 404 means "not indexed yet", keep polling. */
export const horizonTxStatusFetcher: TxStatusFetcher = async (txHash) => {
  try {
    const record = await getHorizonServer().transactions().transaction(txHash).call();
    return record.successful
      ? ({ state: "confirmed" } as ChainStatusResult)
      : ({ state: "failed", message: "Transaction failed on chain" } as ChainStatusResult);
  } catch (err) {
    if (isNotFound(err)) return { state: "notFound" };
    throw err;
  }
};

/** Horizon decimal XLM ("12.5000000") → stroops string. */
export function xlmToStroops(amount: string): string {
  const [whole = "0", frac = ""] = amount.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return (BigInt(whole) * STROOPS_PER_XLM + BigInt(fracPadded || "0")).toString();
}

type HorizonPaymentRecord = {
  type: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  created_at: string;
  asset_type?: string;
  amount?: string;
  starting_balance?: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
};

/**
 * Map one Horizon payment-like operation to a history item from the point
 * of view of `owner`. Returns null for operations the history view does not
 * represent (non-native assets, unrelated op types).
 */
export function paymentToHistoryItem(
  op: HorizonPaymentRecord,
  owner: string,
  ghostAddresses: ReadonlySet<string>,
  cluster: string,
): ChainHistoryItem | null {
  let from: string | undefined;
  let to: string | undefined;
  let amount: string | undefined;
  if (op.type === "payment") {
    if (op.asset_type !== "native") return null;
    from = op.from;
    to = op.to;
    amount = op.amount;
  } else if (op.type === "create_account") {
    from = op.funder;
    to = op.account;
    amount = op.starting_balance;
  } else {
    return null;
  }
  if (!from || !to || amount == null) return null;

  let kind: ChainHistoryItem["kind"];
  let counterparty: string;
  if (from === owner) {
    // Withdrawals out of a ghost/stealth address are the "Manual" rows.
    kind = ghostAddresses.has(owner) ? "ghost" : "sent";
    counterparty = to;
  } else if (to === owner) {
    kind = "received";
    counterparty = from;
  } else {
    return null;
  }

  const amountStroops = xlmToStroops(amount);
  const timestamp = Date.parse(op.created_at);
  return {
    txHash: op.transaction_hash,
    cluster,
    kind,
    counterparty: `${counterparty.slice(0, 6)}…${counterparty.slice(-4)}`,
    amountStroops,
    amount: formatXlm(BigInt(amountStroops)),
    tokenSymbol: "XLM",
    tokenAddress: null,
    stealthAddress: ghostAddresses.has(owner) ? owner : undefined,
    timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
    status: op.transaction_successful === false ? "failed" : "confirmed",
  };
}

/**
 * Rebuild history from Horizon: the latest native payments / account
 * creations touching the wallet and every known ghost address
 * (`ghostAddresses` holds stealth G-addresses). A transfer between two owned
 * addresses appears once per side; `reconcileHistory` dedupes it by hash.
 */
export function createHorizonHistoryFetcher(walletAddress: string | null): ChainHistoryFetcher {
  return async ({ cluster, ghostAddresses, since }) => {
    const horizon = getHorizonServer();
    const ghosts = new Set(ghostAddresses.filter((a) => a !== walletAddress));
    const owners = Array.from(new Set([...(walletAddress ? [walletAddress] : []), ...ghosts]));

    const perOwner = await Promise.all(
      owners.map(async (owner) => {
        try {
          const page = await horizon
            .payments()
            .forAccount(owner)
            .includeFailed(true)
            .order("desc")
            .limit(HISTORY_PAGE_LIMIT)
            .call();
          return (page.records as unknown as HorizonPaymentRecord[])
            .map((op) => paymentToHistoryItem(op, owner, ghosts, cluster))
            .filter((i): i is ChainHistoryItem => i != null);
        } catch (err) {
          // Unfunded accounts 404; nothing to reconcile for them.
          if (isNotFound(err)) return [];
          throw err;
        }
      }),
    );

    const items = perOwner.flat();
    return since == null ? items : items.filter((i) => i.timestamp >= since);
  };
}
