import { NETWORKS, VENUES, fmt, networkName, usd, type Asset, type Loan, type Network, type Safe, type Venue } from "@/data";
import { balancesOn, lendersFor } from "@/lib/networks";
import { rateNote } from "@/lib/loan-copy";
import { MIN_LOAN, healthFactor, liquidationPrice, maxPriceDrop, maxSafeBorrow, yearlyInterest } from "@/lib/loan-math";

export const CASH_ASSETS: Asset[] = ["ETH", "wstETH", "WBTC"];
type Amounts = Record<Asset, number>;

export type Need = { network: Network; cash: number; months: number; targetHf: number; asset: Asset; /** Collateral to lock, when the user already chose it (from the offer explorer). */ collateral?: number };

/** One quote for an action on a loan: every surface prints these figures, so they cannot disagree. */
export type Quote = {
  /** "added": the Safe already has a loan at this lender with this collateral. */
  scope: "new" | "added";
  venue: Venue;
  /** 0 when scope is "new". */
  existingDebt: number;
  /** Whole loan after the action. */
  totalCollateral: number;
  debt: number;
  /** The existing loan's own rate when "added", else the venue's. */
  apr: number;
  /** Always the stated rate times the stated debt. */
  yearly: number;
  /** Interest on the cash this action adds. */
  newYearly: number;
  hf: number;
  liqPrice: number;
  /** Percent the collateral price can fall before trouble, already rounded. */
  dropPct: number;
};

/** Moving crypto to another network with a bridge. Sample fee and time; a bridge aggregator would quote these. */
export type Move = { from: Network; to: Network; asset: Asset; amount: number; feeUsd: number; minutes: number };

/** Sample bridge quote: $2 to $6 and 2 to 15 minutes. Ethereum as the destination costs more; Polygon and Gnosis are slower and dearer. */
export function moveQuote(from: Network, to: Network, asset: Asset, amount: number): Move {
  const slow = [from, to].some((n) => n === "polygon" || n === "gnosis");
  return { from, to, asset, amount, feeUsd: (to === "ethereum" ? 4 : 2) + (slow ? 2 : 0), minutes: slow ? 15 : to === "ethereum" ? 10 : 2 };
}

/** "Move 2.04 ETH from Base to Ethereum (about 10 minutes)." The fee is stated once, in `feesLine`. */
export const moveLine = (m: Move) => `Move ${fmt(m.amount, 2)} ${m.asset} from ${networkName(m.from)} to ${networkName(m.to)} (about ${m.minutes} minutes).`;

/** The one place a network fee is calculated (sample: gas per step times the ETH price). */
const GAS_PER_STEP = 0.0013;
export const networkFeeUsd = (steps: number, ethPrice: number) => GAS_PER_STEP * steps * ethPrice;
/** Steps in a loan proposal: allow, supply, borrow. */
export const LOAN_STEPS = 3;
export const loanFeeUsd = (ethPrice: number) => networkFeeUsd(LOAN_STEPS, ethPrice);

export type CashPlan = Quote & {
  /** Collateral this action locks (totalCollateral is the whole loan). */
  collateral: number;
  feasible: boolean;
  overTime: number;
  /** The network the loan is made on. */
  network: Network;
  /** Set when the collateral sits on another network: move it first. */
  move?: Move;
};

/** The loan as it will be after adding `addCollateral` and `addCash`. `loans` are the active Safe's loans. */
export function quoteLoan(venue: Venue, asset: Asset, addCollateral: number, addCash: number, price: number, loans: Loan[]): Quote {
  const old = loans.find((l) => l.venue === venue.name && l.collAsset === asset);
  const m = venue.markets[asset];
  const lt = old?.lt ?? m?.lt;
  const apr = old?.apr ?? venue.apr;
  const totalCollateral = (old?.collAmount ?? 0) + addCollateral;
  const debt = (old?.debt ?? 0) + addCash;
  const base = { scope: old ? ("added" as const) : ("new" as const), venue, existingDebt: old?.debt ?? 0, totalCollateral, debt, apr, yearly: yearlyInterest(debt, apr), newYearly: yearlyInterest(addCash, apr) };
  if (lt === undefined) return { ...base, hf: 0, liqPrice: 0, dropPct: 0 };
  const hf = healthFactor(totalCollateral * price, lt, debt);
  return { ...base, hf, liqPrice: liquidationPrice(totalCollateral, lt, debt), dropPct: Math.round(maxPriceDrop(hf) * 100) };
}

/** Collateral to lock for `cash` at the target health (or `need.collateral`), also respecting the venue's max LTV; rounded up to 0.01. Only the loans on `need.network` count. */
export function planFor(need: Need, balance: number, price: number, venue: Venue, allLoans: Loan[] = []): CashPlan {
  const loans = allLoans.filter((l) => l.network === need.network);
  const m = venue.markets[need.asset];
  const raw = m ? Math.max((need.cash * need.targetHf) / (price * m.lt), need.cash / (price * m.maxLtv)) : 0;
  const collateral = need.collateral ?? Math.ceil(raw * 100 - 1e-9) / 100;
  const q = quoteLoan(venue, need.asset, collateral, need.cash, price, loans);
  return { ...q, collateral, network: need.network, feasible: !!m && need.cash >= MIN_LOAN && collateral <= balance, overTime: (q.yearly * need.months) / 12 };
}

/** One line with every one-time network fee of the plan. The total adds the rounded parts, so it matches what is printed. */
export function feesLine(plan: CashPlan, ethPrice: number): string {
  const loan = Math.round(loanFeeUsd(ethPrice));
  if (!plan.move) return `One-time network fee: about ${usd(loan)} to set up the loan.`;
  const move = Math.round(plan.move.feeUsd);
  return `One-time network fees: about ${usd(move + loan)} (${usd(move)} for the move, ${usd(loan)} for the loan).`;
}

/**
 * Plans for funds held on `need.network`, across every lender the Safe can reach. A lender on that network plans there;
 * a lender only on another of the Safe's networks gets a `move` (the cheapest route). Lowest quoted rate first.
 */
export function plansAcross(safe: Safe, need: Need, prices: Record<Asset, number>, venues: Venue[], loans: Loan[] = []): CashPlan[] {
  const from = need.network;
  const have = balancesOn(safe, from)[need.asset];
  return lendersFor(safe, from, venues).flatMap((v) => {
    const dest = v.networks.includes(from) ? from : safe.networks.map((n) => n.id).filter((n) => v.networks.includes(n)).sort((a, b) => moveQuote(from, a, need.asset, 0).feeUsd - moveQuote(from, b, need.asset, 0).feeUsd)[0];
    if (!dest) return [];
    const plan = planFor({ ...need, network: dest }, have, prices[need.asset], v, loans);
    return [dest === from ? plan : { ...plan, move: moveQuote(from, dest, need.asset, plan.collateral) }];
  }).sort((a, b) => a.apr - b.apr);
}

/** What to offer: the cheapest same-network plan that works (or, if none, the cheapest cross-network one). A cross-network plan that saves more a year than its move costs comes along as the alternative. */
export function choosePlan(plans: CashPlan[]): { plan: CashPlan; alternative?: { plan: CashPlan; saves: number } } | null {
  const ok = plans.filter((p) => p.feasible);
  const same = ok.find((p) => !p.move);
  const cross = ok.find((p) => p.move);
  if (!same) return cross ? { plan: cross } : null;
  const saves = cross ? same.newYearly - cross.newYearly : 0;
  return cross && saves > cross.move!.feeUsd ? { plan: same, alternative: { plan: cross, saves } } : { plan: same };
}

/** "Morpho Blue on Ethereum costs about $25 a year less, after a move of about $4 (about 10 minutes)." */
export const altLine = (p: CashPlan, saves: number) => `${p.venue.name} on ${networkName(p.network)} costs about ${usd(saves)} a year less, after a move of about ${usd(p.move!.feeUsd)} (about ${p.move!.minutes} minutes).`;

/** Why the collateral moves first: no lender on its network can fund the loan, the move saves money, or the user picked that lender. Null when there is no move. */
export function moveReason(plan: CashPlan, plans: CashPlan[]): string | null {
  const m = plan.move;
  if (!m) return null;
  const from = networkName(m.from), to = networkName(m.to);
  const same = plans.find((p) => p.feasible && !p.move);
  if (!same) return `No lender on ${from} can lend ${usd(plan.debt - plan.existingDebt)} against your ${m.asset} at this safety level. ${plan.venue.name} on ${to} can, so your ${m.asset} moves there first.`;
  const saves = same.newYearly - plan.newYearly;
  if (saves > 0) return `Moving saves about ${usd(saves)} a year compared with ${same.venue.name} on ${from}.`;
  return `You picked ${plan.venue.name}, which is on ${to}, so your ${m.asset} moves there first.`;
}

/** The most cash this lender can safely fund against `held` of the asset at `targetHf`; null when it has no market for the asset. */
export function lenderLimit(venue: Venue, asset: Asset, held: number, price: number, targetHf: number): number | null {
  const m = venue.markets[asset];
  return m ? maxSafeBorrow(held * price, m.lt, m.maxLtv, targetHf) : null;
}

/** Plans for every venue on the need's network, lowest quoted rate first. `balances` are the Safe's amounts on that network. */
export const plansFor = (need: Need, balances: Amounts, prices: Record<Asset, number>, venues: Venue[], loans: Loan[] = []) =>
  venues.filter((v) => v.networks.includes(need.network)).map((v) => planFor(need, balances[need.asset], prices[need.asset], v, loans)).sort((a, b) => a.apr - b.apr);

export const bestPlan = (need: Need, balances: Amounts, prices: Record<Asset, number>, venues: Venue[], loans: Loan[] = []) =>
  plansFor(need, balances, prices, venues, loans).find((p) => p.feasible) ?? null;

/** Largest cash (multiple of $500) any asset and venue can safely fund at `targetHf`. */
export const maxCash = (balances: Amounts, prices: Record<Asset, number>, venues: Venue[], targetHf: number) =>
  Math.max(0, ...CASH_ASSETS.flatMap((a) => venues.flatMap((v) => {
    const m = v.markets[a];
    return m ? [maxSafeBorrow(balances[a] * prices[a], m.lt, m.maxLtv, targetHf)] : [];
  })));

/** Asset worth the most in the Safe that can fund the plan; otherwise the one worth the most. */
export function defaultAsset(balances: Amounts, prices: Record<Asset, number>, venues: Venue[], cash: number, targetHf: number, network: Network = "ethereum"): Asset {
  const byValue = [...CASH_ASSETS].sort((a, b) => balances[b] * prices[b] - balances[a] * prices[a]);
  return byValue.find((asset) => bestPlan({ cash, months: 12, targetHf, asset, network }, balances, prices, venues)) ?? byValue[0];
}

/** An asset on a network: the unit a loan is planned against. */
export type Holding = { network: Network; asset: Asset };

/** Every borrowable asset the Safe holds, per network. */
export const holdingsOf = (b: Safe["balances"]): Holding[] =>
  NETWORKS.flatMap(({ id }) => CASH_ASSETS.filter((asset) => (b[id]?.[asset] ?? 0) > 0).map((asset) => ({ network: id, asset })));

/** The largest cash (multiple of $500) the Safe can safely borrow against funds on any network, or only against those held on `network`. Lenders on the Safe's other networks count (the funds move there). */
export const maxCashSafe = (safe: Safe, prices: Record<Asset, number>, targetHf: number, network?: Network) =>
  Math.max(0, ...NETWORKS.filter((n) => !network || n.id === network).map((n) => maxCash(balancesOn(safe, n.id), prices, lendersFor(safe, n.id), targetHf)));

/**
 * The holding to plan against: what the caller asked for (asset and/or network) if the Safe holds it,
 * the most valuable holding that can fund `cash`, else the most valuable one. With nothing held, the wish itself (Ethereum, ETH by default).
 */
export function resolveHolding(safe: Safe, prices: Record<Asset, number>, cash: number, targetHf: number, want: Partial<Holding> = {}): Holding {
  const value = (h: Holding) => balancesOn(safe, h.network)[h.asset] * prices[h.asset];
  const held = holdingsOf(safe.balances).filter((h) => (!want.asset || h.asset === want.asset) && (!want.network || h.network === want.network)).sort((a, b) => value(b) - value(a));
  const fits = (h: Holding) => choosePlan(plansAcross(safe, { cash, months: 12, targetHf, ...h }, prices, VENUES));
  return held.find(fits) ?? held[0] ?? { network: want.network ?? "ethereum", asset: want.asset ?? "ETH" };
}

/** Quick amounts: fixed ones under the Safe's maximum, then "Up to {max}". */
export const cashChips = (max: number) => [
  ...[5000, 10000, 25000].filter((c) => c < max).map((c) => ({ label: usd(c), amount: c })),
  { label: `Up to ${usd(max)}`, amount: max },
];

/** The plan's cost sentence; the time-based sentence is added only when the time is not one year. */
export function costLine(q: Quote, months: number): string {
  const added = q.scope === "added";
  const period = months === 24 ? "2 years" : `${months} months`;
  const fresh = usd(q.debt - q.existingDebt);
  return (
    (added ? `About ${usd(q.newYearly)} a year for the new ${fresh} at ${q.apr}% (about ${usd(q.yearly)} a year on the full ${usd(q.debt)} loan).${rateNote(q)} The rate can change.` : `About ${usd(q.yearly)} a year at today's ${q.apr}% rate. The rate can change.`) +
    (months === 12 ? "" : added ? ` About ${usd((q.newYearly * months) / 12)} over ${period} for the new ${fresh}.` : ` About ${usd((q.yearly * months) / 12)} over ${period}.`)
  );
}

export function cashDoneLine(amount: number, asset: string, safeName: string): string {
  return `The ${fmt(amount)} ${asset} is in ${safeName}. To pay someone or move it to your bank, send it from the Safe app.`;
}
