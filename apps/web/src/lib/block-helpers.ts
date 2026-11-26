import type { Asset, Loan, Network, NetworkConfig, PriceMap, Safe, Venue } from "@/lib/types";
import { bestPlan, holdingsOf, maxCash } from "@/lib/cash-plan";
import { venuesOn } from "@/lib/networks";
import { BALANCED_HF, DEFAULT_LEVELS, healthFactor, healthStatus, hfAfterDrop, levelsOf, type HealthStatus, type Levels } from "@/lib/loan-math";

type Amounts = Record<Asset, number>;
const loanHF = (loan: Loan, prices: PriceMap) => healthFactor(loan.collAmount * prices[loan.collAsset], loan.lt, loan.debt);

/** ETH and wstETH move together; WBTC alone (same grouping as the demo price drop). */
const group = (a: Asset) => (a === "WBTC" ? "WBTC" : "ETH");

/** One row per loan with its health after `asset` falls by `drop` (0..1). Loans on other assets keep today's health. */
export function whatIfRows(loans: Loan[], asset: Asset, drop: number, thresholds: Record<string, Levels>, prices: PriceMap) {
  return loans.map((loan) => {
    const { warn, act } = levelsOf(thresholds, loan.id);
    const currentHf = loanHF(loan, prices);
    const hf = group(loan.collAsset) === group(asset) ? hfAfterDrop(currentHf, drop) : currentHf;
    return { loan, hf, status: healthStatus(hf, warn, act) };
  });
}

/** A new loan of `cash` at Balanced safety on `asset`, after `asset` falls by `drop`. Null when the Safe cannot fund it. */
export function hypotheticalLoan(cash: number, asset: Asset, drop: number, balances: Amounts, network: Network, prices: PriceMap, venues: readonly Venue[]): { hf: number; status: HealthStatus; liqPrice: number } | null {
  const p = bestPlan({ cash, months: 12, targetHf: BALANCED_HF, asset, network }, balances, prices, venues, []);
  if (!p) return null;
  const hf = healthFactor(p.totalCollateral * prices[asset] * (1 - drop), p.venue.markets[asset]!.lt, p.debt);
  return { hf, status: healthStatus(hf, BALANCED_HF, DEFAULT_LEVELS.act), liqPrice: p.liqPrice };
}

/** Assets the Safe holds, per network, with the most it can borrow against each at Balanced safety. `lenders` says which lenders each network's funds can use (default: those on that network). */
export function holdingRows(balances: Safe["balances"], prices: PriceMap, networks: readonly NetworkConfig[], venues: readonly Venue[]) {
  return holdingsOf(balances, networks, venues).map(({ network, asset }) => {
    const amount = balances[network]![asset];
    return { network, asset, amount, value: amount * prices[asset], max: maxCash({ ETH: 0, wstETH: 0, WBTC: 0, [asset]: amount }, prices, venuesOn(network, venues), BALANCED_HF) };
  });
}
