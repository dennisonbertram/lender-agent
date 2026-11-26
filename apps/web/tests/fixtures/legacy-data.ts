// All numbers in this file are fixed sample data.
import { DEFAULT_LEVELS } from "@/lib/loan-math";
import type { ActivityEvent, Amounts, Asset, Loan, Network, NetworkConfig, Rule, Safe, SafeNetwork, Stable, Venue } from "@/lib/types";
export type { ActivityEvent, Amounts, Asset, Loan, Network, Safe, SafeNetwork, Stable, Venue } from "@/lib/types";

export const BASE_PRICES: Record<Asset | Stable, number> = {
  ETH: 2745,
  wstETH: 3210,
  WBTC: 74900,
  USDC: 1,
  DAI: 1,
};
export const BALANCES: Amounts = {  // Treasury, on Ethereum
  ETH: 8,
  wstETH: 6,
  WBTC: 0.5,
  USDC: 45000,
  DAI: 40000,
};

/** Sample cost of deploying a Safe on a network, paid inside its first transaction there. We sponsor it (a proposal, budget TBD), so users see "free". */
export const NETWORKS: (NetworkConfig & { deployFeeUsd: number })[] = [
  { id: "ethereum", name: "Ethereum", short: "ETH", nativeAsset: "ETH", deployFeeUsd: 18 },
  { id: "base", name: "Base", short: "Base", nativeAsset: "ETH", deployFeeUsd: 0.08 },
  { id: "arbitrum", name: "Arbitrum", short: "Arb", nativeAsset: "ETH", deployFeeUsd: 0.15 },
  { id: "optimism", name: "Optimism", short: "OP", nativeAsset: "ETH", deployFeeUsd: 0.1 },
  { id: "polygon", name: "Polygon", short: "Poly", nativeAsset: "POL", deployFeeUsd: 0.05 },
  { id: "gnosis", name: "Gnosis", short: "Gnosis", nativeAsset: "xDAI", deployFeeUsd: 0.4 },
];
export const USER_FULL = "0x7be2a91c4d05f3e8b6a7c1d92e04f58a3b6cc41a";
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

export const SAMPLE_LOANS: Loan[] = [
  { id: "aave", safeId: "treasury", network: "ethereum", venue: "Aave v3", collAsset: "wstETH", collAmount: 14.5, debtAsset: "USDC", debt: 18000, lt: 0.81, apr: 3.4, accrued: 214.6 },
  { id: "morpho", safeId: "treasury", network: "ethereum", venue: "Morpho Blue", collAsset: "WBTC", collAmount: 0.9, debtAsset: "USDC", debt: 40000, lt: 0.86, apr: 3.2, accrued: 506.3 },
  { id: "spark", safeId: "treasury", network: "ethereum", venue: "Spark", collAsset: "ETH", collAmount: 20, debtAsset: "DAI", debt: 38000, lt: 0.82, apr: 3.9, accrued: 388.1 },
];

export const THRESHOLDS: Record<string, { warn: number; act: number }> = Object.fromEntries(SAMPLE_LOANS.map((l) => [l.id, { ...DEFAULT_LEVELS }]));

export const VENUES: Venue[] = [
  { id: "aave", name: "Aave v3", borrowAsset: "USDC", apr: 3.4, liquidity: 412, networks: ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"], markets: { ETH: { maxLtv: 0.805, lt: 0.83 }, wstETH: { maxLtv: 0.785, lt: 0.81 }, WBTC: { maxLtv: 0.73, lt: 0.78 } } },
  { id: "morpho", name: "Morpho Blue", borrowAsset: "USDC", apr: 2.9, liquidity: 38, networks: ["ethereum", "base"], markets: { ETH: { maxLtv: 0.86, lt: 0.86 }, wstETH: { maxLtv: 0.86, lt: 0.86 }, WBTC: { maxLtv: 0.86, lt: 0.86 } } },
  { id: "spark", name: "Spark", borrowAsset: "DAI", apr: 3.9, liquidity: 120, networks: ["ethereum", "gnosis"], markets: { ETH: { maxLtv: 0.8, lt: 0.82 }, wstETH: { maxLtv: 0.79, lt: 0.82 }, WBTC: { maxLtv: 0.7, lt: 0.75 } } },
  { id: "compound", name: "Compound v3", borrowAsset: "USDC", apr: 3.7, liquidity: 205, networks: ["ethereum"], markets: { ETH: { maxLtv: 0.83, lt: 0.9 }, wstETH: { maxLtv: 0.82, lt: 0.88 }, WBTC: { maxLtv: 0.7, lt: 0.77 } } },
];

const activityAt = (day: number, hour: number, minute: number) => new Date(2026, 0, day, hour, minute).getTime();

export const SAMPLE_ACTIVITY: ActivityEvent[] = [
  { id: "s1", safeId: "treasury", at: activityAt(5, 9, 41), actor: "Agent", kind: "status", text: "Spark health 1.18 crossed your 1.35 At-risk level" },
  { id: "s2", safeId: "treasury", at: activityAt(5, 9, 40), actor: "Agent", kind: "read", text: "Read prices and positions for 3 loans" },
  { id: "s3b", safeId: "treasury", at: activityAt(5, 5, 31), actor: "You", kind: "signed", text: "Signed: Protect Morpho Blue loan" },
  { id: "s3a", safeId: "treasury", at: activityAt(5, 5, 20), actor: "Agent", kind: "proposed", text: "Sent to Safe for signatures: Protect Morpho Blue loan" },
  { id: "s3", safeId: "treasury", at: activityAt(5, 5, 12), actor: "Agent", kind: "status", text: "Morpho health 1.45 crossed your 1.6 Watch level" },
  { id: "s4", safeId: "treasury", at: activityAt(4, 17, 30), actor: "Co-signer", kind: "signed", text: "Signed: repay 2,000 USDC on Aave v3" },
  { id: "s5", safeId: "treasury", at: activityAt(4, 17, 5), actor: "You", kind: "signed", text: "Signed: repay 2,000 USDC on Aave v3" },
  { id: "s6", safeId: "treasury", at: activityAt(4, 16, 58), actor: "Agent", kind: "proposed", text: "Sent to Safe: repay 2,000 USDC on Aave v3" },
  { id: "s7", safeId: "treasury", at: activityAt(5, 11, 20), actor: "You", kind: "status", text: "Added Lender agent to this Safe" },
  { id: "s8", safeId: "treasury", at: activityAt(5, 11, 19), actor: "Agent", kind: "read", text: "Read Treasury Safe balances" },
];

export const RULES: Rule[] = [
  { id: "r1", text: "If health falls below my At-risk level, draft a repay from the Safe's stablecoins", on: false },
];

export const TEST_PROPOSAL_INPUTS = { prices: BASE_PRICES, venues: VENUES, networks: NETWORKS, feeEstimateUsd: 11 };
