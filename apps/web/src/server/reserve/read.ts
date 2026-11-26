// Read the Reserve's policy back from chain (BP-39 NFR: "the policy shown is decoded from chain after
// signing"). Everything is decoded from the Roles modifier's own events and storage: module enabled on
// the Reserve Safe, who is a member of which role, what each role may call (with its conditions), the
// allowance. A scope that is not exactly the one we build marks the policy as not as designed.
import { getAddress, isAddressEqual, type PublicClient } from "viem";
import type { Address, ChainId } from "@/shared/types";
import { ALLOWANCE_KEY, REPAY_SELECTOR, RESERVE_ASSET, ROLE_KEY } from "./constants";
import { repayConditions, type ConditionFlat } from "./build";
import type { RawAllowance } from "./allowance";
import { erc20Abi, rolesAbi, safeModuleAbi } from "./roles-abi";

export type RolesEvents = Awaited<ReturnType<typeof readRolesEvents>>;

type FnScope = { kind: "scoped"; conditions: ConditionFlat[]; options: number } | { kind: "allowed"; options: number };
type TargetScope = { clearance: "none" | "function" | "target"; options: number; functions: Map<string, FnScope> };

export type RoleState = {
  /** module address (lowercase) -> role keys it is a member of. */
  members: Map<string, Set<string>>;
  /** roleKey -> target (lowercase) -> scope. */
  scopes: Map<string, Map<string, TargetScope>>;
};

/** Replay the modifier's events in order. Events carry no indexed fields, so one address-scoped query reads them all. */
export async function readRolesEvents(client: PublicClient, roles: Address, fromBlock: bigint, toBlock: bigint) {
  const logs = await client.getLogs({ address: roles, fromBlock, toBlock, events: rolesAbi.filter((x) => x.type === "event") as never });
  return logs as unknown as { eventName: string; args: Record<string, unknown> }[];
}

export function replayRoleState(logs: { eventName: string; args: Record<string, unknown> }[]): RoleState {
  const st: RoleState = { members: new Map(), scopes: new Map() };
  const target = (role: string, t: string): TargetScope => {
    const byTarget = st.scopes.get(role) ?? new Map<string, TargetScope>();
    st.scopes.set(role, byTarget);
    const k = t.toLowerCase();
    const cur = byTarget.get(k) ?? { clearance: "none" as const, options: 0, functions: new Map() };
    byTarget.set(k, cur);
    return cur;
  };
  for (const l of logs) {
    const a = l.args as Record<string, any>;
    switch (l.eventName) {
      case "AssignRoles": {
        const m = (a.module as string).toLowerCase();
        const set = st.members.get(m) ?? new Set<string>();
        (a.roleKeys as string[]).forEach((k: string, i: number) => ((a.memberOf as boolean[])[i] ? set.add(k.toLowerCase()) : set.delete(k.toLowerCase())));
        st.members.set(m, set);
        break;
      }
      case "ScopeTarget": target(a.roleKey, a.targetAddress).clearance = "function"; break;
      case "AllowTarget": { const t = target(a.roleKey, a.targetAddress); t.clearance = "target"; t.options = Number(a.options); break; }
      case "RevokeTarget": target(a.roleKey, a.targetAddress).clearance = "none"; break;
      case "ScopeFunction": target(a.roleKey, a.targetAddress).functions.set((a.selector as string).toLowerCase(), { kind: "scoped", conditions: (a.conditions as ConditionFlat[]).map((c) => ({ parent: Number(c.parent), paramType: Number(c.paramType), operator: Number(c.operator), compValue: c.compValue.toLowerCase() as `0x${string}` })), options: Number(a.options) }); break;
      case "AllowFunction": target(a.roleKey, a.targetAddress).functions.set((a.selector as string).toLowerCase(), { kind: "allowed", options: Number(a.options) }); break;
      case "RevokeFunction": target(a.roleKey, a.targetAddress).functions.delete((a.selector as string).toLowerCase()); break;
    }
  }
  return st;
}

const sameConditions = (a: ConditionFlat[], b: ConditionFlat[]) =>
  a.length === b.length && a.every((c, i) => c.parent === b[i]!.parent && c.paramType === b[i]!.paramType && c.operator === b[i]!.operator && c.compValue.toLowerCase() === b[i]!.compValue.toLowerCase());

/** Why the chain's scope is not the one we sign. Empty means: exactly Pool.repay(USDC, within allowance, variable, main Safe), nothing else, for the executor only. */
export function scopeIssues(st: RoleState, p: { chainId: ChainId; mainSafe: Address; executor: Address }): string[] {
  const a = RESERVE_ASSET[p.chainId]!;
  const issues: string[] = [];
  const memberOf = (m: string) => st.members.get(m.toLowerCase()) ?? new Set<string>();
  if (!memberOf(p.executor).has(ROLE_KEY.toLowerCase())) issues.push(MISSING_ROLE_MEMBER_ISSUE);
  for (const [m, roles] of st.members) {
    for (const r of roles) {
      if (r !== ROLE_KEY.toLowerCase()) issues.push(`A member (${m}) is on another role.`);
      else if (m !== p.executor.toLowerCase()) issues.push(`Another key (${m}) is a member of the role.`);
    }
  }
  for (const [role, byTarget] of st.scopes) {
    for (const [t, s] of byTarget) {
      if (s.clearance === "none") continue;
      if (role !== ROLE_KEY.toLowerCase() || t !== a.pool.toLowerCase()) { issues.push(`The role can also call ${t}.`); continue; }
      if (s.clearance === "target" || s.options !== 0) issues.push("The role may call every function of the lender.");
      for (const [sel, f] of s.functions) {
        if (sel !== REPAY_SELECTOR.toLowerCase()) issues.push(`The role may also call ${sel}.`);
        else if (f.kind !== "scoped" || f.options !== 0 || !sameConditions(f.conditions, repayConditions(p.chainId, p.mainSafe))) issues.push("Repay is not limited to this loan's USDC, variable rate, main Safe and the allowance.");
      }
      if (!s.functions.has(REPAY_SELECTOR.toLowerCase())) issues.push("The role cannot repay.");
    }
  }
  const pool = st.scopes.get(ROLE_KEY.toLowerCase())?.get(a.pool.toLowerCase());
  if (!pool || pool.clearance === "none") issues.push("The role cannot call the lender.");
  return issues;
}

export const MISSING_ROLE_MEMBER_ISSUE = "The reserve key is not a member of the role.";

/** The same on-chain policy check for the reserve status and executor authorization. */
export function policyAsDesigned(chain: ReserveChainState | null): boolean {
  return chain !== null && chain.moduleEnabled && chain.issues.length === 0 && chain.allowance.maxRefill > 0n;
}

export type ReserveChainState = {
  blockNumber: bigint;
  blockTimestamp: number;
  moduleEnabled: boolean;
  allowance: RawAllowance;
  /** Reserve Safe's USDC balance, raw units. */
  balance: bigint;
  /** Aave Pool's allowance over the Reserve Safe's USDC. */
  approval: bigint;
  issues: string[];
  executorIsMember: boolean;
};

/** The reason the Reserve reads Off when a second Roles module is enabled on the Reserve Safe (an old or repeated setup, with its own allowance). */
export const MANY_ROLES_ISSUE = "More than one Roles module is enabled on the Reserve Safe. Remove the extra ones in Safe so there is one limit.";
const SENTINEL = "0x0000000000000000000000000000000000000001" as Address;

/** Other enabled modules on the Reserve Safe that are Roles proxies (same proxy code as ours): each carries its own allowance. */
async function otherRolesModules(client: PublicClient, reserve: Address, roles: Address, rolesCode: string, blockNumber: bigint): Promise<Address[]> {
  const [modules] = await client.readContract({ address: reserve, abi: safeModuleAbi, functionName: "getModulesPaginated", args: [SENTINEL, 100n], blockNumber });
  const others = modules.filter((m) => !sameAddress(m, roles));
  const codes = await Promise.all(others.map((m) => client.getCode({ address: m, blockNumber })));
  return others.filter((_, i) => codes[i]?.toLowerCase() === rolesCode.toLowerCase());
}

export async function readReserveChain(client: PublicClient, p: { chainId: ChainId; reserve: Address; roles: Address; mainSafe: Address; executor: Address; fromBlock: bigint }): Promise<ReserveChainState | null> {
  const a = RESERVE_ASSET[p.chainId]!;
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const code = await client.getCode({ address: p.roles, blockNumber });
  if (!code || code === "0x") return null;
  const [events, moduleEnabled, al, balance, approval] = await Promise.all([
    readRolesEvents(client, p.roles, p.fromBlock, blockNumber),
    client.readContract({ address: p.reserve, abi: safeModuleAbi, functionName: "isModuleEnabled", args: [p.roles], blockNumber }),
    client.readContract({ address: p.roles, abi: rolesAbi, functionName: "allowances", args: [ALLOWANCE_KEY], blockNumber }),
    client.readContract({ address: a.usdc, abi: erc20Abi, functionName: "balanceOf", args: [p.reserve], blockNumber }),
    client.readContract({ address: a.usdc, abi: erc20Abi, functionName: "allowance", args: [p.reserve, a.pool], blockNumber }),
  ]);
  const st = replayRoleState(events);
  const issues = scopeIssues(st, p);
  const others = await otherRolesModules(client, p.reserve, p.roles, code, blockNumber);
  if (others.length > 0) issues.push(MANY_ROLES_ISSUE);
  const [refill, maxRefill, period, bal, timestamp] = al;
  return {
    blockNumber, blockTimestamp: Number(block.timestamp), moduleEnabled, balance, approval, issues,
    executorIsMember: st.members.get(p.executor.toLowerCase())?.has(ROLE_KEY.toLowerCase()) ?? false,
    allowance: { refill, maxRefill, period, balance: bal, timestamp },
  };
}

export const sameAddress = (a: string, b: string) => isAddressEqual(getAddress(a), getAddress(b));

/** `MOCK=1`: a Reserve that was signed as designed, with $2,500 USDC and nothing used (no RPC). */
export function mockChainState(link: { dailyLimit: string; createdAt: Date; state?: string }, executorIsMember = link.state !== "off"): ReserveChainState {
  const limit = BigInt(link.dailyLimit);
  const now = Math.floor(Date.now() / 1000);
  return {
    blockNumber: 1n, blockTimestamp: now, moduleEnabled: true, executorIsMember, issues: executorIsMember ? [] : [MISSING_ROLE_MEMBER_ISSUE], approval: 2n ** 256n - 1n, balance: 2_500_000_000n,
    allowance: { refill: limit, maxRefill: limit, period: 86_400n, balance: limit, timestamp: BigInt(now) },
  };
}
