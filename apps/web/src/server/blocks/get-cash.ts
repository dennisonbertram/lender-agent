// The Get cash planner's server side (BP-34). Screen 1 needs the most the Safe can borrow and chips under it;
// screen 2 needs, for one asset and amount, what each safety choice would lock and the ranked lenders. Every
// figure is `attempt`'s, so the planner, the chat plan card and the compare block say the same things (VC-02).
// The planner finds which owned, served network can fund the plan: Base when it is funded, the funded one
// otherwise, so a beginner never has to know which network holds their collateral (BR-3).
import { cashChips, defaultAsset } from "@/lib/cash-plan";
import type { Asset, Network } from "@/lib/types";
import { MIN_LOAN } from "@/lib/loan-math";
import { limitWhy } from "@/lib/borrow-limit";
import { M1_COLLATERAL, borrowLimit, type LiveInputs } from "@/server/market-inputs";
import { attempt, figuresOf, HF_LEVELS, planChainOf, roundedVenue, type Need } from "@/server/quote";
import { requireNetwork } from "@/server/auth/access";
import type { SafeContext } from "@/server/request";
import { CHAIN_NAME, NETWORK_OF, type ChainId } from "@/shared/types";
import { pickSource, scanSources, servedOwned, sourceRead, unreadSources, type SourceNote, type Stamp } from "./block-inputs";
import { compareRows, type CompareRow } from "./compare";

export const SAFETY_TITLES = ["Extra safe", "Balanced", "Lean"] as const;

export type SafetyChoice = {
  idx: 0 | 1 | 2;
  title: string;
  hf: number;
  /** A lender can fund the plan at this level. */
  feasible: boolean;
  /** Collateral the cheapest lender would lock, and how far the price can fall. */
  collateral?: number;
  dropPct?: number;
  /** When not feasible: the fewest units of the asset any lender would need. */
  needs?: number;
};

/** A served network the Safe could borrow on (or could not be read this time). */
export type { SourceNote } from "./block-inputs";

export type GetCashResponse = {
  /** "empty": the Safe holds nothing to borrow against. "tooLittle": less than the smallest loan. */
  state: "empty" | "tooLittle" | "ok";
  /** The most the Safe can borrow at Balanced; chips never go above it. */
  maxCash: number;
  /** "Why $X?" sentence (VC-02); empty when there is no limit. */
  why?: string;
  chips: { label: string; amount: number }[];
  holdings: { asset: Asset; balance: number; usd: number }[];
  /** The collateral the plan uses: the one asked for, else the largest that can fund it. */
  asset: Asset | null;
  balance: number;
  /** One per safety choice for `asset` at `cash`; empty without a valid amount. */
  levels: SafetyChoice[];
  /** The ranked lenders for `asset` at the chosen safety level; the plan uses the first that can lend. */
  lenders: CompareRow[];
  best: string | null;
  /** The network every figure in this response is for. Quotes, plans and sends carry it from here on. */
  network: Network;
  chainId: ChainId;
  networkName: string;
  /** Other owned networks that could also fund a loan: offered as an explicit switch, never implied. */
  otherFunded: (SourceNote & { maxCash: number })[];
  /** Owned networks that could not be read: their balances are unknown, not empty. */
  unread: SourceNote[];
} & Stamp;

type Ctx = Pick<SafeContext, "services" | "safe" | "access">;

const noteOf = (chainId: ChainId): SourceNote => ({ network: NETWORK_OF[chainId], chainId, name: CHAIN_NAME[chainId] });

export async function getCashFor(ctx: Ctx, input: { cash?: number; asset?: Asset; hfIdx?: 0 | 1 | 2; network?: Network; chainId?: ChainId }): Promise<GetCashResponse> {
  const requested = input.network !== undefined || input.chainId !== undefined ? planChainOf(input) : undefined;
  if (requested !== undefined) requireNetwork(ctx.access, requested);
  if (!servedOwned(ctx).length) requireNetwork(ctx.access, requested ?? 8453);
  const scans = await scanSources(ctx, requested);
  const chosen = pickSource(scans, requested);
  const unread = unreadSources(ctx, scans);
  // Other networks that could also fund a loan are offered as an explicit switch, never implied.
  const otherFunded = scans.filter(sourceRead).filter((s) => s.chainId !== chosen.chainId && s.max >= MIN_LOAN).map((s) => ({ ...noteOf(s.chainId), maxCash: s.max }));
  return { ...planOn(chosen.inputs, chosen.chainId, input), otherFunded, unread };
}

/** The planner's figures for one network's live inputs (the pre-multi-network body). */
function planOn(inputs: LiveInputs, chainId: ChainId, input: { cash?: number; asset?: Asset; hfIdx?: 0 | 1 | 2 }): Omit<GetCashResponse, "otherFunded" | "unread"> {
  const limit = borrowLimit(inputs);
  const maxCash = limit.max;
  const network = NETWORK_OF[chainId];
  const venues = inputs.lenders.flatMap((l) => (l.venue ? [roundedVenue(l.venue)] : []));
  const holdings = M1_COLLATERAL.map((c) => c.asset).filter((a) => inputs.balances[a] > 0).map((asset) => ({ asset, balance: inputs.balances[asset], usd: inputs.balances[asset] * inputs.prices[asset] }));
  const base = { blockNumber: Number(inputs.blockNumber), readAt: inputs.readAt, maxCash, why: limitWhy(limit, SAFETY_TITLES[1]), holdings, network, chainId, networkName: CHAIN_NAME[chainId] };
  if (holdings.length === 0) return { ...base, state: "empty", chips: [], asset: null, balance: 0, levels: [], lenders: [], best: null };
  if (maxCash < MIN_LOAN) return { ...base, state: "tooLittle", chips: [], asset: null, balance: 0, levels: [], lenders: [], best: null };

  const cash = input.cash !== undefined && input.cash >= MIN_LOAN ? Math.min(input.cash, maxCash) : undefined;
  // A previous source's asset is only a preference. Never carry an asset into a network
  // where the Safe has no balance for it; choose a funded, supported asset for this source.
  const requestedAsset = input.asset && holdings.some((holding) => holding.asset === input.asset) ? input.asset : undefined;
  const asset: Asset = requestedAsset ?? defaultAsset(inputs.balances, inputs.prices, venues, cash ?? MIN_LOAN, HF_LEVELS[1], network) ?? holdings[0].asset;
  const balance = inputs.balances[asset];
  const hfIdx = input.hfIdx ?? 1;
  const out = { ...base, state: "ok" as const, chips: cashChips(maxCash), asset, balance };
  if (cash === undefined) return { ...out, levels: [], lenders: [], best: null };

  const levels: SafetyChoice[] = ([0, 1, 2] as const).map((idx) => {
    const need: Need = { asset, cash, months: 12, targetHf: HF_LEVELS[idx], network };
    const best = inputs.lenders.flatMap((f) => { const a = attempt(inputs, f, need, { cap: false }); return a.ok ? [a] : []; }).sort((a, b) => a.plan.apr - b.plan.apr)[0];
    if (best) return { idx, title: SAFETY_TITLES[idx], hf: HF_LEVELS[idx], feasible: true, collateral: best.plan.collateral, dropPct: figuresOf(best.plan).dropPct };
    // The fewest units any lender would need (collateral the plan would lock, even when the Safe lacks it).
    const needs = Math.min(...inputs.lenders.flatMap((f) => (f.venue?.markets[asset] ? [Math.ceil((cash * HF_LEVELS[idx]) / ((f.prices[asset] ?? inputs.prices[asset]) * f.venue.markets[asset]!.lt) * 100) / 100] : [])));
    return { idx, title: SAFETY_TITLES[idx], hf: HF_LEVELS[idx], feasible: false, ...(Number.isFinite(needs) ? { needs } : {}) };
  });
  const cmp = compareRows(inputs, { asset, cash, months: 12, targetHf: HF_LEVELS[hfIdx], network });
  return { ...out, levels, lenders: cmp.rows, best: cmp.cheapest };
}
