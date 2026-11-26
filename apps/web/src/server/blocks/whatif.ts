// The what-if block (BP-33): each loan's health and status if the collateral price falls. Every figure
// is made here and sent for each step of the slider, so the page computes nothing (G1). Health starts
// from the lender's own number, as the dashboard does (VC-02).
import { BALANCED_HF, DEFAULT_LEVELS, hfAfterDrop, healthStatus, type HealthStatus, type Levels } from "@/lib/loan-math";
import { WHATIF_DROPS } from "@/lib/whatif-drop";
import { defaultAsset } from "@/lib/cash-plan";
import type { Asset, Network } from "@/lib/types";
import { levelsByLoan } from "@/server/levels";
import { borrowLimit } from "@/server/market-inputs";
import { attempt, figuresOf, figuresOfLoan, planChainOf, roundedVenue } from "@/server/quote";
import { requireNetwork } from "@/server/auth/access";
import type { SafeContext } from "@/server/request";
import { CHAIN_NAME, NETWORK_OF, type ChainId } from "@/shared/types";
import { pickSource, scanSources, servedOwned, sourceRead, unreadSources, type SourceNote, type Stamp } from "./block-inputs";

export { WHATIF_DROPS };

/** `price`: the asset's price after this fall, to the dollar (VC-08). */
export type WhatIfStep = { drop: number; hf: number; status: HealthStatus; price: number };
export type WhatIfLoan = { id: string; lender: string; venueId: string; chainId: ChainId; network: Network; collAsset: Asset; /** Does the fall of `asset` move this loan's collateral? */ moves: boolean; steps: WhatIfStep[] };
export type WhatIfHypothetical = { cash: number; lender: string; venueId: string; liqPrice: number; steps: WhatIfStep[] } | null;
export type WhatIfResponse = {
  asset: Asset;
  /** The collateral price now: the slider shows it and the price after the fall. */
  price: number;
  loans: WhatIfLoan[];
  /** With no loans: a loan of `cash` at Balanced on the cheapest lender (null when the Safe cannot fund one). */
  hypothetical: WhatIfHypothetical;
  cash: number;
  /** Source selected for the hypothetical amount and price at the top of the card. */
  chainId: ChainId;
  network: Network;
  /** Owned networks that could not be read, so their loans are not included. */
  unread: SourceNote[];
} & Stamp;

/** ETH and wstETH move together; WBTC alone. */
const group = (a: Asset) => (a === "WBTC" ? "WBTC" : "ETH");

type Ctx = Pick<SafeContext, "services" | "safe" | "access"> & { db?: SafeContext["db"] };

export async function whatIfFor(ctx: Ctx, input: { asset?: Asset; cash?: number; network?: Network } = {}): Promise<WhatIfResponse> {
  const requested = input.network !== undefined ? planChainOf(input) : undefined;
  if (requested !== undefined) requireNetwork(ctx.access, requested);
  if (!servedOwned(ctx).length) requireNetwork(ctx.access, requested ?? 8453);
  const scans = await scanSources(ctx, requested);
  const { inputs } = pickSource(scans, requested);
  const chainId: ChainId = inputs.chainId;
  const readable = scans.filter(sourceRead);
  const saved = ctx.db ? await levelsByLoan(ctx.db, ctx.safe.id) : new Map<string, Levels>();
  // No amount asked: use the most this Safe can borrow (the greeting's number), not a made-up figure.
  const cash = input.cash ?? borrowLimit(inputs).max;
  // A no-network what-if covers every readable loan owned by this Safe. The funded plan source
  // may be Arbitrum while an existing position that needs monitoring remains on Base.
  const loanSources = (requested === undefined ? readable : readable.filter((s) => s.chainId === requested))
    .flatMap((s) => s.inputs.lenders.flatMap((lender) => lender.loan && lender.loan.debt > 0
      ? [{ loan: lender.loan, lender, inputs: s.inputs, chainId: s.chainId }]
      : []));
  const loans = loanSources.map((s) => s.loan);
  const asset: Asset = input.asset ?? loans[0]?.collAsset ?? defaultAsset(inputs.balances, inputs.prices, inputs.lenders.flatMap((l) => (l.venue ? [roundedVenue(l.venue)] : [])), cash, BALANCED_HF, NETWORK_OF[chainId]) ?? "ETH";

  const priceAfter = (d: number) => Math.round(inputs.prices[asset] * (1 - d / 100));
  const rows: WhatIfLoan[] = loanSources.flatMap(({ loan: loanInput, lender, inputs: loanInputs, chainId: loanChainId }) => {
    if (loanInput.debt <= 0) return [];
    const loan = { ...loanInput };
    const price = lender.prices[loan.collAsset] ?? loanInputs.prices[loan.collAsset];
    const own = lender.id === "aave-v3" ? loanInputs.position?.healthFactor : lender.position?.health;
    const fig = figuresOfLoan(loan, price, { health: own });
    const levels = saved.get(loan.id.toLowerCase()) ?? DEFAULT_LEVELS;
    const moves = group(loan.collAsset) === group(asset);
    const steps = WHATIF_DROPS.map((d) => {
      const hf = moves ? hfAfterDrop(fig.hf, d / 100) : fig.hf;
      return { drop: d, hf, status: healthStatus(hf, levels.warn, levels.act), price: moves ? Math.round(price * (1 - d / 100)) : price };
    });
    return [{ id: loan.id, lender: lender.name, venueId: lender.id, chainId: loanChainId, network: NETWORK_OF[loanChainId], collAsset: loan.collAsset, moves, steps }];
  });

  let hypothetical: WhatIfHypothetical = null;
  if (loanSources.length === 0) {
    const best = inputs.lenders
      .map((f) => attempt(inputs, f, { asset, cash, months: 12, targetHf: BALANCED_HF, network: inputs.network }, { cap: false }))
      .flatMap((a) => (a.ok ? [a] : []))
      .sort((a, b) => a.plan.apr - b.plan.apr)[0];
    if (best) {
      const fig = figuresOf(best.plan);
      hypothetical = {
        cash, lender: best.facts.name, venueId: best.facts.id, liqPrice: fig.liqPrice,
        steps: WHATIF_DROPS.map((d) => { const hf = hfAfterDrop(fig.hf, d / 100); return { drop: d, hf, status: healthStatus(hf, DEFAULT_LEVELS.warn, DEFAULT_LEVELS.act), price: priceAfter(d) }; }),
      };
    }
  }
  const unread = unreadSources(ctx, scans);
  return { asset, price: inputs.prices[asset], loans: rows, hypothetical, cash, chainId, network: NETWORK_OF[chainId], unread, blockNumber: Number(inputs.blockNumber), readAt: inputs.readAt };
}
