"use client";
import { AddressText } from "@/components/ui/address";
import { servedChainOf } from "@/lib/networks";
import { cn } from "@/lib/utils";
import { NetworkChip } from "@/components/ui/network-mark";
import type { Network, Safe } from "@/lib/types";

/**
 * The Safe's address (copy, explorer, Safe app) and the networks it is set up on, under a page title.
 * `chainId` names the one network being looked at (the sidebar) instead of listing every deployed one;
 * `compact` is the small form for the sidebar.
 */
export function SafeIdentity({ safe, chainId: only, compact, className }: { safe: Pick<Safe, "address" | "networks">; chainId?: number; compact?: boolean; className?: string }) {
  const chains: (Network | number)[] = only !== undefined ? [only] : safe.networks.filter((n) => n.deployed).map((n) => n.id);
  const chainId = only ?? chains.map((network) => typeof network === "number" ? network : servedChainOf(network)).find((id): id is number => id !== null && id !== undefined);
  const test = only === 84532;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", compact ? "-mt-1 gap-x-2 px-1 text-xs" : "text-sm", className)} data-testid="safe-identity">
      {chains.length > 0 && (
        <span className="flex flex-wrap gap-1">{chains.map((c) => <NetworkChip key={c} id={c} className={cn("px-2", compact && "py-0", (test || c === 84532) && "border-warning-text/40 text-warning-text")} />)}</span>
      )}
      <AddressText address={safe.address} chainId={chainId} showSafeApp label={compact ? undefined : "Safe"} />
    </div>
  );
}
