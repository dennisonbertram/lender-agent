// How the quote reads Compound and Morpho (Aave keeps the `ChainReader`, so M1 is unchanged). One seam:
// the chain adapters by default, a fixture in `MOCK=1` and in unit tests (`fixture.ts`).
import type { Asset } from "@/lib/types";
import type { Address, ChainId } from "@/shared/types";
import { adapterFor } from "./index";
import { offeredMarkets } from "./allowlist";
import type { AdapterMarket, AdapterPosition, CollateralSymbol, LenderId, MarketRef } from "./types";

export type LenderReads = {
  market(ref: MarketRef, blockNumber?: bigint): Promise<AdapterMarket>;
  position(ref: MarketRef, safe: Address, blockNumber?: bigint): Promise<AdapterPosition | null>;
};

export const chainLenderReads: LenderReads = {
  market: (ref, blockNumber) => adapterFor(ref.lender).readMarket(ref, blockNumber),
  position: (ref, safe, blockNumber) => adapterFor(ref.lender).readPosition(ref, safe, blockNumber),
};

/** The library's asset for a market's collateral token. */
export const assetOf = (c: CollateralSymbol): Asset => (c === "WETH" ? "ETH" : c);

/** Offered markets of the lenders other than Aave on one network, one ref per collateral. */
export function otherRefs(chainId: ChainId): MarketRef[] {
  return offeredMarkets(chainId).filter((m) => m.lender !== "aave-v3")
    .flatMap((m) => m.collaterals.map((collateral) => ({ lender: m.lender as LenderId, chainId, marketId: m.marketId, collateral })));
}
