// Create-Safe constants and copy shared by the server and the UI (BP-29, BP-30, M0-5, D-03).
// Pure: no I/O. The sponsorship budget lives here as constants; env overrides are read by the server.

/** The six networks where M0-5 verified one address for one setup. Offer "same address" on these only. */
export const SAFE_NETWORKS = [
  { chainId: 1, name: "Ethereum" },
  { chainId: 8453, name: "Base" },
  { chainId: 42161, name: "Arbitrum" },
  { chainId: 10, name: "Optimism" },
  { chainId: 137, name: "Polygon" },
  { chainId: 100, name: "Gnosis" },
] as const;

/** Networks where the app creates a Safe. The address is the same on all six (M0-5); lending is on SERVED_CHAIN_IDS only. */
export const ENABLED_CHAIN_IDS: number[] = SAFE_NETWORKS.map((n) => n.chainId);

/** The network checked by default when creating a Safe. */
export const DEFAULT_CREATE_CHAIN_IDS: number[] = [8453];

/**
 * Networks the app reads and lends on, and where an existing Safe can be added (BP-35). A network joins this list by
 * configuration once its lender adapter suite passes on that network's fork (milestones M4). Arbitrum: Aave v3.
 */
export const SERVED_CHAIN_IDS: number[] = [8453, 42161];

export const SAFE_CHAIN_IDS: number[] = SAFE_NETWORKS.map((n) => n.chainId);

export const isSafeNetwork = (chainId: number) => SAFE_CHAIN_IDS.includes(chainId);
export const safeNetworkName = (chainId: number) => SAFE_NETWORKS.find((n) => n.chainId === chainId)?.name ?? `network ${chainId}`;

/**
 * D-03 sponsorship budget. Deployments sponsored per Safe and per UTC day, across all users.
 * Ethereum is not in the sponsored list: its fee varies by 300x (M0-5), so the user pays it.
 * A budget of zero turns sponsorship off.
 */
export const SPONSORSHIP = {
  perSafeDeployments: 2,
  /** Sponsored deployments one creator wallet can use over all its Safes (a wallet can make many by salt index). */
  perCreatorDeployments: 3,
  dailyDeployments: 100,
  /** Refuse to sponsor a deployment whose gas estimate is above this, in wei of the network's native token (0.002). */
  maxCostWei: 2_000_000_000_000_000n,
  /** Cap on the cost (actual, or the estimate while in flight) of all sponsored deployments per UTC day, in wei (0.1). */
  dailySpendWei: 100_000_000_000_000_000n,
  sponsoredChains: [8453, 42161, 10, 137, 100] as number[],
} as const;

export type SponsorshipBudget = { perSafe: number; perCreator: number; daily: number; maxCostWei: bigint; dailySpendWei: bigint; chains: number[] };

/**
 * Most owners on a new Safe. Setup gas and calldata grow with every owner, and we may be paying for it;
 * ten is far beyond any real team and keeps one sponsored slot's cost bounded.
 */
export const MAX_OWNERS = 10;

export const DEFAULT_BUDGET: SponsorshipBudget = {
  perSafe: SPONSORSHIP.perSafeDeployments,
  perCreator: SPONSORSHIP.perCreatorDeployments,
  maxCostWei: SPONSORSHIP.maxCostWei,
  dailySpendWei: SPONSORSHIP.dailySpendWei,
  daily: SPONSORSHIP.dailyDeployments,
  chains: [...SPONSORSHIP.sponsoredChains],
};

export type SponsorshipDecision =
  | { sponsored: true }
  | { sponsored: false; reason: "network_not_sponsored" | "safe_limit" | "creator_limit" | "daily_limit" | "cost_too_high" | "daily_spend_limit" | "budget_off" | "relayer_unavailable" };

/**
 * Is this deployment paid for by us? The counts are sponsored deployments so far; `dailySpentWei` is the
 * day's cost so far and `estimateWei` this deployment's estimated cost (omit both to skip the cost checks).
 */
export function decideSponsorship(p: { chainId: number; budget: SponsorshipBudget; perSafeUsed: number; perCreatorUsed?: number; dailyUsed: number; dailySpentWei?: bigint; estimateWei?: bigint }): SponsorshipDecision {
  if (p.budget.perSafe <= 0 || p.budget.daily <= 0 || p.budget.perCreator <= 0) return { sponsored: false, reason: "budget_off" };
  if (!p.budget.chains.includes(p.chainId)) return { sponsored: false, reason: "network_not_sponsored" };
  if (p.perSafeUsed >= p.budget.perSafe) return { sponsored: false, reason: "safe_limit" };
  if ((p.perCreatorUsed ?? 0) >= p.budget.perCreator) return { sponsored: false, reason: "creator_limit" };
  if (p.dailyUsed >= p.budget.daily) return { sponsored: false, reason: "daily_limit" };
  if (p.estimateWei !== undefined && p.estimateWei > p.budget.maxCostWei) return { sponsored: false, reason: "cost_too_high" };
  if ((p.dailySpentWei ?? 0n) + (p.estimateWei ?? 0n) > p.budget.dailySpendWei) return { sponsored: false, reason: "daily_spend_limit" };
  return { sponsored: true };
}

/** Deployment uses 282,719 gas (M0-5). Fee estimates at the 2026-11-13 snapshot, in words, never a promise. */
export const SETUP_GAS = 282_719;
const FEE_ESTIMATE: Record<number, string> = {
  1: "about $0.05 at today's gas price, but it can reach about $5 to $16 when gas is busy",
  8453: "less than $0.02",
  42161: "less than $0.02",
  10: "less than $0.02",
  137: "less than $0.02",
  100: "less than $0.01",
};
/** Said on Review when a chosen network is not one the app lends on. */
export const NOT_SERVED_LINE = "Loans are on Base and Arbitrum today. On other networks your Safe can hold funds, and the agent can help move them.";
export const setupFeeEstimate = (chainId: number) => FEE_ESTIMATE[chainId] ?? "a small amount of gas";

/** The one sentence the app says about setup cost. It says "free" only when we pay (r31). */
export function setupCostLine(chainId: number, d: SponsorshipDecision): string {
  const net = safeNetworkName(chainId);
  if (d.sponsored) return `Setup on ${net} is free: we pay the one-time setup fee.`;
  return `Setting up your Safe on ${net} costs a one-time network fee of ${setupFeeEstimate(chainId)}. You pay it from your wallet.`;
}

/** D-06: a network deployed later starts from the original owners. Null when nothing differs. */
export function ownersChangedWarning(setupOwners: string[], setupThreshold: number, currentOwners: string[], currentThreshold: number): string | null {
  const a = setupOwners.map((o) => o.toLowerCase()).sort().join();
  const b = currentOwners.map((o) => o.toLowerCase()).sort().join();
  if (a === b && setupThreshold === currentThreshold) return null;
  return "This Safe's owners changed after it was created. A new network starts with the original owners and approvals, so change them there too once it is set up.";
}
