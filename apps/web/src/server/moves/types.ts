// The bridge aggregator seen from the app (D-18: one aggregator, LI.FI, behind this interface).
import type { Address, Hex } from "@/shared/types";

/** Any of the six Safe networks (chain ids), not only the ones the rest of the app reads. */
export type MoveChain = number;

export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export type QuoteParams = {
  fromChain: MoveChain;
  toChain: MoveChain;
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  /** The Safe: sender and recipient. */
  address: Address;
  /** Percent as a fraction, 0.005 = 0.5%. */
  slippage?: number;
};

export type AggregatorQuote = {
  id: string;
  tool: string;
  fromChain: MoveChain;
  toChain: MoveChain;
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  toAmount: bigint;
  /** The least the quote guarantees on arrival: price protection (D-13). */
  toAmountMin: bigint;
  fromDecimals: number;
  toDecimals: number;
  fromAddress: Address;
  toAddress: Address;
  /** Null when the route needs no approval (native token). */
  approvalAddress: Address | null;
  durationSec: number;
  /** Bridge fee plus source network fee, in dollars, as quoted. */
  feeUsd: number;
  /** The transaction the Safe would run on the source network. */
  tx: { to: Address; data: Hex; value: bigint; from: Address; chainId: number };
  /** Milliseconds since the epoch: when we asked. */
  quotedAt: number;
};

export type TransferState = "not_found" | "pending" | "done" | "failed";

/** What the aggregator says about one transfer, normalised. `sub` is its sub-status (done: COMPLETED, PARTIAL or REFUNDED). */
export type TransferStatus = {
  state: TransferState;
  sub?: string;
  message?: string;
  /** The destination transaction it names (for a refund: the one that returned the funds). */
  receiving?: { txHash: Hex; chainId: MoveChain; amount: bigint; token: Address | null };
};

export type StatusParams = { txHash: Hex; fromChain: MoveChain; toChain: MoveChain; bridge?: string };

export interface BridgeAggregator {
  /** Null when there is no route for that asset and pair. Throws when the aggregator cannot be reached. */
  quote(p: QuoteParams): Promise<AggregatorQuote | null>;
  status(p: StatusParams): Promise<TransferStatus>;
}

export class AggregatorError extends Error {}

type Wire = Omit<AggregatorQuote, "fromAmount" | "toAmount" | "toAmountMin" | "tx"> & { fromAmount: string; toAmount: string; toAmountMin: string; tx: Omit<AggregatorQuote["tx"], "value"> & { value: string } };

/** JSON column form (bigints as strings). */
export const quoteToJson = (q: AggregatorQuote): Wire => ({ ...q, fromAmount: String(q.fromAmount), toAmount: String(q.toAmount), toAmountMin: String(q.toAmountMin), tx: { ...q.tx, value: String(q.tx.value) } });
export const quoteFromJson = (w: unknown): AggregatorQuote => {
  const q = w as Wire;
  return { ...q, fromAmount: BigInt(q.fromAmount), toAmount: BigInt(q.toAmount), toAmountMin: BigInt(q.toAmountMin), tx: { ...q.tx, value: BigInt(q.tx.value) } };
};
