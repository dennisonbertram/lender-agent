// Deposit detection (BP-31): a pure comparison of the balances just read with the last ones stored.
// A balance rising is a deposit of the difference; the first sight of an asset is a baseline, not a deposit.
import type { Asset } from "@/lib/types";
import type { TokenBalance } from "@/server/chain/types";

/** The collateral a user is told to send (the add-funds copy). WETH, stablecoins and other tokens are not watched. */
export const WATCHED_ASSETS: Asset[] = ["ETH", "wstETH", "WBTC"];

export type Rise = { asset: Asset; raw: bigint; decimals: number };

/**
 * `stored` is the baseline per asset (empty before the first poll of a Safe and network).
 * Returns the rises and the new baseline; a fall lowers the baseline so a later refill counts.
 */
export function detectRises(stored: ReadonlyMap<string, bigint>, current: readonly TokenBalance[], zeroBaseline = false): { rises: Rise[]; next: Map<string, bigint> } {
  const rises: Rise[] = [];
  const next = new Map<string, bigint>();
  // `zeroBaseline`: a brand-new Safe, so the first balance seen is a deposit rather than a silent baseline.
  const hasBaseline = stored.size > 0 || zeroBaseline;
  for (const asset of WATCHED_ASSETS) {
    const b = current.find((x) => x.symbol === asset);
    if (!b) continue;
    const before = stored.get(asset) ?? (hasBaseline ? 0n : b.raw);
    if (b.raw > before) rises.push({ asset, raw: b.raw - before, decimals: b.decimals });
    next.set(asset, b.raw);
  }
  return { rises, next };
}
