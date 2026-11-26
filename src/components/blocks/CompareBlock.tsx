import { PRICES, VENUES, networkName, usd } from "@/data";
import { lenderLimit, plansAcross, resolveHolding } from "@/lib/cash-plan";
import { balancesOn, lendersFor } from "@/lib/networks";
import { DEFAULT_LEVELS, MIN_LOAN, healthStatus } from "@/lib/loan-math";
import type { UIBlock } from "@/lib/blocks";
import { useApp } from "@/store";
import { StatusPill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { blockCard } from "./card";

export function CompareBlock({ block }: { block: Extract<UIBlock, { kind: "compare" }> }) {
  const { safe, loans, postBlock } = useApp();
  const { asset, network } = resolveHolding(safe, PRICES, block.cash, DEFAULT_LEVELS.warn, { asset: block.asset, network: block.network });
  const netName = networkName(network);
  const plans = plansAcross(safe, { cash: block.cash, months: 12, targetHf: DEFAULT_LEVELS.warn, asset, network }, PRICES, VENUES, loans);
  const unreachable = VENUES.filter((v) => !lendersFor(safe, network).includes(v));
  const needsMove = (p: (typeof plans)[number]) => p.move && `Needs a move from ${networkName(p.move.from)} (about ${usd(p.move.feeUsd)}).`;
  const reason = (p: (typeof plans)[number]) =>
    !p.venue.markets[asset] ? `Not available against ${asset}.` : block.cash < MIN_LOAN ? `The smallest loan is ${usd(MIN_LOAN)}.` : `Can lend up to ${usd(lenderLimit(p.venue, asset, balancesOn(safe, network)[asset], PRICES[asset], DEFAULT_LEVELS.warn)!)} against your ${asset}.`;
  return (
    <div className={blockCard}>
      <p className="font-medium">{usd(block.cash)} against your {asset} on {netName}, Balanced safety</p>
      <ul className="flex flex-col gap-3">
        {plans.map((p) => (
          <li key={p.venue.id} className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", !p.feasible && "text-muted-foreground")}>
            <div className="min-w-0">
              <div className="font-medium">{p.venue.name} <span className="font-normal">· {p.apr}%{p.move && ` · on ${networkName(p.network)}`}</span></div>
              {p.feasible ? (
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>About {usd(p.yearly)} a year</span>
                  <span>Price can fall {p.dropPct}%</span>
                  <StatusPill s={healthStatus(p.hf, DEFAULT_LEVELS.warn, DEFAULT_LEVELS.act)} />
                </div>
              ) : <div className="text-xs">{reason(p)}</div>}
              {p.feasible && p.move && <div className="text-xs text-muted-foreground">{needsMove(p)}</div>}
            </div>
            {p.feasible && <Button size="sm" variant="outline" onClick={() => postBlock({ kind: "plan", cash: block.cash, asset, network, venueId: p.venue.id })}>Use</Button>}
          </li>
        ))}
        {unreachable.map((v) => <li key={v.id} className="text-muted-foreground"><div className="font-medium">{v.name}</div><div className="text-xs">Not on any of this Safe's networks.</div></li>)}
      </ul>
    </div>
  );
}
