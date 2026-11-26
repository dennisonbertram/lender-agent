// The Reserve page's data (BP-39, BP-40): one JSON for page, sidebar and chat header. Figures come from
// the chain read-out (G1); nothing here is computed by the model.
import { and, desc, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { safeLabel } from "@/lib/address";
import { reserveCopyV1 } from "@/lib/reserve-copy";
import { proposals, reservePolicyChanges, safes } from "@/server/db/schema";
import type { SafeContext } from "@/server/request";
import { safeQueueLink, safeTxLink } from "@/server/safe/links";
import type { Address, ChainId, Hex } from "@/shared/types";
import { SIGN_TO_REMOVE } from "./policy-change/copy";
import { RESERVE_ASSET, RESERVE_CHAINS } from "./constants";
import { reserveReadout, type ReserveStatusView } from "./status";
import { reconcilePolicyChanges } from "./policy-change/reconcile";

export type ReserveView = {
  chainId: ChainId;
  /** False: the Reserve is not offered on this network (Base first). */
  available: boolean;
  linked: boolean;
  /** Status of the linked Reserve (one status everywhere). */
  status: (Omit<ReserveStatusView, "blockNumber"> & { blockNumber: string }) | null;
  policy: {
    reserve: Address; roles: Address; executor: Address; /** The Aave pool and USDC the role may touch (what the owners sign). */ pool: Address; usdc: Address; dailyLimitUsd: number; periodHours: number; triggerHf: number;
    moduleEnabled: boolean; executorIsMember: boolean; asDesigned: boolean; approved: boolean; issues: string[];
    copy: ReturnType<typeof reserveCopyV1>;
  } | null;
  /** The setup proposal while the owners have not signed it yet. */
  setup: { proposalId: string; stage: string; link: string; queueLink: string } | null;
  /** While the reserve is off but the role is not removed on-chain yet: where the owners sign the removal. */
  revoke: { text: string; link: string } | null;
  /** Owners of the Reserve Safe; absent while it is not known or could not be read. */
  reserveOwners?: Address[];
  /** Whether the signed-in wallet owns the Reserve Safe; absent when the owners are not known. */
  viewerIsReserveOwner?: boolean;
  /** True only after the off-chain stop is recorded and the chain read confirms the executor role is gone. */
  revocationConfirmed?: boolean;
};

export async function reserveViewOf(ctx: SafeContext, chainId: ChainId = 8453): Promise<ReserveView> {
  const available = RESERVE_CHAINS.includes(chainId);
  if (!available) return { chainId, available, linked: false, status: null, policy: null, setup: null, revoke: null };
  await reconcilePolicyChanges({ db: ctx.db, services: ctx.services, now: new Date(), log: () => {} }, ctx.safe.id, chainId);
  const out = await reserveReadout({ address: ctx.safe.address, chainId }, { db: ctx.db, services: ctx.services });
  if (!out) return { chainId, available, linked: false, status: null, policy: null, setup: null, revoke: null };
  const { link, policy, status } = out;
  let setup: ReserveView["setup"] = null;
  if (link.setupProposalId && !policy.armed && link.state !== "off") {
    const [row] = await ctx.db.select().from(proposals).where(eq(proposals.id, link.setupProposalId)).limit(1);
    const [reserveRow] = await ctx.db.select().from(safes).where(eq(safes.id, link.reserveSafeId)).limit(1);
    if (row && reserveRow) {
      const reserve = getAddress(reserveRow.address) as Address;
      setup = { proposalId: row.id, stage: row.stage, queueLink: safeQueueLink(chainId, reserve), link: row.safeTxHash ? safeTxLink(chainId, reserve, row.safeTxHash as Hex) : safeQueueLink(chainId, reserve) };
    }
  }
  let revoke: ReserveView["revoke"] = null;
  if (link.state === "off") {
    const [change] = await ctx.db.select().from(reservePolicyChanges).where(and(eq(reservePolicyChanges.safeId, ctx.safe.id), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off"), eq(reservePolicyChanges.status, "pending"))).limit(1);
    const [reserveRow] = change ? await ctx.db.select().from(safes).where(eq(safes.id, link.reserveSafeId)).limit(1) : [];
    if (change && reserveRow) {
      const reserve = getAddress(reserveRow.address) as Address;
      revoke = { text: SIGN_TO_REMOVE, link: safeTxLink(chainId, reserve, change.safeTxHash as Hex) };
    }
  }
  const [lastRevoke] = await ctx.db.select({ status: reservePolicyChanges.status }).from(reservePolicyChanges)
    .where(and(eq(reservePolicyChanges.safeId, ctx.safe.id), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off")))
    .orderBy(desc(reservePolicyChanges.createdAt)).limit(1);
  const owners = await ctx.services.reader.readSafeOwners(chainId, policy.reserve).catch(() => null);
  const ownerFields = owners ? { reserveOwners: owners.map((o) => getAddress(o) as Address), viewerIsReserveOwner: owners.some((o) => o.toLowerCase() === ctx.wallet.toLowerCase()) } : {};
  return {
    chainId, available, linked: true, setup, revoke, ...ownerFields,
    revocationConfirmed: lastRevoke?.status === "applied" && !policy.executorIsMember && !revoke,
    status: { ...status, blockNumber: status.blockNumber.toString() },
    policy: {
      reserve: policy.reserve, roles: policy.roles, executor: policy.executor, pool: RESERVE_ASSET[chainId]!.pool, usdc: RESERVE_ASSET[chainId]!.usdc, dailyLimitUsd: policy.dailyLimitUsd, periodHours: policy.periodHours, triggerHf: policy.triggerHf,
      moduleEnabled: policy.moduleEnabled, executorIsMember: policy.executorIsMember, asDesigned: policy.asDesigned, approved: policy.approved, issues: policy.issues,
      copy: reserveCopyV1({ triggerHf: policy.triggerHf, dailyLimitUsd: policy.dailyLimitUsd }, safeLabel(ctx.safe)),
    },
  };
}
