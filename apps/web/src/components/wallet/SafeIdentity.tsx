import { AddressText } from "@/components/ui/address";
import { NetworkChip } from "@/components/ui/network-mark";

/** "Your Safe 0x1234…abcd [copy] [explorer] Open in Safe  Base": which Safe, on which network. */
export function SafeIdentity({ address, chainId = 8453, label = "Your Safe", className }: { address: string; chainId?: number; label?: string; className?: string }) {
  return (
    <p className={className ?? "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"} data-testid="safe-identity">
      <AddressText address={address} chainId={chainId} label={label} showSafeApp />
      <NetworkChip id={chainId} className="border-0 bg-muted px-2 py-0.5 text-muted-foreground" />
    </p>
  );
}
