// The six Safe networks as the library names them and as the aggregator numbers them.
import type { Network, NetworkConfig } from "@/lib/types";
import type { MoveChain } from "./types";

export const MOVE_NETWORKS: NetworkConfig[] = [
  { id: "ethereum", name: "Ethereum", nativeAsset: "ETH" },
  { id: "base", name: "Base", nativeAsset: "ETH" },
  { id: "arbitrum", name: "Arbitrum", nativeAsset: "ETH" },
  { id: "optimism", name: "Optimism", nativeAsset: "ETH" },
  { id: "polygon", name: "Polygon", nativeAsset: "POL" },
  { id: "gnosis", name: "Gnosis", nativeAsset: "xDAI" },
];

const CHAIN: Record<Network, MoveChain> = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137, gnosis: 100 };
export const chainOf = (n: Network): MoveChain => CHAIN[n];
export const networkOfChain = (c: MoveChain): Network => {
  const found = (Object.entries(CHAIN) as [Network, MoveChain][]).find(([, id]) => id === c);
  if (!found) throw new Error(`Network ${c} is not supported.`);
  return found[0];
};
export const chainName = (c: MoveChain): string => MOVE_NETWORKS.find((n) => n.id === networkOfChain(c))!.name;
