import { usd } from "@/lib/format";
import { parseNumber } from "./loan-math";

/** Can and cannot lists built from the live policy. `safeName` is always the Treasury Safe's name. */
export const reservePolicyCopy = (policy: { emergencyHF: number; dailyCapUsd: number }, safeName: string) => ({
  can: [
    `Add collateral or repay debt on ${safeName} loans`,
    `Only when a loan is close to liquidation: health below ${policy.emergencyHF.toFixed(2)} (1.00 is liquidation)`,
    `Up to ${usd(policy.dailyCapUsd)} per day`,
  ],
  cannot: [`Send money anywhere, even to ${safeName}`, "Borrow more", "Withdraw collateral from a loan"],
});

/** Input checks. An error blocks signing. A limit under $1 is refused so a $0 policy is never stored. */
export function policyErrors(hf: string, cap: string, reserveUsd: number): { hf?: string; cap?: string } {
  const h = parseNumber(hf);
  const c = parseNumber(cap);
  const out: { hf?: string; cap?: string } = {};
  if (h === null || h < 1.02 || h > 2) out.hf = "Use a number from 1.02 to 2.00";
  if (!cap.trim()) out.cap = "Enter a daily limit, for example $5,000.";
  else if (c === null) out.cap = "Use numbers only, for example $5,000.";
  else if (c < 1) out.cap = "Enter at least $1. To stop the agent, turn off “Agent can use reserve”.";
  else if (c > reserveUsd) out.cap = `The Reserve Safe holds ${usd(reserveUsd)}. The limit cannot be higher.`;
  return out;
}
