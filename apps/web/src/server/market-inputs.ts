// Live chain data → the domain library's inputs (architecture 9.1: `cash-plan.ts` "reuse with
// injection"). The one place that turns Aave on Base into a `Venue`, prices into a `PriceMap` and
// Safe balances into `Amounts`. Owner: the coordinator. Every figure names its block.
import { maxCash } from "@/lib/cash-plan";
import { BALANCED_HF, DEFAULT_LEVELS, minLoanFor } from "@/lib/loan-math";
import type { Amounts, Asset, Loan, Network, NetworkConfig, PriceMap, Safe, Venue } from "@/lib/types";
import { tokenBySymbol } from "@/server/chain/config";
import type { ChainReader } from "@/server/chain/types";
import { assetOf, otherRefs, type LenderReads } from "@/server/lenders/reads";
import type { AdapterMarket, AdapterPosition, LenderId } from "@/server/lenders/types";
import { NETWORK_OF, type Address, type ChainId, type LoanPosition } from "@/shared/types";

export const AAVE_VENUE_ID = "aave-v3";
export const AAVE_VENUE_NAME = "Aave v3";
/** The networks shown in copy (Base and Arbitrum). */
export const M1_NETWORKS: NetworkConfig[] = [{ id: "base", name: "Base", nativeAsset: "ETH" }, { id: "arbitrum", name: "Arbitrum", nativeAsset: "ETH" }];
/** Collateral the product offers on Base in M1 (D-04 recommendation; WBTC is not listed on Aave Base). */
export const M1_COLLATERAL: { asset: Asset; token: "WETH" | "wstETH" }[] = [
  { asset: "ETH", token: "WETH" },
  { asset: "wstETH", token: "wstETH" },
];

export type LiveInputs = {
  chainId: ChainId;
  network: Network;
  blockNumber: bigint;
  readAt: number;
  /** Offered venues (empty when the market is paused, frozen or not borrowable). */
  venues: Venue[];
  prices: PriceMap;
  /** Oracle prices actually returned; planner peg defaults are deliberately not treated as observations. */
  observedPrices: Partial<Record<Asset | "USDC" | "DAI", number>>;
  balances: Amounts;
  /** WETH the Safe holds, apart from native ETH in `balances.ETH`. Not planned with: the Aave builder wraps native ETH only. */
  weth: number;
  /** The Safe's existing Aave loan in the library's shape (one collateral, one debt asset). `venue` is the venue NAME: the library matches loans by name. */
  loans: Loan[];
  position: LoanPosition | null;
  /** Set when the Safe's Aave account holds another pair: no plan on Aave (architecture section 7, D-05). */
  unavailable: { venueId: string; reason: "not available for this Safe yet" } | null;
  /** USDC the pool can lend now (token units), and the borrow cap left (Infinity when none). */
  liquidity: { available: number; borrowCapLeft: number };
  /** Every offered lender, Aave first. Compound and Morpho are present only when a `LenderReads` was passed. */
  lenders: LenderFacts[];
};

/** One lender as the quote sees it: its venue and own prices (D-07), its market per collateral, and the Safe's loan there. */
export type LenderFacts = {
  id: LenderId;
  name: string;
  /** Null when no new loan can be made here now (paused, frozen, not readable). */
  venue: Venue | null;
  /** Why `venue` is null, in the owner's words. */
  note?: string;
  /** USD per unit of each offered collateral, from the lender's own price source. */
  prices: Partial<Record<Asset, number>>;
  markets: Partial<Record<Asset, AdapterMarket>>;
  /** USDC the lender can lend now. */
  liquidity: number;
  /** The Safe's loan in the library's shape (`venue` is the venue NAME), when it has one here. */
  loan: Loan | null;
  position: AdapterPosition | null;
  /** This lender could not be read (an RPC failure): "no loan" is unknown here, never a fact. */
  readFailed?: boolean;
  /** The account holds another pair here: no plan on this lender (D-05). */
  unavailable: boolean;
};

const zero = (): Amounts => ({ ETH: 0, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0 });

/** Read everything a plan needs at one block per read, and map it to the library's inputs. */
export async function liveInputs(reader: ChainReader, chainId: ChainId, safe: Address, lenderReads?: LenderReads): Promise<LiveInputs> {
  const usdc = tokenBySymbol(chainId, "USDC")!;
  // BP-33: one block for the whole comparison. Every read, Aave's and the other lenders', is made at it.
  const blockNumber = await reader.readBlockNumber(chainId);
  const [balances, prices, position, usdcMarket, ...collMarkets] = await Promise.all([
    reader.readBalances(chainId, safe, blockNumber),
    reader.readPrices(chainId, blockNumber),
    reader.readAavePosition(chainId, safe, blockNumber),
    reader.readAaveMarket(chainId, usdc.address!, blockNumber),
    ...M1_COLLATERAL.map((c) => reader.readAaveMarket(chainId, tokenBySymbol(chainId, c.token)!.address!, blockNumber)),
  ]);
  // A reader that answers from another block must fail the read, never mix blocks under one stamp.
  for (const r of [balances, prices, position, usdcMarket, ...collMarkets]) {
    if (r.blockNumber !== blockNumber) throw new Error(`Chain read at block ${r.blockNumber}, not the block ${blockNumber} asked for`);
  }

  const amounts = zero();
  let weth = 0;
  for (const b of balances.balances) {
    // Native ETH only: the builder wraps native ETH, so WETH is not planned with (kept in `weth`).
    if (b.symbol === "WETH") weth += b.amount;
    else if (b.symbol in amounts) amounts[b.symbol as keyof Amounts] += b.amount;
  }

  const priceMap: PriceMap = { ETH: prices.prices.ETH ?? prices.prices.WETH ?? 0, wstETH: prices.prices.wstETH ?? 0, WBTC: 0, USDC: prices.prices.USDC ?? 1, DAI: 1 };
  const observedPrices = Object.fromEntries(Object.entries({ ETH: prices.prices.ETH ?? prices.prices.WETH, wstETH: prices.prices.wstETH, WBTC: prices.prices.WBTC, USDC: prices.prices.USDC, DAI: prices.prices.DAI }).filter(([, value]) => typeof value === "number" && value > 0)) as LiveInputs["observedPrices"];

  const u = usdcMarket.market;
  const borrowable = u.isActive && !u.isPaused && !u.isFrozen && u.borrowingEnabled;
  const markets: Venue["markets"] = {};
  M1_COLLATERAL.forEach((c, i) => {
    const m = collMarkets[i].market;
    if (m.isActive && !m.isPaused && !m.isFrozen && m.ltv > 0) markets[c.asset] = { maxLtv: m.ltv, lt: m.liquidationThreshold };
  });
  const network = NETWORK_OF[chainId];
  const pos = position.position;
  // The cap is reserve-wide: what is left is the cap minus everyone's debt on the reserve.
  const borrowCapLeft = u.borrowCap > 0 ? Math.max(0, u.borrowCap - u.totalDebt) : Infinity;
  const venues: Venue[] = borrowable && Object.keys(markets).length > 0
    ? [{ id: AAVE_VENUE_ID, name: AAVE_VENUE_NAME, borrowAsset: "USDC", apr: u.variableBorrowApr * 100, liquidity: Math.min(u.availableLiquidity, borrowCapLeft), networks: [network], markets }]
    : [];

  // An Aave account is one position unit: health is computed over the whole account.
  const loans: Loan[] = [];
  let unavailable: LiveInputs["unavailable"] = null;
  if (pos && (pos.collateral.length > 0 || pos.debt.length > 0)) {
    const coll = pos.collateral[0];
    const offered = M1_COLLATERAL.find((c) => c.token === coll?.asset || c.asset === coll?.asset);
    const debt = pos.debt[0];
    if (pos.mixed || !offered || (debt && debt.asset !== "USDC")) {
      unavailable = { venueId: AAVE_VENUE_ID, reason: "not available for this Safe yet" };
    } else {
      loans.push({
        id: pos.id, safeId: safe.toLowerCase(), network, venue: AAVE_VENUE_NAME, collAsset: offered.asset, collAmount: coll.amount,
        debtAsset: "USDC", debt: debt?.amount ?? 0, lt: pos.liquidationThreshold, apr: u.variableBorrowApr * 100, accrued: 0,
      });
    }
  }

  const aaveVenue = unavailable ? null : venues[0] ?? null;
  const aaveFacts: LenderFacts = {
    id: "aave-v3", name: AAVE_VENUE_NAME, venue: aaveVenue,
    ...(aaveVenue ? {} : { note: unavailable ? "not available for this Safe yet" : `${AAVE_VENUE_NAME} is paused or frozen right now` }),
    prices: { ETH: priceMap.ETH, wstETH: priceMap.wstETH }, markets: {}, liquidity: Math.min(u.availableLiquidity, borrowCapLeft),
    loan: loans[0] ?? null, position: null, unavailable: unavailable !== null,
  };
  const others = lenderReads ? await readOtherLenders(lenderReads, chainId, safe, network, blockNumber) : [];
  return {
    chainId, network, blockNumber, readAt: Date.now(),
    venues: unavailable ? [] : venues, prices: priceMap, observedPrices, balances: amounts, weth, loans, position: pos, unavailable,
    liquidity: { available: u.availableLiquidity, borrowCapLeft },
    lenders: [aaveFacts, ...others],
  };
}

/** Compound and Morpho on one network, every read at `blockNumber`. A lender that cannot be read at it (or answers from another block) is listed as not available, never an error (the others still quote). */
async function readOtherLenders(reads: LenderReads, chainId: ChainId, safe: Address, network: Network, blockNumber: bigint): Promise<LenderFacts[]> {
  const refs = otherRefs(chainId);
  const ids = [...new Set(refs.map((r) => r.lender))];
  return Promise.all(ids.map(async (id): Promise<LenderFacts> => {
    const mine = refs.filter((r) => r.lender === id);
    const name = id === "morpho-blue" ? "Morpho" : "Compound v3";
    const empty = (note: string): LenderFacts => ({ id, name, venue: null, note, prices: {}, markets: {}, liquidity: 0, loan: null, position: null, unavailable: false });
    try {
      const [ms, ps] = await Promise.all([Promise.all(mine.map((r) => reads.market(r, blockNumber))), Promise.all(mine.map((r) => reads.position(r, safe, blockNumber)))]);
      for (const x of [...ms, ...ps]) if (x && x.blockNumber !== blockNumber) throw new Error(`${name} read at block ${x.blockNumber}, not ${blockNumber}`);
      const markets: LenderFacts["markets"] = {};
      const prices: LenderFacts["prices"] = {};
      const vm: Venue["markets"] = {};
      mine.forEach((r, i) => {
        const m = ms[i]!;
        const a = assetOf(r.collateral);
        markets[a] = m;
        prices[a] = m.collateralPriceUsd;
        if (m.borrowable && m.ltv > 0) vm[a] = { maxLtv: m.ltv, lt: m.liquidationThreshold };
      });
      const first = ms[0]!;
      const liquidity = Math.min(first.availableLiquidity, first.borrowCapLeft ?? Infinity);
      const held = ps.map((p, i) => ({ p, r: mine[i]! })).filter((x) => x.p !== null);
      const own = held.find((x) => !x.p!.mixed);
      const position = (own ?? held[0])?.p ?? null;
      const unavailable = !own && held.length > 0;
      let loan: Loan | null = null;
      if (own && own.p!.collateral.length > 0) {
        const coll = own.p!.collateral[0]!;
        const debt = own.p!.debt[0];
        loan = {
          id: `${chainId}:${safe.toLowerCase()}:${id}`, safeId: safe.toLowerCase(), network, venue: name, collAsset: assetOf(own.r.collateral), collAmount: coll.amount,
          debtAsset: "USDC", debt: debt?.amount ?? 0, lt: own.p!.liquidationThreshold, apr: first.borrowApr * 100, accrued: 0,
        };
      }
      const open = Object.keys(vm).length > 0 && !unavailable;
      const venue: Venue | null = open ? { id, name, borrowAsset: "USDC", apr: first.borrowApr * 100, liquidity, networks: [network], markets: vm } : null;
      return {
        id, name, venue, ...(venue ? {} : { note: unavailable ? "not available for this Safe yet" : first.notBorrowableReason ?? `${name} is not lending now` }),
        prices, markets, liquidity, loan, position, unavailable,
      };
    } catch {
      return { ...empty(`${name} could not be read right now`), readFailed: true };
    }
  }));
}

/**
 * THE borrow limit. Every "borrow up to $X" (greeting, explainer "Plan" chip, holdings card, Get cash, compare) calls this
 * with the same inputs: the Safe's balance of the asset, the safety level (`targetHf`, default Balanced), each lender's own
 * max LTV rule, its own live price and its liquidity. The best lender wins. `only` narrows to one asset (a holdings row);
 * without it, the best asset. A row for the Safe's best asset therefore always equals the headline figure.
 */
export type BorrowLimit = { max: number; lenderId: LenderId | null; lenderName: string | null; asset: Asset | null };

export function borrowLimitFor(inputs: LiveInputs, only?: Asset, targetHf = BALANCED_HF): BorrowLimit {
  let best: BorrowLimit = { max: 0, lenderId: null, lenderName: null, asset: null };
  for (const f of inputs.lenders) {
    if (!f.venue) continue;
    for (const asset of Object.keys(f.venue.markets) as Asset[]) {
      if (only && asset !== only) continue;
      const alone: Amounts = { ETH: 0, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0, [asset]: inputs.balances[asset] };
      const max = Math.min(maxCash(alone, { ...inputs.prices, ...f.prices }, [f.venue], targetHf), f.liquidity);
      // A lender that cannot fund even its own smallest loan is no default: the plan would be a refusal.
      if (max < minLoanFor(f.markets[asset]?.minBorrow)) continue;
      if (max > best.max) best = { max, lenderId: f.id, lenderName: f.name, asset };
    }
  }
  return best;
}

export const borrowLimit = (inputs: LiveInputs, targetHf = BALANCED_HF): BorrowLimit => borrowLimitFor(inputs, undefined, targetHf);

/** The most this Safe can safely borrow at `targetHf` from any offered lender (Get cash chips and limits). */
export const maxCashAll = (inputs: LiveInputs, targetHf = BALANCED_HF): number => borrowLimit(inputs, targetHf).max;

/** Kept for one release: the same limit as `borrowLimit(inputs).max`. */
export const maxCashFor = (inputs: LiveInputs, _safe?: unknown, targetHf = BALANCED_HF): number => borrowLimit(inputs, targetHf).max;


/** Lenders whose read failed in these inputs: whether the Safe has a loan there is unknown. */
export const unreadLenders = (inputs: readonly LiveInputs[]): string[] => [...new Set(inputs.flatMap((i) => i.lenders.filter((f) => f.readFailed).map((f) => f.name)))];

/** The Safe's open loans, from the raw positions: a loan is outstanding debt, whatever the planner can model (mixed collateral counts; collateral alone does not). */
export function openLoansOf(inputs: readonly LiveInputs[]): { venue: string; network: Network; collAsset: string; debt: number }[] {
  const out: { venue: string; network: Network; collAsset: string; debt: number }[] = [];
  const add = (venue: string, network: Network, p: { collateral: { asset: string }[]; debt: { amount: number }[] }) => {
    const debt = p.debt.reduce((t, x) => t + x.amount, 0);
    if (debt > 0) out.push({ venue, network, collAsset: p.collateral.map((c) => c.asset).join(" and ") || "collateral", debt });
  };
  for (const i of inputs) {
    if (i.position) add(AAVE_VENUE_NAME, i.network, i.position);
    for (const f of i.lenders) if (f.position) add(f.name, i.network, f.position);
  }
  return out;
}
