// Out-of-date proposals (BP-16). An open proposal is stale when the loan or balances it was drafted
// against changed so it no longer matches (`isStale`), or when the Safe's nonce moved past its own.
// Checked on each worker tick and before render. A read that fails never marks anything stale.
import { and, eq, inArray } from "drizzle-orm";
import { getAddress } from "viem";
import type { Proposal, Spec } from "@/lib/proposals";
import { isStale } from "@/lib/threads";
import type { Safe } from "@/lib/types";
import { recordActivity } from "@/server/activity";
import type { Db } from "@/server/db/client";
import { fixDrafts, proposals, safes } from "@/server/db/schema";
import { fixOptionsFor } from "@/server/fixes/options";
import { pendingExecOf } from "@/server/proposals/pending";
import { liveInputs, M1_NETWORKS } from "@/server/market-inputs";
import { lenderOfSpec } from "@/server/proposals/lender-of";
import { loansOf, roundedVenue } from "@/server/quote";
import type { Services } from "@/server/services";
import type { Address, ChainId, Hex } from "@/shared/types";

/** Stages a proposal can still go out of date in. ("sending" is settled by the sender first.) */
const CHECKED = ["draft", "queued"];

const fixDraftOf = async (db: Db, proposalId: string) => (await db.select().from(fixDrafts).where(eq(fixDrafts.proposalId, proposalId)).limit(1))[0];

/** Recheck one open proposal against live chain data; returns true when it was marked stale. */
export async function checkStale(db: Db, services: Services, proposalId: string): Promise<boolean> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!row || !CHECKED.includes(row.stage)) return false;
  const [safeRow] = await db.select().from(safes).where(eq(safes.id, row.safeId)).limit(1);
  if (!safeRow || !(row.spec as Partial<Spec> | null)?.kind) return false; // nothing typed to compare with
  const chainId = row.chainId as ChainId;
  const safe = getAddress(safeRow.address) as Address;

  let stale = false;
  try {
    if (row.stage === "queued") {
      // An executed one is the follower's to settle: the loan changing is exactly what it did.
      const live = row.safeTxHash ? await services.safeService(chainId).getMultisigTransaction(row.safeTxHash as Hex) : null;
      if (live?.isExecuted) return false;
      // An execution was just sent from an owner's wallet: the service may not have indexed it yet.
      if (pendingExecOf(row.testRun)) return false;
      const nonce = await services.reader.readSafeNonce(chainId, safe);
      if (nonce !== null && row.nonce !== null && nonce > row.nonce) stale = true;
    }
    if (!stale && ["reserve-setup", "reserve-off"].includes((row.spec as { kind?: string }).kind ?? "")) {
      // The Reserve setup is not drafted against a loan or balances: only the Safe nonce above makes it out of date.
    } else if (!stale && (row.spec as Spec).kind === "close") {
      // A close is out of date when its approval no longer covers it: the lender's current debt is above
      // the approved amount, the Safe holds less stablecoin than that, or the signing deadline passed.
      // A read that failed is "cannot check"; only a successful read with no position means the loan is gone.
      const spec = row.spec as { loanId: string; approved?: number; deadline?: string };
      if (spec.deadline && Date.parse(spec.deadline) < Date.now()) stale = true;
      else {
        const inputs = await liveInputs(services.reader, chainId, safe, services.lenders);
        const facts = inputs.lenders.find((l) => l.id === lenderOfSpec(row.spec as Spec));
        if (!facts || /could not be read/.test(facts.note ?? "")) return false;
        const loan = facts.loan;
        stale = !loan
          || (spec.approved !== undefined && (inputs.balances.USDC < spec.approved || loan.debt + loan.accrued > spec.approved));
      }
    } else if (!stale && (row.spec as Spec).kind === "repay") {
      // A partial repay is out of date only when it can no longer pay its amount: the loan is gone,
      // the debt fell below it, or the Safe no longer holds the USDC. Debt that grew stays valid.
      const spec = row.spec as { loanId?: string; amount?: number };
      if (typeof spec.amount !== "number" || !Number.isFinite(spec.amount)) return false; // no amount to compare: cannot check
      const inputs = await liveInputs(services.reader, chainId, safe, services.lenders);
      const facts = inputs.lenders.find((l) => l.id === lenderOfSpec(row.spec as Spec));
      if (!facts || facts.readFailed) return false;
      const loan = facts.loan;
      const selectedMarket = (row.spec as { marketId?: string }).marketId;
      const marketChanged = !!selectedMarket && (!facts.position || facts.position.marketId.toLowerCase() !== selectedMarket.toLowerCase());
      stale = !loan || marketChanged || loan.debt + loan.accrued < spec.amount || inputs.balances.USDC < spec.amount;
    } else if (!stale && (row.spec as Spec).kind === "protect" && (await fixDraftOf(db, row.id))) {
      // A fix's stored steps come from the Test run (with its Allow steps), not from `compute`, so they cannot be compared as text.
      // Compare like with like: the amounts the same option would be sized at now against the amounts that were sent.
      const spec = row.spec as Extract<Spec, { kind: "protect" }>;
      const draft = (await fixDraftOf(db, row.id))!;
      const opts = await fixOptionsFor({ id: safeRow.id, address: safeRow.address }, { id: spec.loanId, chainId }, { db, services });
      if (!opts) return false; // the lender could not be read: cannot check
      const fresh = opts.options.find((o) => o.k === draft.option);
      stale = !!fresh && (fresh.addColl !== spec.addColl || fresh.repay !== spec.repay);
    } else if (!stale) {
      const inputs = await liveInputs(services.reader, chainId, safe, services.lenders);
      // The proposal's own lender: an open names its venue, a protect names it in the loan id (`chain:safe:lender`).
      const spec = row.spec as Spec;
      const lenderId = lenderOfSpec(spec);
      const facts = inputs.lenders.find((l) => l.id === lenderId);
      // A lender that could not be read is "cannot check" (the next tick looks again), never "changed".
      if (!facts || /could not be read/.test(facts.note ?? "")) return false;
      const venues = facts.venue && !facts.unavailable ? [roundedVenue(facts.venue)] : [];
      const fee = (row.testRun as { feeUsd?: number } | null)?.feeUsd ?? 0;
      const p = { id: row.id, spec, title: row.title, steps: row.steps } as Proposal;
      const balances: Safe["balances"] = { [inputs.network]: inputs.balances };
      try {
        stale = isStale(p, loansOf(inputs), balances, { prices: { ...inputs.prices, ...facts.prices }, venues, networks: M1_NETWORKS, feeEstimateUsd: fee });
      } catch {
        stale = true; // the plan can no longer be computed (market gone): it does not match
      }
    }
  } catch {
    return false;
  }
  if (!stale) return false;

  const [updated] = await db.update(proposals).set({ stage: "stale", updatedAt: new Date() })
    .where(and(eq(proposals.id, row.id), inArray(proposals.stage, CHECKED))).returning({ id: proposals.id });
  if (!updated) return false;
  await recordActivity(db, {
    safeId: row.safeId, chainId, actor: "Agent", kind: "status", proposalId: row.id, eventKey: `stale:${row.id}`, safeTxHash: row.safeTxHash,
    text: `"${row.title}" is out of date: the loan changed.${row.stage === "queued" ? " It is still in your Safe queue." : ""}`,
  });
  return true;
}

/** Recheck every open proposal (on each tick). */
export async function markStaleAll(db: Db, services: Services): Promise<void> {
  const open = await db.select({ id: proposals.id }).from(proposals).where(inArray(proposals.stage, CHECKED));
  for (const { id } of open) {
    try { await checkStale(db, services, id); } catch { /* next tick */ }
  }
}
