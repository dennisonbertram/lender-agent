// The one shape every lender adapter has (architecture section 7, BP-32). Amounts are plain numbers in
// token units, as in the domain library; the builders turn them into integers (rounding in the user's favour).
import type { Built } from "@/server/aave/build";
import type { Address, ChainId } from "@/shared/types";

export type { Built };
export type LenderId = "aave-v3" | "compound-v3" | "morpho-blue";
/** ERC-20 collateral a market can hold. Native ETH is an input only: it is wrapped to WETH. */
export type CollateralSymbol = "WETH" | "wstETH";
export type CollateralInput = "ETH" | CollateralSymbol;

/** One loan market: a lender, a network and the market on it. `marketId` is the Aave Pool, the Comet, or the Morpho market id. */
export type MarketRef = { lender: LenderId; chainId: ChainId; marketId: string; collateral: CollateralSymbol };

/** `usd` is null when no dollar price could be read: show the amount, never a made-up dollar figure. */
type Holding = { asset: string; token: Address; amount: number; usd: number | null };

/** A Safe's position in one market, read at one block. */
export type AdapterPosition = {
  lender: LenderId;
  chainId: ChainId;
  safe: Address;
  marketId: string;
  collateral: Holding[];
  debt: Holding[];
  /** The lender's own health (collateral x liquidation threshold / debt); null when there is no debt. */
  health: number | null;
  /** The lender would let someone liquidate now (Morpho: borrow capacity below debt; health exactly 1 is not). */
  liquidatable: boolean;
  liquidationThreshold: number;
  /** The account holds something besides the market's own collateral and USDC debt (D-05). */
  mixed: boolean;
  blockNumber: bigint;
};

export type AdapterMarket = {
  ref: MarketRef;
  name: string;
  /** USD per unit of the collateral, from the lender's own price source. */
  collateralPriceUsd: number;
  /** Highest loan-to-value to borrow at, and the one that triggers liquidation (0..1). */
  ltv: number;
  liquidationThreshold: number;
  /** Variable borrow rate per year, 0..1. */
  borrowApr: number;
  /** USDC the market can lend now. */
  availableLiquidity: number;
  /** USDC left under the borrow cap; null when there is none. */
  borrowCapLeft: number | null;
  /** Collateral units left under the supply cap; null when there is none. */
  collateralSupplyCapLeft: number | null;
  /** Smallest borrow in USDC (0 when none). */
  minBorrow: number;
  borrowable: boolean;
  notBorrowableReason?: string;
  blockNumber: bigint;
};

export interface LenderAdapter {
  readonly id: LenderId;
  readonly name: string;
  /** What happens to the owner's collateral at liquidation, in this lender's terms. */
  liquidationSentence(): string;
  /** The Safe's position in the market, or null when it has none. Works for markets that are not offered. */
  /** `blockNumber`: read at exactly this block (BP-33); without it, at the latest block. */
  readPosition(ref: MarketRef, safe: Address, blockNumber?: bigint): Promise<AdapterPosition | null>;
  readMarket(ref: MarketRef, blockNumber?: bigint): Promise<AdapterMarket>;
  /** Add collateral (wraps native ETH when asked for "ETH"). */
  buildSupply(ref: MarketRef, safe: Address, asset: CollateralInput, amount: number): Built;
  /** Borrow USDC to the Safe. Only in an offered market. */
  buildBorrow(ref: MarketRef, safe: Address, amount: number): Built;
  /** Repay USDC debt. The calls do not depend on who sends them: a third party can repay for the Safe. */
  buildRepay(ref: MarketRef, safe: Address, amount: number): Built;
  /** Take collateral back to the Safe. */
  buildWithdraw(ref: MarketRef, safe: Address, amount: number): Built;
  /** Supply and borrow in one batch. Only in an offered market. */
  buildOpen(p: { ref: MarketRef; safe: Address; collateral: { asset: CollateralInput; amount: number }; borrow: number }): Built;
  /** Raise health: add collateral, repay, or both. */
  buildProtect(p: { ref: MarketRef; safe: Address; addCollateral?: { asset: CollateralInput; amount: number }; repay?: number }): Built;
  /** Repay all debt and take all collateral back. Reads the position to size the batch. */
  buildClose(p: { ref: MarketRef; safe: Address }): Promise<Built>;
}
