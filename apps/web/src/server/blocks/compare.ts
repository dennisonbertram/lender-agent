// The compare block (BP-33): one quote set, one block number, one row per offered lender (VC-02). Each
// row comes from `attempt`, the same function the plan card uses, so a row and its plan card agree.
import { defaultAsset } from "@/lib/cash-plan";
import { MIN_LOAN, BALANCED_HF, DEFAULT_LEVELS, type HealthStatus } from "@/lib/loan-math";
import { networkName, usd } from "@/lib/format";
import type { Asset, Network } from "@/lib/types";
import { M1_NETWORKS, type LiveInputs } from "@/server/market-inputs";
import { attempt, figuresOf, planChainOf, roundedVenue, type Need } from "@/server/quote";
import { requireNetwork } from "@/server/auth/access";
import type { SafeContext } from "@/server/request";
import { NETWORK_OF, type ChainId } from "@/shared/types";
import { pickSource, scanSources, servedOwned, unreadSources, type SourceNote, type Stamp } from "./block-inputs";

export type CompareRow = {
  venueId: string;
  lender: string;
  feasible: boolean;
  /** Quoted rate in percent; null when the lender has no rate to quote (not readable). */
  apr: number | null;
  /** Interest a year on the loan, the plan card's figure. */
  yearly?: number;
  /** "Price can fall N%". */
  dropPct?: number;
  status?: HealthStatus;
  liqPrice?: number;
  collateral?: number;
  /** The plan adds to a loan the Safe already has here. */
  adding?: boolean;
  /** Infeasible rows: "Can lend up to $X against your ETH." (r33) or why not. */
  reason?: string;
  /** The most this lender can fund against the asset, when that is the reason. */
  limit?: number | null;
};

export type CompareResponse = {
  cash: number;
  asset: Asset;
  network: string;
  /** Machine-readable source used to build these rows, carried into the plan block. */
  source: Network;
  /** Owned networks that could not be read, so their balances and offers are not included. */
  unread: SourceNote[];
  /** Lowest quoted rate first; rows that cannot lend follow, muted. */
  rows: CompareRow[];
  /** Venue id of the cheapest row that can lend, if any. */
  cheapest: string | null;
} & Stamp;

/** The ranked rows for one need, from inputs already read: one block number for the whole set. */
export function compareRows(inputs: LiveInputs, need: Need): { rows: CompareRow[]; cheapest: string | null } {
  const rows: CompareRow[] = inputs.lenders.map((f) => {
    if (f.unavailable) return { venueId: f.id, lender: f.name, feasible: false, apr: f.venue ? f.venue.apr : null, reason: "Not available for this Safe yet." };
    const a = attempt(inputs, f, need, { cap: false });
    if (!a.ok) {
      const small = need.cash < MIN_LOAN ? `The smallest loan is ${usd(MIN_LOAN)}.` : undefined;
      return { venueId: f.id, lender: f.name, feasible: false, apr: f.venue ? Math.round(f.venue.apr * 100) / 100 : null, reason: small ?? a.reason, limit: a.maxCash };
    }
    const fig = figuresOf(a.plan);
    return { venueId: f.id, lender: f.name, feasible: true, apr: fig.apr, yearly: fig.yearly, dropPct: fig.dropPct, status: fig.status, liqPrice: fig.liqPrice, collateral: a.plan.collateral, adding: a.plan.scope === "added" };
  });
  const order = (r: CompareRow) => (r.feasible ? r.apr ?? 0 : Infinity);
  rows.sort((a, b) => order(a) - order(b));
  return { rows, cheapest: rows.find((r) => r.feasible)?.venueId ?? null };
}

type Ctx = Pick<SafeContext, "services" | "safe" | "access">;

export async function compareFor(ctx: Ctx, input: { cash: number; asset?: Asset; network?: Network }): Promise<CompareResponse> {
  const requested = input.network !== undefined ? planChainOf(input) : undefined;
  if (requested !== undefined) requireNetwork(ctx.access, requested);
  if (!servedOwned(ctx).length) requireNetwork(ctx.access, requested ?? 8453);
  const scans = await scanSources(ctx, requested);
  const { inputs } = pickSource(scans, requested);
  const chainId: ChainId = inputs.chainId;
  const network: Network = NETWORK_OF[chainId];
  const targetHf = BALANCED_HF;
  const venues = inputs.lenders.flatMap((l) => (l.venue ? [roundedVenue(l.venue)] : []));
  const asset: Asset = input.asset ?? defaultAsset(inputs.balances, inputs.prices, venues, input.cash, targetHf, network) ?? "ETH";
  const need: Need = { asset, cash: input.cash, months: 12, targetHf, network };
  const { rows, cheapest } = compareRows(inputs, need);
  return {
    cash: input.cash, asset, network: networkName(network, M1_NETWORKS), source: network,
    unread: unreadSources(ctx, scans),
    rows, cheapest,
    blockNumber: Number(inputs.blockNumber), readAt: inputs.readAt,
  };
}
