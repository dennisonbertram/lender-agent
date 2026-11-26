// reserveStatus / reservePolicy: the one place every surface (page, sidebar, chat header, the worker)
// reads the Reserve from. Chain is the truth; the DB row only says which Reserve Safe and which trigger.
import { and, desc, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { reserveStatus as statusOf, type ReserveStatus } from "@/lib/reserve";
import { getPublicClient } from "@/server/chain/client";
import type { Db } from "@/server/db/client";
import { getDb } from "@/server/db/client";
import { reserveLinks, reservePolicyChanges, safes } from "@/server/db/schema";
import type { Address, ChainId } from "@/shared/types";
import type { Services } from "@/server/services";
import { getServices, isMock } from "@/server/services";
import { getReserveRuntime } from "./executor/runtime";
import type { ExecLink } from "./types";
import { allowanceNow, type RawAllowance } from "./allowance";
import { RESERVE_ASSET } from "./constants";
import { MANY_ROLES_ISSUE, mockChainState, policyAsDesigned, readReserveChain } from "./read";

export const TURNING_OFF = "Turning off: waiting for the owners to revoke the role in Safe";
const USDC_UNITS = 1_000_000;
const toUsd = (raw: bigint) => Number(raw) / USDC_UNITS;

export type ReserveLink = typeof reserveLinks.$inferSelect;
export type SafeRef = { address: Address | string; chainId: ChainId };
export type ReadDeps = { db?: Db; services?: Services; client?: ReturnType<typeof getPublicClient>; /** Cache lifetime in ms; 0 reads fresh. */ ttlMs?: number };

export type ReservePolicyView = {
  chainId: ChainId;
  mainSafe: Address;
  reserve: Address;
  roles: Address;
  executor: Address;
  asset: { symbol: "USDC"; address: Address; decimals: 6 };
  lender: { name: "Aave v3"; pool: Address };
  /** Daily limit decoded from the on-chain allowance (maxRefill), whole USDC. */
  dailyLimitUsd: number;
  periodHours: number;
  /** The off-chain trigger (D-02): the agent decides, the chain does not check health. */
  triggerHf: number;
  moduleEnabled: boolean;
  executorIsMember: boolean;
  /** False when the chain's scope is not exactly the one we sign; `issues` says why. */
  asDesigned: boolean;
  issues: string[];
  /** The Pool may pull the repayment from the Reserve Safe. */
  approved: boolean;
  /** The agent may act: module on, executor in the role, scope as designed. */
  armed: boolean;
  blockNumber: bigint;
};

export type ReserveStatusView = {
  kind: ReserveStatus["kind"];
  label: ReserveStatus["label"];
  tone: ReserveStatus["tone"];
  banner: string;
  reserve: Address;
  executor: Address;
  roles: Address;
  /** Reserve Safe's USDC, whole units. */
  balanceUsd: number;
  limitUsd: number;
  usedUsd: number;
  leftUsd: number;
  /** "Resets in 5 h", from the on-chain allowance. Null when nothing is used. */
  resetLabel: string | null;
  resetsInSec: number | null;
  triggerHf: number;
  armed: boolean;
  blockNumber: bigint;
};

export type ReserveReadout = { link: ReserveLink; policy: ReservePolicyView; status: ReserveStatusView; raw: { allowance: RawAllowance; balance: bigint } };

const cache = new Map<string, { at: number; value: ReserveReadout | null }>();
export const clearReserveCache = () => cache.clear();

export async function reserveLinkOf(db: Db, safe: SafeRef): Promise<ReserveLink | null> {
  const addr = safe.address.toLowerCase();
  const rows = await db.select({ link: reserveLinks }).from(reserveLinks).innerJoin(safes, eq(safes.id, reserveLinks.mainSafeId))
    .where(and(eq(safes.address, addr), eq(reserveLinks.chainId, safe.chainId))).limit(1);
  return rows[0]?.link ?? null;
}

/** "Resets in 5 h" (rounded up, never 0 h). The hours are the chain's own refill boundary. */
export const resetLabelOf = (sec: number | null) => (sec === null ? null : sec <= 0 ? "Resets soon" : `Resets in ${Math.min(24, Math.ceil(sec / 3600))} h`);

async function read(safe: SafeRef, deps: ReadDeps): Promise<ReserveReadout | null> {
  const db = deps.db ?? (await getDb());
  const link = await reserveLinkOf(db, safe);
  if (!link) return null;
  const chainId = link.chainId as ChainId;
  const [res] = await db.select().from(safes).where(eq(safes.id, link.reserveSafeId)).limit(1);
  const reserve = getAddress(res!.address) as Address;
  const mainSafe = getAddress(safe.address) as Address;
  const roles = getAddress(link.rolesAddress) as Address;
  const executor = getAddress(link.executorAddress) as Address;
  let chain;
  if (deps.client || !isMock()) {
    chain = await readReserveChain(deps.client ?? getPublicClient(chainId), { chainId, reserve, roles, mainSafe, executor, fromBlock: link.fromBlock });
  } else {
    const execLink: ExecLink = {
      safeId: link.mainSafeId, chainId, mainSafe, reserveSafe: reserve, roles, executor,
      token: RESERVE_ASSET[chainId]!.usdc, tokenSymbol: RESERVE_ASSET[chainId]!.symbol, tokenDecimals: RESERVE_ASSET[chainId]!.decimals,
      trigger: link.triggerHf, attempt: link.attempt, active: link.state !== "off" && link.state !== "relinking", fromBlock: link.fromBlock,
    };
    try {
      // The MOCK runtime tracks owner actions. The DB `off` flag stops the agent, but does not
      // claim that Safe owners have revoked its on-chain permission.
      const runtimeState = await getReserveRuntime(deps.services ?? getServices(), () => {}).chain.read(execLink);
      chain = mockChainState(link, runtimeState.executorIsMember);
    } catch (err) {
      if (!(err instanceof Error) || !/no modifier/.test(err.message)) throw err;
      const [lastOff] = await db.select({ status: reservePolicyChanges.status }).from(reservePolicyChanges)
        .where(and(eq(reservePolicyChanges.safeId, link.mainSafeId), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off")))
        .orderBy(desc(reservePolicyChanges.createdAt)).limit(1);
      chain = mockChainState(link, lastOff?.status !== "applied");
    }
  }
  const a = RESERVE_ASSET[chainId]!;
  // Not on chain yet (the owners have not signed or executed): the Reserve is linked but Off.
  const al: RawAllowance = chain?.allowance ?? { refill: 0n, maxRefill: 0n, period: 0n, balance: 0n, timestamp: 0n };
  const now = chain ? allowanceNow(al, chain.blockTimestamp) : { left: 0n, limit: 0n, resetsInSec: null };
  const issues = chain === null ? ["The setup has not been signed yet."] : [...chain.issues, ...(chain.moduleEnabled ? [] : ["The permission module is not turned on."]), ...(chain.approval > 0n ? [] : ["The lender cannot pull the repayment yet."])];
  const asDesigned = policyAsDesigned(chain);
  // The server's off flag wins over the chain: the executor is already stopped, the role may still be on-chain.
  const serverOff = link.state === "off";
  const armed = !serverOff && asDesigned && (chain?.executorIsMember ?? false);
  const limitUsd = toUsd(now.limit);
  const leftUsd = toUsd(now.left);
  const usedUsd = Math.max(0, limitUsd - leftUsd);
  const periodSec = Number(al.period);
  const base = statusOf(
    { armed, emergencyHF: link.triggerHf, dailyCapUsd: limitUsd, usedUsd24h: usedUsd },
    0,
  );
  const resetLabel = usedUsd > 0 ? resetLabelOf(now.resetsInSec) : null;
  // The lib banner builds "Resets in N h" from a start time; ours comes straight from the chain.
  const banner = serverOff && (chain === null || chain.executorIsMember) ? TURNING_OFF : !armed && issues.includes(MANY_ROLES_ISSUE) ? MANY_ROLES_ISSUE : base.kind === "limitReached" ? `Limit reached: today's ${fmtUsd(limitUsd)} is used. ${resetLabel ? `${resetLabel}. ` : ""}The agent only suggests until then.` : base.banner;
  const policy: ReservePolicyView = {
    chainId, mainSafe, reserve, roles, executor,
    asset: { symbol: a.symbol, address: a.usdc, decimals: a.decimals }, lender: { name: "Aave v3", pool: a.pool },
    dailyLimitUsd: limitUsd, periodHours: periodSec / 3600, triggerHf: link.triggerHf,
    moduleEnabled: chain?.moduleEnabled ?? false, executorIsMember: chain?.executorIsMember ?? false,
    asDesigned, issues, approved: (chain?.approval ?? 0n) > 0n, armed, blockNumber: chain?.blockNumber ?? 0n,
  };
  const status: ReserveStatusView = {
    kind: base.kind, label: base.label, tone: base.tone, banner, reserve, executor, roles,
    balanceUsd: toUsd(chain?.balance ?? 0n), limitUsd, usedUsd, leftUsd, resetLabel, resetsInSec: usedUsd > 0 ? now.resetsInSec : null,
    triggerHf: link.triggerHf, armed, blockNumber: chain?.blockNumber ?? 0n,
  };
  return { link, policy, status, raw: { allowance: al, balance: chain?.balance ?? 0n } };
}

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** The whole read-out, cached briefly (a "not linked" answer is never cached, so a new link shows at once). Null: no Reserve linked for this Safe on this network. */
export async function reserveReadout(safe: SafeRef, deps: ReadDeps = {}): Promise<ReserveReadout | null> {
  const ttl = deps.ttlMs ?? 10_000;
  const key = `${safe.chainId}:${safe.address.toLowerCase()}`;
  const hit = cache.get(key);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await read(safe, deps);
  if (ttl > 0 && value) cache.set(key, { at: Date.now(), value });
  return value;
}

/** One status for the page, sidebar, chat header and worker. Null when no Reserve is linked. */
export async function reserveStatus(safe: SafeRef, deps: ReadDeps = {}): Promise<ReserveStatusView | null> {
  return (await reserveReadout(safe, deps))?.status ?? null;
}

/** The policy decoded from chain (limit, role, scope), plus the off-chain trigger. Null when no Reserve is linked. */
export async function reservePolicy(safe: SafeRef, deps: ReadDeps = {}): Promise<ReservePolicyView | null> {
  return (await reserveReadout(safe, deps))?.policy ?? null;
}
