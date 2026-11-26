import { usd } from "@/lib/format";

/**
 * What the owners are about to sign, in words that match what the chain enforces (D-01 a, D-02 a,
 * architecture 8.4, milestones M6 exit 5). The lists are built from the limits on screen.
 * The trigger is checked by the agent's software, not by the chain: the copy says so.
 */
export const reserveCopyV1 = (p: { triggerHf: number; dailyLimitUsd: number | null }, safeName: string) => ({
  can: [
    `Repay ${safeName}'s USDC debt on Aave (Base), from this Reserve Safe`,
    `Only when a loan is close to liquidation: health below ${p.triggerHf.toFixed(2)} (1.00 is liquidation)`,
    `Request up to ${p.dailyLimitUsd === null ? "your daily limit" : usd(p.dailyLimitUsd)} of USDC per day. The limit counts what the agent asks to repay, not what Aave takes`,
  ],
  cannot: [
    `Send money anywhere, even to ${safeName}`,
    "Borrow more, add collateral or withdraw collateral",
    "Repay anyone else's loan, use another token or another lender (Compound v3 is not covered)",
  ],
  /** One sentence that says who enforces what. */
  enforced: `The chain enforces what the agent may call, for whom and how much per day. The agent decides when: the health trigger is not checked on-chain.`,
});

/** Messages for the three limit rules (VC-07). Errors block signing. */
export const RESERVE_BELOW_MIN = "Enter at least $1. To stop the agent, turn off “Agent can use reserve”.";
