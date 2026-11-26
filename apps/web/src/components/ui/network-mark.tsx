import { cn } from "@/lib/utils";

type NetworkId = string | number;

const networkDetails = (id: NetworkId) => {
  const key = String(id).trim().toLowerCase();
  if (key === "1" || key === "ethereum") return { label: "Ethereum", mark: "/network-marks/ethereum.svg" };
  if (key === "8453" || key === "base") return { label: "Base", mark: "/network-marks/base.svg" };
  if (key === "84532" || key === "base sepolia" || key === "base sepolia (test)") return { label: key.endsWith("(test)") ? "Base Sepolia (test)" : "Base Sepolia", mark: "/network-marks/base.svg" };
  if (key === "42161" || key === "arbitrum" || key === "arbitrum one") return { label: key === "arbitrum one" ? "Arbitrum One" : "Arbitrum", mark: "/network-marks/arbitrum-one.svg" };
  if (key === "10" || key === "optimism") return { label: "Optimism", mark: "/network-marks/optimism.svg" };
  if (key === "137" || key === "polygon") return { label: "Polygon", mark: "/network-marks/polygon.svg" };
  if (key === "100" || key === "gnosis") return { label: "Gnosis", mark: "/network-marks/gnosis.svg" };
  if (/^\d+$/.test(key)) return { label: `Chain ${key}`, mark: undefined };
  return { label: String(id).trim() || "Unknown network", mark: undefined };
};

/** A decorative local network logo. The adjacent network name remains the accessible label. */
export function NetworkMark({ id, className }: { id: NetworkId; className?: string }) {
  const { mark } = networkDetails(id);
  return mark ? <img src={mark} alt="" aria-hidden="true" className={cn("size-4 shrink-0 object-contain", className)} /> : null;
}

export const networkDisplayName = (id: NetworkId) => networkDetails(id).label;

/** A network name with its decorative mark where the network is supported. */
export function NetworkChip({ id, className }: { id: NetworkId; className?: string }) {
  return <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground", className)}><NetworkMark id={id} className="size-3.5" />{networkDisplayName(id)}</span>;
}
