// Fixture lender reads for `MOCK=1` and unit tests: settable markets and positions, no network.
import type { Address } from "@/shared/types";
import { MARKET_ALLOWLIST } from "./allowlist";
import type { LenderReads } from "./reads";
import type { AdapterMarket, AdapterPosition, MarketRef } from "./types";

export type FixtureLenders = LenderReads & {
  setMarket(ref: MarketRef, patch: Partial<AdapterMarket>): void;
  setPosition(ref: MarketRef, safe: Address, position: AdapterPosition | null): void;
  /** Make every read of this lender throw (an RPC failure). */
  fail(lender: MarketRef["lender"], on?: boolean): void;
};

const k = (r: MarketRef) => `${r.lender}:${r.chainId}:${r.marketId.toLowerCase()}:${r.collateral}`;
const BLOCK = 57_172_000n;

const defaults = (ref: MarketRef): AdapterMarket => {
  const morpho = ref.lender === "morpho-blue";
  return {
    ref, name: morpho ? "Morpho" : "Compound v3",
    collateralPriceUsd: ref.collateral === "wstETH" ? 3600 : 3000,
    ltv: morpho ? 0.86 : 0.8, liquidationThreshold: morpho ? 0.86 : 0.85,
    borrowApr: morpho ? 0.034 : 0.042,
    availableLiquidity: 5_000_000, borrowCapLeft: null, collateralSupplyCapLeft: null, minBorrow: morpho ? 0 : 100,
    borrowable: true, blockNumber: BLOCK,
  };
};

export function createFixtureLenders(): FixtureLenders {
  const markets = new Map<string, AdapterMarket>();
  const positions = new Map<string, AdapterPosition | null>();
  const failing = new Set<string>();
  const get = (ref: MarketRef) => {
    if (failing.has(ref.lender)) throw new Error(`${ref.lender} read failed`);
    if (!MARKET_ALLOWLIST.some((m) => m.lender === ref.lender && m.marketId.toLowerCase() === ref.marketId.toLowerCase())) throw new Error("not a market");
    return markets.get(k(ref)) ?? defaults(ref);
  };
  return {
    async market(ref, blockNumber) { const m = get(ref); return blockNumber === undefined ? m : { ...m, blockNumber }; },
    async position(ref, safe, blockNumber) { get(ref); const p = positions.get(`${k(ref)}:${safe.toLowerCase()}`) ?? null; return p && blockNumber !== undefined ? { ...p, blockNumber } : p; },
    setMarket(ref, patch) { markets.set(k(ref), { ...get(ref), ...patch, ref }); },
    setPosition(ref, safe, p) { positions.set(`${k(ref)}:${safe.toLowerCase()}`, p); },
    fail(lender, on = true) { if (on) failing.add(lender); else failing.delete(lender); },
  };
}
