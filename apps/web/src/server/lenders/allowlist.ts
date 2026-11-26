// The market allowlist (D-04): one typed row per (lender, network, market). A market that is not here is
// never offered for new borrowing, but an existing position in it is still read and shown (BP-32).
// Default chosen for D-04: Base, plus Aave v3 on Arbitrum (BP-35, the adapter suite passes on its fork); Spark is not deployed on Base (architecture section 7).
//
// Morpho market choice, read on the Base fork at block 57,172,000: WETH collateral / USDC loan, liquidation
// LLTV 86%, id 0x8793cf30...1bda, oracle 0xFEa2D58c..., IRM 0x46415998... It held about 103.9M USDC supplied and
// 88.5M borrowed (about 15M lendable). The wstETH/USDC market (id 0x13c42741...) is smaller and is left off.
import { AAVE } from "@/server/chain/config";
import type { ChainId } from "@/shared/types";
import type { CollateralSymbol, LenderId, MarketRef } from "./types";

export const COMET_USDC_BASE = "0xb125E6687d4313864e53df431d5425969c15Eb2F" as const;
export const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
export const MORPHO_WETH_USDC_ID = "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda" as const;

export type AllowlistRow = {
  lender: LenderId;
  chainId: ChainId;
  marketId: string;
  label: string;
  debtAsset: "USDC";
  collaterals: readonly CollateralSymbol[];
};

export const MARKET_ALLOWLIST: readonly AllowlistRow[] = [
  { lender: "aave-v3", chainId: 8453, marketId: AAVE[8453]!.pool, label: "Aave v3 Base", debtAsset: "USDC", collaterals: ["WETH", "wstETH"] },
  { lender: "aave-v3", chainId: 42161, marketId: AAVE[42161]!.pool, label: "Aave v3 Arbitrum", debtAsset: "USDC", collaterals: ["WETH", "wstETH"] },
  { lender: "compound-v3", chainId: 8453, marketId: COMET_USDC_BASE, label: "Compound v3 USDC (Base)", debtAsset: "USDC", collaterals: ["WETH", "wstETH"] },
  { lender: "morpho-blue", chainId: 8453, marketId: MORPHO_WETH_USDC_ID, label: "Morpho WETH/USDC 86% (Base)", debtAsset: "USDC", collaterals: ["WETH"] },
];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function offeredMarkets(chainId: ChainId): AllowlistRow[] {
  return MARKET_ALLOWLIST.filter((m) => m.chainId === chainId);
}

export function isOffered(ref: MarketRef): boolean {
  return MARKET_ALLOWLIST.some((m) => m.lender === ref.lender && m.chainId === ref.chainId && same(m.marketId, ref.marketId) && m.collaterals.includes(ref.collateral));
}

/** Throws unless the market is on the list: new borrowing is never built elsewhere. */
export function assertOffered(ref: MarketRef): void {
  if (!isOffered(ref)) throw new Error(`${ref.lender} market ${ref.marketId} (${ref.collateral}) is not offered on chain ${ref.chainId}`);
}
