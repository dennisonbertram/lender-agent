import { PRICES, VENUES, loanHF, type Asset, type Loan, type Network, type Safe, type Venue } from "@/data";
import { bestPlan, holdingsOf, maxCash } from "@/lib/cash-plan";
import { venuesOn } from "@/lib/networks";
import { DEFAULT_LEVELS, healthFactor, healthStatus, hfAfterDrop, levelsOf, type HealthStatus, type Levels } from "@/lib/loan-math";

type Amounts = Record<Asset, number>;

/** ETH and wstETH move together; WBTC alone (same grouping as the demo price drop). */
const group = (a: Asset) => (a === "WBTC" ? "WBTC" : "ETH");

/** One row per loan with its health after `asset` falls by `drop` (0..1). Loans on other assets keep today's health. */
export function whatIfRows(loans: Loan[], asset: Asset, drop: number, thresholds: Record<string, Levels>) {
  return loans.map((loan) => {
    const { warn, act } = levelsOf(thresholds, loan.id);
    const hf = group(loan.collAsset) === group(asset) ? hfAfterDrop(loanHF(loan), drop) : loanHF(loan);
    return { loan, hf, status: healthStatus(hf, warn, act) };
  });
}

/** A new loan of `cash` at Balanced safety on `asset`, after `asset` falls by `drop`. Null when the Safe cannot fund it. */
export function hypotheticalLoan(cash: number, asset: Asset, drop: number, balances: Amounts, network: Network = "ethereum"): { hf: number; status: HealthStatus; liqPrice: number } | null {
  const p = bestPlan({ cash, months: 12, targetHf: DEFAULT_LEVELS.warn, asset, network }, balances, PRICES, VENUES);
  if (!p) return null;
  const hf = healthFactor(p.totalCollateral * PRICES[asset] * (1 - drop), VENUES.find((v) => v.id === p.venue.id)!.markets[asset]!.lt, p.debt);
  return { hf, status: healthStatus(hf, DEFAULT_LEVELS.warn, DEFAULT_LEVELS.act), liqPrice: p.liqPrice };
}

/** Assets the Safe holds, per network, with the most it can borrow against each at Balanced safety. `lenders` says which lenders each network's funds can use (default: those on that network). */
export function holdingRows(balances: Safe["balances"], lenders: (network: Network) => Venue[] = venuesOn) {
  return holdingsOf(balances).map(({ network, asset }) => {
    const amount = balances[network]![asset];
    return { network, asset, amount, value: amount * PRICES[asset], max: maxCash({ ETH: 0, wstETH: 0, WBTC: 0, [asset]: amount }, PRICES, lenders(network), DEFAULT_LEVELS.warn) };
  });
}
