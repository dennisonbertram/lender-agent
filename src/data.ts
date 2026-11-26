// All numbers in this file are fixed sample data.
import { DEFAULT_LEVELS, healthFactor } from "@/lib/loan-math";

export type Asset = "ETH" | "wstETH" | "WBTC";
export type Stable = "USDC" | "DAI";

export const BASE_PRICES: Record<Asset | Stable, number> = {
  ETH: 2745,
  wstETH: 3210,
  WBTC: 74900,
  USDC: 1,
  DAI: 1,
};
// ponytail: mutable module-level prices so the "simulate price drop" demo control reaches every screen; reset restores BASE_PRICES.
export const PRICES = { ...BASE_PRICES };

export const BALANCES: Record<Asset | Stable, number> = {  // Treasury, on Ethereum
  ETH: 8,
  wstETH: 6,
  WBTC: 0.5,
  USDC: 45000,
  DAI: 40000,
};

export type Network = "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "gnosis";
/** Sample cost of deploying a Safe on a network, paid inside its first transaction there. We sponsor it (a proposal, budget TBD), so users see "free". */
export const NETWORKS: { id: Network; name: string; short: string; nativeAsset: string; deployFeeUsd: number }[] = [
  { id: "ethereum", name: "Ethereum", short: "ETH", nativeAsset: "ETH", deployFeeUsd: 18 },
  { id: "base", name: "Base", short: "Base", nativeAsset: "ETH", deployFeeUsd: 0.08 },
  { id: "arbitrum", name: "Arbitrum", short: "Arb", nativeAsset: "ETH", deployFeeUsd: 0.15 },
  { id: "optimism", name: "Optimism", short: "OP", nativeAsset: "ETH", deployFeeUsd: 0.1 },
  { id: "polygon", name: "Polygon", short: "Poly", nativeAsset: "POL", deployFeeUsd: 0.05 },
  { id: "gnosis", name: "Gnosis", short: "Gnosis", nativeAsset: "xDAI", deployFeeUsd: 0.4 },
];
export const networkName = (id: Network) => NETWORKS.find((n) => n.id === id)!.name;
export const USER_FULL = "0x7be2a91c4d05f3e8b6a7c1d92e04f58a3b6cc41a";

export type Amounts = Record<Asset | Stable, number>;
export type SafeNetwork = { id: Network; deployed: boolean; agent: boolean };
export type Safe = {
  id: string;
  name: string;
  /** One address, the same on every network. */
  address: string;
  threshold: string;
  /** Derived from `networks`: the Lender agent is a proposer on at least one network. Change it only through lib/networks. */
  agent: boolean;
  networks: SafeNetwork[];
  balances: Partial<Record<Network, Amounts>>;
};
export const ZERO_BALANCES: Amounts = { ETH: 0, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0 };
export const TREASURY: Safe = {
  id: "treasury", name: "Treasury Safe", address: "0x4a1c6b7e0d2f93a58c1b4e7d90a3f6c2b85e9e2f",
  threshold: "2 of 3", agent: false,
  networks: [{ id: "ethereum", deployed: true, agent: false }, { id: "base", deployed: true, agent: false }],
  balances: { ethereum: BALANCES, base: { ...ZERO_BALANCES, USDC: 2000 } },
};
export const RESERVE = { name: "Reserve Safe", address: "0xC3d8…51bE", threshold: "1 of 1" };
export const RESERVE_BALANCES: Record<Asset | Stable, number> = { ETH: 5, wstETH: 0, WBTC: 0, USDC: 15000, DAI: 10000 };
export const RESERVE_POLICY = { armed: true, emergencyHF: 1.1, dailyCapUsd: 15000, usedUsd24h: 0 };
export const USER = { name: "Ada", address: "0x7be2…c41A" };
export const AGENT_ADDRESS = "0xA9e1…7d30";

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
  /** Shape of the 30-day history; the last point is always the live value. */
  trend?: { start: number; wave: number };
};

export const SAMPLE_LOANS: Loan[] = [
  { id: "aave", safeId: "treasury", network: "ethereum", venue: "Aave v3", collAsset: "wstETH", collAmount: 14.5, debtAsset: "USDC", debt: 18000, lt: 0.81, apr: 3.4, accrued: 214.6, trend: { start: 2.35, wave: 0.05 } },
  { id: "morpho", safeId: "treasury", network: "ethereum", venue: "Morpho Blue", collAsset: "WBTC", collAmount: 0.9, debtAsset: "USDC", debt: 40000, lt: 0.86, apr: 3.2, accrued: 506.3, trend: { start: 1.72, wave: 0.06 } },
  { id: "spark", safeId: "treasury", network: "ethereum", venue: "Spark", collAsset: "ETH", collAmount: 20, debtAsset: "DAI", debt: 38000, lt: 0.82, apr: 3.9, accrued: 388.1, trend: { start: 1.62, wave: 0.04 } },
];

export const loanHF = (l: Loan) => healthFactor(l.collAmount * PRICES[l.collAsset], l.lt, l.debt);

export const THRESHOLDS: Record<string, { warn: number; act: number }> = Object.fromEntries(SAMPLE_LOANS.map((l) => [l.id, { ...DEFAULT_LEVELS }]));

export type Venue = {
  id: string;
  name: string;
  borrowAsset: Stable;
  apr: number;
  liquidity: number; // millions
  /** Networks where this lender is available (sample data). */
  networks: Network[];
  markets: Partial<Record<Asset, { maxLtv: number; lt: number }>>;
};

export const VENUES: Venue[] = [
  { id: "aave", name: "Aave v3", borrowAsset: "USDC", apr: 3.4, liquidity: 412, networks: ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"], markets: { ETH: { maxLtv: 0.805, lt: 0.83 }, wstETH: { maxLtv: 0.785, lt: 0.81 }, WBTC: { maxLtv: 0.73, lt: 0.78 } } },
  { id: "morpho", name: "Morpho Blue", borrowAsset: "USDC", apr: 2.9, liquidity: 38, networks: ["ethereum", "base"], markets: { ETH: { maxLtv: 0.86, lt: 0.86 }, wstETH: { maxLtv: 0.86, lt: 0.86 }, WBTC: { maxLtv: 0.86, lt: 0.86 } } },
  { id: "spark", name: "Spark", borrowAsset: "DAI", apr: 3.9, liquidity: 120, networks: ["ethereum", "gnosis"], markets: { ETH: { maxLtv: 0.8, lt: 0.82 }, wstETH: { maxLtv: 0.79, lt: 0.82 }, WBTC: { maxLtv: 0.7, lt: 0.75 } } },
  { id: "compound", name: "Compound v3", borrowAsset: "USDC", apr: 3.7, liquidity: 205, networks: ["ethereum"], markets: { ETH: { maxLtv: 0.83, lt: 0.9 }, wstETH: { maxLtv: 0.82, lt: 0.88 }, WBTC: { maxLtv: 0.7, lt: 0.77 } } },
];

export type Actor = "Agent" | "Agent (reserve)" | "You" | "Co-signer";
export type ActivityKind = "read" | "proposed" | "status" | "signed" | "reserve";
export type ActivityEvent = { id: string; safeId: string; time?: string; at?: number; actor: Actor; kind: ActivityKind; text: string; detail?: string };

export const SAMPLE_ACTIVITY: ActivityEvent[] = [
  { id: "s1", safeId: "treasury", time: "Today 09:41", actor: "Agent", kind: "status", text: "Spark health 1.18 crossed your 1.35 At-risk level" },
  { id: "s2", safeId: "treasury", time: "Today 09:40", actor: "Agent", kind: "read", text: "Read prices and positions for 3 loans" },
  { id: "s3b", safeId: "treasury", time: "Today 05:31", actor: "You", kind: "signed", text: "Signed: Protect Morpho Blue loan" },
  { id: "s3a", safeId: "treasury", time: "Today 05:20", actor: "Agent", kind: "proposed", text: "Sent to Safe for signatures: Protect Morpho Blue loan" },
  { id: "s3", safeId: "treasury", time: "Today 05:12", actor: "Agent", kind: "status", text: "Morpho health 1.45 crossed your 1.6 Watch level" },
  { id: "s4", safeId: "treasury", time: "Yesterday 17:30", actor: "Co-signer", kind: "signed", text: "Signed: repay 2,000 USDC on Aave v3" },
  { id: "s5", safeId: "treasury", time: "Yesterday 17:05", actor: "You", kind: "signed", text: "Signed: repay 2,000 USDC on Aave v3" },
  { id: "s6", safeId: "treasury", time: "Yesterday 16:58", actor: "Agent", kind: "proposed", text: "Sent to Safe: repay 2,000 USDC on Aave v3" },
  { id: "s7", safeId: "treasury", time: "Mon 11:20", actor: "You", kind: "status", text: "Added Lender agent to this Safe" },
  { id: "s8", safeId: "treasury", time: "Mon 11:19", actor: "Agent", kind: "read", text: "Read Treasury Safe balances" },
];

export type Rule = { id: string; text: string; on: boolean };
export const RULES: Rule[] = [
  { id: "r1", text: "If health falls below my At-risk level, draft a repay from the Safe's stablecoins", on: false },
];

export const fmt = (n: number, d = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const usd = (n: number, d = 0) => `$${fmt(n, d)}`;
