// BP-43: turn the reserve off and change its policy. Off is two steps and the order matters: the app stops the
// executor at once (a server flag), then the Reserve Safe's owners sign the transaction that removes the role.
// A policy change is a Reserve Safe transaction the owners sign in Safe{Wallet}; nothing changes until the chain
// (or, for the off-chain trigger, the executed transaction) shows it, and Activity logs the change then.
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { policyErrors } from "@/lib/reserve-policy";
import { recordActivity } from "@/server/activity";
import { requireNetwork } from "@/server/auth/access";
import { proposals, reserveLinks, reservePolicyChanges } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import { deliver } from "@/server/proposals/send";
import { safeTxHash } from "@/server/safe/hash";
import { safeQueueLink } from "@/server/safe/links";
import { getServices } from "@/server/services";
import type { Address, ChainId, Hex, SafeTx } from "@/shared/types";
import { getReserveRuntime } from "../executor/runtime";
import { revokeCall, setLimitCall } from "./calls";
import { loadReserveLink, stopReserve } from "../executor/store";
import type { ExecLink } from "../types";
import { OFF_BUT_NOT_SENT, OFF_NOW, PERMISSION_STILL_ACTIVE, SIGN_TO_REMOVE, permissionNotice, type PermissionState } from "./copy";

export { reconcilePolicyChanges } from "./reconcile";
export * from "./copy";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export type ReserveSafeTx = { tx: SafeTx; safeTxHash: Hex; chainId: ChainId; reserveSafe: Address; /** Where the owners sign it. */ link: string };

/** The block to start looking for the execution event from. */
const fromBlockOf = async (ctx: Pick<SafeContext, "services">, chainId: ChainId) => String(await getReserveRuntime(ctx.services, () => {}).chain.blockNumber(chainId));

async function reserveTx(ctx: Pick<SafeContext, "services">, link: ExecLink, call: { to: Address; data: Hex }): Promise<ReserveSafeTx> {
  const nonce = await ctx.services.reader.readSafeNonce(link.chainId, link.reserveSafe);
  if (nonce === null) throw new HttpError(409, "The Reserve Safe is not readable right now. Try again.");
  const tx: SafeTx = { to: call.to, value: "0", data: call.data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO, nonce: nonce.toString() };
  return { tx, safeTxHash: safeTxHash(link.chainId, link.reserveSafe, tx), chainId: link.chainId, reserveSafe: link.reserveSafe, link: safeQueueLink(link.chainId, link.reserveSafe) };
}

async function linkOf(ctx: SafeContext, chainId: ChainId): Promise<ExecLink> {
  requireNetwork(ctx.access, chainId);
  const link = await loadReserveLink(ctx.db, ctx.safe.id, chainId);
  if (!link) throw new HttpError(404, "No Reserve Safe is linked on this network.");
  return link;
}

const REVOKE_TITLE = "Remove the Lender agent's permission to use the Reserve";

/** The revoke as a stored proposal on the Reserve Safe, delivered to the Safe service through the same path as every proposal (the agent proposes, the owners sign). Safe to repeat. */
async function submitRevoke(ctx: SafeContext, link: ExecLink, changeId: string, built: ReserveSafeTx): Promise<void> {
  const { db, services } = ctx;
  const [res] = await db.select({ id: reserveLinks.reserveSafeId }).from(reserveLinks).where(and(eq(reserveLinks.mainSafeId, ctx.safe.id), eq(reserveLinks.chainId, link.chainId))).limit(1);
  if (!res) return;
  let [row] = await db.select().from(proposals).where(and(eq(proposals.safeId, res.id), eq(proposals.safeTxHash, built.safeTxHash))).limit(1);
  if (!row) {
    const [inserted] = await db.insert(proposals).values({
      id: randomUUID(), safeId: res.id, chainId: link.chainId, spec: { kind: "reserve-off", mainSafe: link.mainSafe, reserve: link.reserveSafe, roles: link.roles, executor: link.executor }, tx: built.tx,
      nonce: BigInt(built.tx.nonce), safeTxHash: built.safeTxHash, idempotencyKey: createHash("sha256").update(`reserve-off:${changeId}`).digest("hex"),
      title: REVOKE_TITLE, steps: ["Remove the executor key from the Reserve role"], outcome: "The agent can no longer spend from the Reserve Safe, even with its key.", stage: "sending",
      threshold: (await services.reader.readSafeThreshold(link.chainId, link.reserveSafe)) ?? 1, testRun: { ok: true, feeUsd: 0, healthAfter: null, reason: null }, createdBy: ctx.wallet.toLowerCase(),
    }).onConflictDoNothing().returning();
    row = inserted;
    if (!row) [row] = await db.select().from(proposals).where(eq(proposals.idempotencyKey, createHash("sha256").update(`reserve-off:${changeId}`).digest("hex"))).limit(1);
  }
  // A delivery that is unknown stays "sending"; the follower's reconcile (and the next press) takes it on.
  if (row?.stage === "sending") await deliver(db, services, row, link.reserveSafe).catch(() => {});
}

export type TurnOffResult = ReserveSafeTx & { permission: PermissionState; sentence: string; changeId: string };

/** Switch the executor off now and prepare the Reserve Safe transaction that removes its role. Idempotent: a second press returns the open transaction. */
export async function turnReserveOff(ctx: SafeContext, chainId: ChainId): Promise<TurnOffResult> {
  const { db } = ctx;
  const link = await linkOf(ctx, chainId);
  // Check the flag and pending repayments under the same link lock the executor uses. A pending
  // handoff returns 409 before any activity or revoke proposal is recorded.
  const wasActive = await stopReserve(db, ctx.safe.id, chainId);
  const [open] = await db.select().from(reservePolicyChanges).where(and(eq(reservePolicyChanges.safeId, ctx.safe.id), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off"), eq(reservePolicyChanges.status, "pending"))).limit(1);
  if (!wasActive && !open) {
    const [last] = await db.select({ status: reservePolicyChanges.status }).from(reservePolicyChanges)
      .where(and(eq(reservePolicyChanges.safeId, ctx.safe.id), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off")))
      .orderBy(desc(reservePolicyChanges.createdAt)).limit(1);
    if (last?.status === "applied") throw new HttpError(409, "The Reserve is already off and its permission has been removed.");
  }
  const changeId = open?.id ?? randomUUID();
  // The agent has stopped: say so in Activity now, before any chain work that could fail. A retry finds `wasActive` false and writes no second row.
  if (wasActive) {
    await recordActivity(db, { safeId: ctx.safe.id, chainId, actor: "You", actorAddress: ctx.wallet, kind: "status", at: new Date(), eventKey: `reserve-off:${changeId}`,
      text: "Turned the reserve off. The agent stopped using it.", detail: PERMISSION_STILL_ACTIVE });
  }
  try {
    let built: ReserveSafeTx;
    if (open) {
      built = { tx: open.tx as SafeTx, safeTxHash: open.safeTxHash as Hex, chainId, reserveSafe: link.reserveSafe, link: safeQueueLink(chainId, link.reserveSafe) };
    } else {
      built = await reserveTx(ctx, link, revokeCall(link));
      // The limit signed now, for the record; if the chain read fails, the one stored at setup.
      const prevLimitRaw = await getReserveRuntime(ctx.services, () => {}).chain.read(link).then((r) => String(r.allowance.maxRefill), async () => {
        const [row] = await db.select({ d: reserveLinks.dailyLimit }).from(reserveLinks).where(and(eq(reserveLinks.mainSafeId, ctx.safe.id), eq(reserveLinks.chainId, chainId))).limit(1);
        return row?.d ?? "0";
      });
      await db.insert(reservePolicyChanges).values({ id: changeId, safeId: ctx.safe.id, chainId, kind: "off", tx: built.tx, safeTxHash: built.safeTxHash, fromBlock: await fromBlockOf(ctx, chainId), prevTrigger: link.trigger, prevLimitRaw, requestedBy: ctx.wallet.toLowerCase() });
    }
    // The on-chain removal: the executor is already stopped above, whatever happens to the submission.
    await submitRevoke(ctx, link, changeId, built);
    // Reading the chain for the notice must not turn a stopped agent into an error: until the owners sign, the permission is still there.
    const permission = await permissionState(ctx, { ...link, active: false }).catch((): PermissionState => ({ agent: "stopped", chain: "active", notice: permissionNotice("stopped", "active") }));
    return { ...built, permission, sentence: `${OFF_NOW} ${SIGN_TO_REMOVE}.`, changeId };
  } catch (e) {
    console.error("[reserve] turn off: the agent is stopped but the revoke could not be prepared", e);
    throw new HttpError(502, OFF_BUT_NOT_SENT);
  }
}

/** What the page says about the reserve's permission: the app's flag against what the chain allows now. */
export async function permissionState(ctx: Pick<SafeContext, "db" | "services">, link?: ExecLink | null, chainId?: ChainId, safeId?: number): Promise<PermissionState> {
  const l = link ?? (await loadReserveLink(ctx.db, safeId!, chainId!));
  if (!l) return { agent: "stopped", chain: "removed", notice: null };
  const rt = getReserveRuntime(ctx.services ?? getServices(), () => {});
  const member = (await rt.chain.read(l)).executorIsMember;
  const agent = l.active ? "using" : "stopped";
  const chain = member ? "active" : "removed";
  return { agent, chain, notice: permissionNotice(agent, chain) };
}

export type PolicyChangeInput = { dailyLimitUsd?: string; trigger?: string };
export type PolicyChangeResult = ReserveSafeTx & { changeId: string; summary: string };

/** A new limit and/or trigger: validated like setup (r20), then a Reserve Safe transaction for the owners to sign. */
export async function requestPolicyChange(ctx: SafeContext, chainId: ChainId, input: PolicyChangeInput): Promise<PolicyChangeResult> {
  const { db } = ctx;
  const link = await linkOf(ctx, chainId);
  if (!link.active) throw new HttpError(409, "The reserve is off. Turn it on again before changing its policy.");
  const owners = await ctx.services.reader.readSafeOwners(chainId, link.reserveSafe);
  if (!owners?.some((o) => o.toLowerCase() === ctx.wallet.toLowerCase())) throw new HttpError(403, "Only an owner of the Reserve Safe can change its policy.");
  if (input.dailyLimitUsd === undefined && input.trigger === undefined) throw new HttpError(400, "Change the limit or the trigger.");
  const rt = getReserveRuntime(ctx.services, () => {});
  const read = await rt.chain.read(link);
  const state = read.allowance;
  const nowSec = BigInt(read.nowSec);
  const balance = Number(read.balance) / 10 ** link.tokenDecimals;
  const currentLimit = Number(state.maxRefill) / 10 ** link.tokenDecimals;
  const errors = policyErrors(input.trigger ?? String(link.trigger), input.dailyLimitUsd ?? String(currentLimit), balance);
  const message = errors.hf ?? errors.cap;
  if (message) throw new HttpError(400, message);
  const newTrigger = input.trigger === undefined ? null : Number(input.trigger.replace(",", "."));
  const limitRaw = input.dailyLimitUsd === undefined ? null : BigInt(Math.round(Number(input.dailyLimitUsd.replace(/[$,\s]/g, "")) * 10 ** link.tokenDecimals));
  if ((limitRaw === null || limitRaw === state.maxRefill) && (newTrigger === null || newTrigger === link.trigger)) throw new HttpError(400, "That is already the current policy.");
  // A limit change is the Roles call; a trigger-only change is a Reserve Safe transaction with no effect on-chain, so the owners' signature still stands behind it.
  const call = limitRaw !== null && limitRaw !== state.maxRefill ? setLimitCall({ roles: link.roles, dailyLimitRaw: limitRaw, now: nowSec }) : { to: link.reserveSafe, data: "0x" as Hex };
  const built = await reserveTx(ctx, link, call);
  const changeId = randomUUID();
  await db.insert(reservePolicyChanges).values({ id: changeId, safeId: ctx.safe.id, chainId, kind: "policy", newTrigger, newLimitRaw: limitRaw === null ? null : String(limitRaw), tx: built.tx, safeTxHash: built.safeTxHash, fromBlock: await fromBlockOf(ctx, chainId), prevTrigger: link.trigger, prevLimitRaw: String(state.maxRefill), requestedBy: ctx.wallet.toLowerCase() });
  const parts = [limitRaw !== null && `limit to ${Number(limitRaw) / 10 ** link.tokenDecimals} ${link.tokenSymbol} per day`, newTrigger !== null && `trigger to health ${newTrigger.toFixed(2)}`].filter(Boolean);
  return { ...built, changeId, summary: `Sign in the Reserve Safe to change the ${parts.join(" and ")}. Nothing changes until it executes.` };
}

/** Pending changes for the page's sign bar. */
export async function pendingChanges(ctx: Pick<SafeContext, "db" | "safe">, chainId: ChainId) {
  return ctx.db.select().from(reservePolicyChanges).where(and(eq(reservePolicyChanges.safeId, ctx.safe.id), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.status, "pending"))).orderBy(desc(reservePolicyChanges.createdAt));
}
