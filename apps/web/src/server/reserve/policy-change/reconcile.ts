// Policy changes and turn-offs the owners have signed: seen on the chain (or, for the off-chain trigger, as an
// executed Reserve Safe transaction), applied to the app, and logged in Activity with `policyLogText`.
import { and, eq } from "drizzle-orm";
import { policyLogText } from "@/lib/activity-copy";
import { recordActivity } from "@/server/activity";
import type { Db } from "@/server/db/client";
import { reservePolicyChanges } from "@/server/db/schema";
import { getServices, type Services } from "@/server/services";
import type { ChainId, Hex } from "@/shared/types";
import { getReserveRuntime } from "../executor/runtime";
import { applyReserveRevocation, loadReserveLink, setReserveTrigger } from "../executor/store";

type Deps = { db: Db; now: Date; log: (m: string, d?: unknown) => void; services?: Services };

/** For each pending change of this Safe and network: has the chain caught up? Then apply it and log it once. */
export async function reconcilePolicyChanges(deps: Deps, safeId: number, chainId: ChainId): Promise<void> {
  const { db, now, log } = deps;
  const pending = await db.select().from(reservePolicyChanges).where(and(eq(reservePolicyChanges.safeId, safeId), eq(reservePolicyChanges.chainId, chainId), eq(reservePolicyChanges.status, "pending")));
  if (!pending.length) return;
  const link = await loadReserveLink(db, safeId, chainId);
  if (!link) return;
  const services = deps.services ?? getServices();
  const rt = getReserveRuntime(services, log);
  for (const c of pending) {
    try {
      const read = await rt.chain.read(link);
      const state = read.allowance;
      const unit = 10 ** link.tokenDecimals;
      // An off was flagged at once, when it was asked for, so the "before" of an off is still on.
      const prev = { armed: c.kind === "off" ? true : link.active, emergencyHF: c.prevTrigger, dailyCapUsd: Number(c.prevLimitRaw) / unit, usedUsd24h: 0 };
      let applied = false;
      if (c.kind === "off") applied = !read.executorIsMember;
      // A matching allowance is no proof: a change counts only once its own Safe transaction was executed.
      else applied = await rt.chain.wasExecuted(link, c.safeTxHash as Hex, BigInt(c.fromBlock));
      if (!applied) continue;
      const next = { ...prev, dailyCapUsd: Number(state.maxRefill) / unit, emergencyHF: link.trigger, ...(c.kind === "off" ? { armed: false } : {}), ...(c.newTrigger !== null ? { emergencyHF: c.newTrigger } : {}), ...(c.newLimitRaw !== null ? { dailyCapUsd: Number(c.newLimitRaw) / unit } : {}) };
      if (c.kind === "off") {
        // `link` is the generation read before the external chain check. Finalize the off flag
        // and pending change together so a delayed poll cannot stop a later restore.
        if (!await applyReserveRevocation(db, safeId, chainId, c.id, link.attempt, now)) continue;
      } else {
        if (c.newTrigger !== null) await setReserveTrigger(db, safeId, chainId, c.newTrigger);
        const [updated] = await db.update(reservePolicyChanges).set({ status: "applied", appliedAt: now })
          .where(and(eq(reservePolicyChanges.id, c.id), eq(reservePolicyChanges.status, "pending"))).returning({ id: reservePolicyChanges.id });
        if (!updated) continue;
      }
      await recordActivity(db, { safeId, chainId, actor: "You", kind: "status", at: now, eventKey: `reserve-policy:${c.id}`,
        text: policyLogText(prev, next), detail: c.kind === "off" ? "The permission on-chain is removed." : null });
    } catch (e) {
      log(`reserve: policy change ${c.id} not checked`, e);
    }
  }
}
