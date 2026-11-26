// The Reserve Safe transactions that change the policy (BP-43), built with the canonical Roles ABI and keys.
import { encodeFunctionData, getAddress, type Hex } from "viem";
import type { Address } from "@/shared/types";
import { ALLOWANCE_KEY, ALLOWANCE_PERIOD_SEC, ROLE_KEY } from "../constants";
import { rolesAbi } from "../roles-abi";

/** The off switch: remove the executor from the role (tested in M0-6; cleaner than zeroing the allowance, where maxRefill 0 means unlimited). */
export const revokeCall = (p: { roles: Address; executor: Address }): { to: Address; data: Hex } => ({
  to: getAddress(p.roles) as Address,
  data: encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [p.executor, [ROLE_KEY], [false]] }),
});

/** A new daily limit: balance, maxRefill and refill all equal the limit, period one day. `maxRefill` is never 0 (that means unlimited). */
export function setLimitCall(p: { roles: Address; dailyLimitRaw: bigint; now: bigint }): { to: Address; data: Hex } {
  if (p.dailyLimitRaw <= 0n) throw new Error("A daily limit must be above zero");
  return { to: getAddress(p.roles) as Address, data: encodeFunctionData({ abi: rolesAbi, functionName: "setAllowance", args: [ALLOWANCE_KEY, p.dailyLimitRaw, p.dailyLimitRaw, p.dailyLimitRaw, BigInt(ALLOWANCE_PERIOD_SEC), p.now] }) };
}
