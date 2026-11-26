// Link a Reserve Safe and sign the policy (BP-39). The owners set the limits first; the server checks
// them (G1: every figure is ours, not the model's), builds the setup batch offline and stores it as a
// normal proposal on the Reserve Safe (stage "sending" before anything is signed or sent), so
// it takes the same path as every other proposal: the agent proposes, the owners sign in Safe{Wallet}.
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getAddress, isAddress, parseUnits } from "viem";
import { safeLabel } from "@/lib/address";
import { policyErrors } from "@/lib/reserve-policy";
import { recordActivity } from "@/server/activity";
import { assertAgentActive } from "@/server/agent-role";
import { requireNetwork } from "@/server/auth/access";
import { getPublicClient } from "@/server/chain/client";
import { proposals, reserveLinks, reservePolicyChanges, safeNetworks, safes } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { deliver, resultOf, withNextProposalNonce, type SendResult } from "@/server/proposals/send";
import type { SafeContext } from "@/server/request";
import { safeTxHash } from "@/server/safe/hash";
import { isMock, type Services } from "@/server/services";
import type { Address, ChainId, SafeTx } from "@/shared/types";
import { buildReserveRestore, buildReserveSetup, type ReserveSetup } from "./build";
import { MODULE_PROXY_FACTORY, RESERVE_ASSET, RESERVE_CHAINS } from "./constants";
import { reconcilePolicyChanges } from "./policy-change/reconcile";
import { DevExecutorSigner, getExecutorSigner, type ExecutorSigner } from "./signer";
import { clearReserveCache, reserveLinkOf, reserveReadout } from "./status";
import { ANVIL_DEV_KEYS } from "@/server/signer/dev";
import { reserveCopyV1 } from "@/lib/reserve-copy";
import { MISSING_ROLE_MEMBER_ISSUE } from "./read";

export type LinkInput = {
  chainId: ChainId;
  /** The Reserve Safe's address (a second Safe the owners control). */
  reserveSafe: string;
  /** Dollars of USDC per day, up to the token's six decimal places. */
  dailyLimitUsd: number;
  /** Health below this: the agent repays (1.02 to 2.00). */
  triggerHf: number;
};

/** The executor for this process: `EXECUTOR_SIGNER`/`DEV_EXECUTOR_KEY`, or anvil key 2 in mock mode. */
export function executorFor(services: Services, env: Record<string, string | undefined> = process.env): ExecutorSigner {
  if (services.mock && !env.DEV_EXECUTOR_KEY && (env.EXECUTOR_SIGNER ?? "dev") === "dev") return new DevExecutorSigner(ANVIL_DEV_KEYS[2]);
  return getExecutorSigner(env);
}

export type LinkCheck = {
  reserve: Address;
  balanceUsd: number;
  errors: { hf?: string; cap?: string; reserve?: string };
  copy: ReturnType<typeof reserveCopyV1>;
};

async function usdcBalance(services: Services, chainId: ChainId, reserve: Address): Promise<number> {
  const r = await services.reader.readBalances(chainId, reserve);
  return r.balances.find((b) => b.symbol === "USDC")?.amount ?? 0;
}

/** What the page shows before signing: the Reserve Safe's USDC, the field errors, and the can/cannot lists from the values typed. */
export async function checkReserve(ctx: Pick<SafeContext, "services" | "safe" | "wallet">, input: LinkInput): Promise<LinkCheck> {
  const { services, safe } = ctx;
  const reserveRaw = input.reserveSafe;
  const errors: LinkCheck["errors"] = {};
  let reserve = "0x" as Address;
  let balanceUsd = 0;
  if (!isAddress(reserveRaw, { strict: false })) errors.reserve = "This is not a valid address.";
  else if (reserveRaw.toLowerCase() === safe.address.toLowerCase()) errors.reserve = "The Reserve Safe must be a different Safe from this one.";
  else {
    reserve = getAddress(reserveRaw) as Address;
    if (!RESERVE_CHAINS.includes(input.chainId)) errors.reserve = "The Reserve is not available on this network yet.";
    else if (!(await services.reader.isDeployed(input.chainId, reserve))) errors.reserve = "This Safe is not deployed on this network.";
    else {
      const owners = await services.reader.readSafeOwners(input.chainId, reserve);
      if (!owners?.some((o) => o.toLowerCase() === ctx.wallet.toLowerCase())) errors.reserve = "You are not an owner of this Safe.";
      else if (!(await assertAgentActive(services, input.chainId, reserve).then(() => true, () => false))) errors.reserve = "The Lender agent is not on this Safe yet. Add it first, then come back.";
      balanceUsd = await usdcBalance(services, input.chainId, reserve);
    }
  }
  const fieldErrors = policyErrors(String(input.triggerHf), String(input.dailyLimitUsd), balanceUsd);
  Object.assign(errors, fieldErrors);
  return { reserve, balanceUsd, errors, copy: reserveCopyV1({ triggerHf: input.triggerHf, dailyLimitUsd: input.dailyLimitUsd }, safeLabel(safe)) };
}

export type LinkResult = SendResult & { reserve: Address; roles: Address; executor: Address };

const rawLimit = (usd: number) => {
  try { return parseUnits(String(usd), 6); }
  catch { throw new HttpError(422, "The daily limit must use no more than six decimal places."); }
};

/** Validate, build the setup, store it as a proposal on the Reserve Safe and send it to that Safe's queue. */
export async function linkReserve(ctx: SafeContext, input: LinkInput, deps: { executor?: ExecutorSigner } = {}): Promise<LinkResult> {
  const { db, services, safe, wallet } = ctx;
  const chainId = input.chainId;
  if (!RESERVE_CHAINS.includes(chainId)) throw new HttpError(400, "The Reserve is not available on this network yet.");
  requireNetwork(ctx.access, chainId);
  // A revoke is confirmed from Roles membership, not from a loan monitor tick. This also lets
  // owners restore protection after closing their last loan on this network.
  await reconcilePolicyChanges({ db, services, now: new Date(), log: () => {} }, safe.id, chainId);
  const mainSafe = getAddress(safe.address) as Address;
  let existing = await reserveLinkOf(db, { address: mainSafe, chainId });
  let restoreRoles: Address | null = null;
  let restoreReserve: Address | null = null;
  if (existing?.state === "relinking") throw new HttpError(409, "Another Reserve setup is already being prepared. Refresh before trying again.");
  if (existing?.state === "pending" && existing.setupProposalId) {
    const [oldSetup] = await db.select().from(proposals).where(eq(proposals.id, existing.setupProposalId)).limit(1);
    if (["rejected", "failed", "stale", "stopped", "replaced"].includes(oldSetup?.stage ?? "")) {
      const [lastOff] = await db.select({ status: reservePolicyChanges.status }).from(reservePolicyChanges)
        .where(and(eq(reservePolicyChanges.safeId, safe.id), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off")))
        .orderBy(desc(reservePolicyChanges.createdAt)).limit(1);
      if (lastOff?.status === "applied") {
        await db.update(reserveLinks).set({ state: "off", updatedAt: new Date() })
          .where(and(eq(reserveLinks.id, existing.id), eq(reserveLinks.state, "pending")));
        existing = { ...existing, state: "off" };
      }
    } else if (oldSetup && (oldSetup.stage === "queued" || oldSetup.stage === "sending")) {
      const spec = oldSetup.spec as { restore?: boolean };
      if (spec.restore) restoreRoles = existing.rolesAddress as Address;
    }
  }
  if (existing?.state === "off") {
    const [openRevoke] = await db.select({ id: reservePolicyChanges.id }).from(reservePolicyChanges)
      .where(and(eq(reservePolicyChanges.safeId, safe.id), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off"), eq(reservePolicyChanges.status, "pending"))).limit(1);
    if (openRevoke) throw new HttpError(409, "Finish the pending Reserve permission revocation in Safe before setting up protection again.");
    const [lastRevoke] = await db.select({ status: reservePolicyChanges.status }).from(reservePolicyChanges)
      .where(and(eq(reservePolicyChanges.safeId, safe.id), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.kind, "off")))
      .orderBy(desc(reservePolicyChanges.createdAt)).limit(1);
    if (lastRevoke?.status !== "applied") throw new HttpError(409, "Confirm the Reserve permission was removed in Safe before setting up protection again.");
    const prior = await reserveReadout({ address: mainSafe, chainId }, { db, ttlMs: 0 }).catch(() => null);
    if (!prior || !prior.policy.moduleEnabled || prior.policy.executorIsMember) throw new HttpError(409, "The previous Reserve permission is still active. Confirm its removal in Safe before setting up protection again.");
    if (prior.policy.roles.toLowerCase() !== existing.rolesAddress.toLowerCase()) throw new HttpError(409, "The previous Reserve permission changed. Review it in Safe before setting up protection again.");
    if (prior.policy.issues.some((issue) => issue !== MISSING_ROLE_MEMBER_ISSUE)) {
      throw new HttpError(409, "The previous Reserve permission changed. Review it in Safe before setting up protection again.");
    }
    restoreRoles = prior.policy.roles;
    restoreReserve = prior.policy.reserve;
  }
  const check = await checkReserve(ctx, input);
  const firstError = check.errors.reserve ?? check.errors.cap ?? check.errors.hf;
  if (firstError) throw new HttpError(422, firstError);
  const reserve = check.reserve;
  if (restoreReserve && restoreReserve.toLowerCase() !== reserve.toLowerCase()) throw new HttpError(409, "Restore protection with the same Reserve Safe so its reviewed permission can be reused.");
  const executor = (deps.executor ?? executorFor(services)).address;
  if (executor.toLowerCase() === services.signer.address.toLowerCase()) throw new HttpError(500, "The reserve key must not be the proposer key.");
  // The agent proposes on the Reserve Safe, so it must be a delegate there (the same rule as every proposal).
  await assertAgentActive(services, chainId, reserve).catch(() => {
    throw new HttpError(409, "Add the Lender agent to the Reserve Safe first, then set up the reserve.");
  });

  // The Reserve Safe is a tracked Safe in our tables, so the proposal path (queue, follow, activity) works as it does for any Safe.
  const reserveRow = await trackReserveSafe(ctx, reserve, chainId);
  let attempt = existing ? existing.attempt + 1 : 0;
  if (existing && existing.state === "linked") throw new HttpError(409, "A Reserve Safe is already linked to this Safe.");
  if (existing && existing.state === "pending" && existing.setupProposalId) {
    // One setup at a time: each executed setup deploys its own Roles module with its own allowance.
    const [old] = await db.select().from(proposals).where(eq(proposals.id, existing.setupProposalId)).limit(1);
    if (old?.stage === "executed") {
      await db.update(reserveLinks).set({ state: "linked", updatedAt: new Date() }).where(and(eq(reserveLinks.id, existing.id), eq(reserveLinks.state, "pending")));
      clearReserveCache();
      throw new HttpError(409, "A Reserve Safe is already linked to this Safe.");
    }
    if (old && (old.stage === "queued" || old.stage === "sending")) {
      const same = existing.reserveSafeId === reserveRow.id && existing.dailyLimit === rawLimit(input.dailyLimitUsd).toString();
      if (!same) throw new HttpError(409, "An earlier setup is still waiting in the Reserve Safe's queue. Reject or delete it in Safe first, then set up again.");
      // The same setup again: reuse it (same salt, same proposal) instead of a second module.
      attempt = existing.attempt;
      if (existing.triggerHf !== input.triggerHf) await db.update(reserveLinks).set({ triggerHf: input.triggerHf, updatedAt: new Date() }).where(eq(reserveLinks.id, existing.id));
    }
  }

  const [block, onChain] = await Promise.all([
    isMock() ? Promise.resolve({ number: 0n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }) : getPublicClient(chainId).getBlock({ blockTag: "latest" }),
    services.reader.readSafeNonce(chainId, reserve),
  ]);
  const setup: ReserveSetup = restoreRoles
    ? buildReserveRestore({ chainId, reserveSafe: reserve, mainSafe, executor, roles: restoreRoles, originalSaltNonce: existing!.saltNonce, dailyLimit: rawLimit(input.dailyLimitUsd), nowSec: Number(block.timestamp), attempt }, onChain ?? 0n)
    : buildReserveSetup({ chainId, reserveSafe: reserve, mainSafe, executor, dailyLimit: rawLimit(input.dailyLimitUsd), nowSec: Number(block.timestamp), attempt }, onChain ?? 0n);
  assertSetupTargets(setup);
  const threshold = await services.reader.readSafeThreshold(chainId, reserve);
  const title = `${restoreRoles ? "Restore" : "Set up"} the Reserve: up to $${input.dailyLimitUsd.toLocaleString("en-US")} a day`;
  const outcome = `The agent can repay ${safeLabel(safe)}'s USDC debt on Aave from the Reserve Safe, up to $${input.dailyLimitUsd.toLocaleString("en-US")} a day, without a signature.`;
  const spec = { kind: "reserve-setup" as const, mainSafe, reserve, roles: setup.roles, executor, dailyLimitUsd: input.dailyLimitUsd, triggerHf: input.triggerHf, attempt, restore: !!restoreRoles };
  const key = createHash("sha256").update(`reserve:${chainId}:${mainSafe.toLowerCase()}:${reserve.toLowerCase()}:${attempt}`).digest("hex");

  const [dup] = await db.select().from(proposals).where(eq(proposals.idempotencyKey, key)).limit(1);
  let row = dup;
  if (!row) {
    const values = {
      mainSafeId: safe.id, reserveSafeId: reserveRow.id, chainId, rolesAddress: setup.roles.toLowerCase(), executorAddress: executor.toLowerCase(),
      saltNonce: setup.saltNonce, attempt, dailyLimit: setup.dailyLimit.toString(), triggerHf: input.triggerHf,
      fromBlock: restoreRoles ? existing!.fromBlock : block.number, state: "pending" as const, updatedAt: new Date(),
    };
    row = (await withNextProposalNonce(db, reserveRow.id, chainId, onChain ?? 0n, async (storage, nonce) => {
      if (existing?.state === "off") {
        const claimed = await storage.update(reserveLinks).set({ state: "relinking", attempt, updatedAt: new Date() })
          .where(and(eq(reserveLinks.id, existing.id), eq(reserveLinks.state, "off"), eq(reserveLinks.attempt, existing.attempt))).returning({ id: reserveLinks.id });
        if (!claimed.length) throw new HttpError(409, "Another Reserve setup is already being prepared. Refresh before trying again.");
      }
      const tx: SafeTx = { ...setup.tx, nonce: nonce.toString() };
      const [stored] = await storage.insert(proposals).values({
        id: randomUUID(), safeId: reserveRow.id, chainId, spec, tx, nonce, safeTxHash: safeTxHash(chainId, reserve, tx), idempotencyKey: key,
        title, steps: setup.steps, outcome, stage: "sending", threshold,
        testRun: { ok: true, feeUsd: 0, healthAfter: null, reason: null },
        createdBy: wallet.toLowerCase(),
      }).onConflictDoNothing().returning();
      if (!stored) throw new HttpError(409, "This setup is already queued.");
      const linkValues = { ...values, setupProposalId: stored.id };
      if (existing) {
        const stateAfterClaim = existing.state === "off" ? "relinking" : existing.state;
        const attemptAfterClaim = existing.state === "off" ? attempt : existing.attempt;
        const updated = await storage.update(reserveLinks).set(linkValues)
          .where(and(eq(reserveLinks.id, existing.id), eq(reserveLinks.state, stateAfterClaim), eq(reserveLinks.attempt, attemptAfterClaim))).returning({ id: reserveLinks.id });
        if (!updated.length) throw new HttpError(409, "Another Reserve setup is already being prepared. Refresh before trying again.");
      } else {
        await storage.insert(reserveLinks).values(linkValues);
      }
      return stored;
    }))!;
    clearReserveCache();
    await recordActivity(db, {
      safeId: safe.id, chainId, actor: "You", kind: "proposed", proposalId: row.id, eventKey: `reserve-setup:${row.id}`,
      text: `${restoreRoles ? "Reserve protection restore" : "Reserve setup"} drafted: up to $${input.dailyLimitUsd.toLocaleString("en-US")} a day, health trigger ${input.triggerHf.toFixed(2)}.`,
      detail: "It is waiting for the Reserve Safe's owners to sign in Safe.",
    });
  }
  const sent = resultOf(row.stage === "sending" ? await deliver(db, services, row, reserve) : row);
  return { ...sent, reserve, roles: setup.roles, executor };
}

/** The setup may only touch these: the factory, the Reserve Safe, the new modifier, USDC (approve to the Pool). */
function assertSetupTargets(s: ReserveSetup): void {
  const a = RESERVE_ASSET[s.chainId]!;
  const ok = new Set([s.reserveSafe, s.roles, a.usdc, MODULE_PROXY_FACTORY].map((x) => x.toLowerCase()));
  for (const c of s.calls) if (!ok.has(c.to.toLowerCase())) throw new Error(`The setup would call an address that is not allowed: ${c.to}`);
}

async function trackReserveSafe(ctx: SafeContext, reserve: Address, chainId: ChainId) {
  const { db } = ctx;
  const addr = reserve.toLowerCase();
  let [row] = await db.select().from(safes).where(eq(safes.address, addr)).limit(1);
  if (!row) [row] = await db.insert(safes).values({ address: addr, name: "Reserve Safe" }).returning();
  const [net] = await db.select().from(safeNetworks).where(and(eq(safeNetworks.safeId, row!.id), eq(safeNetworks.chainId, chainId))).limit(1);
  if (!net) await db.insert(safeNetworks).values({ safeId: row!.id, chainId, deployed: true, agentAdded: false });
  return row!;
}
