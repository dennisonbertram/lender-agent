export type Asset = "ETH" | "wstETH" | "WBTC";
export type Stable = "USDC" | "DAI";
export type Network = "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "gnosis";

export type Amounts = Record<Asset | Stable, number>;
export type PriceMap = Record<Asset | Stable, number>;
export type NetworkConfig = { id: Network; name: string; short?: string; nativeAsset?: string };
export type SafeNetwork = { id: Network; deployed: boolean; agent: boolean };
export type Safe = {
  id: string;
  name: string;
  address: string;
  threshold: string;
  agent: boolean;
  networks: SafeNetwork[];
  balances: Partial<Record<Network, Amounts>>;
};
export type Loan = {
  id: string;
  safeId: string;
  network: Network;
  venue: string;
  collAsset: Asset;
  collAmount: number;
  debtAsset: Stable;
  debt: number;
  lt: number;
  apr: number;
  accrued: number;
};
export type Venue = {
  id: string;
  name: string;
  borrowAsset: Stable;
  apr: number;
  liquidity: number;
  networks: Network[];
  markets: Partial<Record<Asset, { maxLtv: number; lt: number }>>;
};
export type Actor = "Agent" | "Agent (reserve)" | "You" | "Co-signer";
export type ActivityKind = "read" | "proposed" | "status" | "signed" | "reserve";
export type ActivityEvent = { id: string; safeId: string; at: number; actor: Actor; kind: ActivityKind; text: string; detail?: string };
export type Rule = { id: string; text: string; on: boolean };
export type View =
  | { name: "onboarding" }
  | { name: "loan"; id: string }
  | { name: "offers"; asset?: Asset; network?: Network; amount?: number; borrow?: number }
  | { name: "cash"; amount?: number; step?: number; asset?: Asset; network?: Network; venueId?: string; collateral?: number; from?: "offers" }
  | { name: "activity" }
  | { name: "settings" }
  | { name: "reserve" }
  | { name: "home" }
  | { name: "chat" };
