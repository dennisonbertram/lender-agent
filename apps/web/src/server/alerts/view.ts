// An alert as the chat card shows it (BP-20): the stored crossing plus the loan now. Every figure comes
// from the stored alert or the lender's live read (G1); the state is the domain library's `alertState`.
import { and, eq, gt, inArray } from "drizzle-orm";
import { alertOptions, alertState as stateOf, optionsNote, type AlertOption, type AlertState } from "@/lib/alerts";
import { cushionLine, alertTitle, severity } from "@/lib/loan-copy";
import { liquidationPrice } from "@/lib/loan-math";
import type { Amounts, Loan } from "@/lib/types";
import { alerts, proposals } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { loansFor } from "@/server/loans";
import { ruleOfAlert } from "@/server/rules/view";
import type { SafeContext } from "@/server/request";
import { lenderOfLoanId, venueOfLoanId } from "./venue";
import type { Address, ChainId } from "@/shared/types";

export type AlertView = {
  id: number;
  loanId: string;
  chainId: ChainId;
  /** Canonical lender identifier from the loan id; use this for behavior, never display copy. */
  lender: string;
  /** Server-validated Reserve coverage for the currently owned chain and live debt shape. */
  reserveEligibility: { eligible: boolean; reason: string | null };
  state: AlertState;
  /** The tag on a card that is no longer live ("Newer alert below", "Resolved"); null while live. */
  tag: string | null;
  title: string;
  cause: string | null;
  /** Health at the alert, and now (null when the loan is gone). */
  hf: number;
  liveHf: number | null;
  warn: number;
  act: number;
  asset: string | null;
  cushion: string | null;
  /** Severity "now": the card adds what liquidation means. */
  liquidatable: boolean;
  options: AlertOption[];
  note: string;
  /** What the owner's standing rule did at this alert (BP-25); null when it did not run. */
  rule: { outcome: "drafted" | "nothing"; line: string } | null;
  /** Signatures the Safe needs, for "Needs n signatures" under each option. */
  threshold: number;
  createdAt: string;
};

const TAGS: Partial<Record<AlertState, string>> = { replaced: "Newer alert below", resolved: "Resolved", closed: "Loan closed", outdated: "Out of date", fixing: "Fix waiting for signatures" };

export async function alertView(ctx: SafeContext, id: number): Promise<AlertView> {
  const { db, safe, access } = ctx;
  const [a] = await db.select().from(alerts).where(and(eq(alerts.id, id), eq(alerts.safeId, safe.id)));
  // G4: an alert on a network the wallet does not own is not there.
  if (!a || !access.ownedChainIds.includes(a.chainId as ChainId)) throw new HttpError(404, "Alert not found");
  const { loans, balancesByNetwork } = await loansFor(ctx);
  const loan = loans.find((l) => l.id.toLowerCase() === a.loanId);
  const [newer] = await db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.safeId, safe.id), eq(alerts.loanId, a.loanId), gt(alerts.id, a.id))).limit(1);
  const open = (await db.select().from(proposals)
    .where(and(eq(proposals.safeId, safe.id), eq(proposals.chainId, a.chainId), inArray(proposals.stage, ["draft", "queued", "sending"]))))
    .some((p) => (p.spec as { loanId?: string }).loanId?.toLowerCase() === a.loanId);
  const levels = loan?.levels ?? { warn: a.warn, act: a.act };
  // A loan with no debt has no health factor: it is safe, which reads as resolved.
  const liveHf = !loan ? null : loan.healthFactor ?? Number.POSITIVE_INFINITY;
  const state = stateOf({ hf: a.hf }, { newer: !!newer, liveHf, warn: levels.warn, openFix: open });

  const snap = a.snap as Loan | null;
  const lender = lenderOfLoanId(a.loanId);
  const debtAssets = loan?.onchain.debt.map((d) => d.symbol) ?? (snap ? [snap.debtAsset] : []);
  const ineligibility = a.chainId !== 8453 ? "Reserve protection works only for Aave loans on Base."
    : lender !== "aave-v3" ? "Reserve protection works only for Aave loans on Base."
    : debtAssets.length !== 1 || debtAssets[0] !== "USDC" ? "Reserve protection can only repay one USDC debt on Aave on Base."
    : null;
  const balances = Object.fromEntries(["ETH", "wstETH", "WBTC", "USDC", "DAI"].map((s) => [s, balancesByNetwork.find((n) => n.chainId === a.chainId)?.assets.find((x) => x.asset === s)?.amount ?? 0])) as Amounts;
  const sized = snap && a.price && a.addColl !== null && a.repay !== null ? { snap, price: a.price, addColl: a.addColl, repay: a.repay } : null;
  const options = sized ? alertOptions(sized, balances) : [];
  return {
    id: a.id, loanId: a.loanId, chainId: a.chainId as ChainId, lender, reserveEligibility: { eligible: ineligibility === null, reason: ineligibility }, state, tag: TAGS[state] ?? null,
    title: alertTitle(venueOfLoanId(a.loanId), a.hf), cause: a.cause, hf: a.hf, liveHf: liveHf !== null && Number.isFinite(liveHf) ? liveHf : null,
    warn: levels.warn, act: a.act, asset: snap?.collAsset ?? null,
    cushion: snap && a.price ? cushionLine(snap.collAsset, a.price, liquidationPrice(snap.collAmount, snap.lt, snap.debt), snap.debt) : null,
    liquidatable: severity(a.hf) === "now", options,
    note: sized ? optionsNote(options, sized.snap.collAsset) : a.price === null ? "Fix amounts are not estimated because the loan has mixed assets or a token price is unavailable. The health reading is still current." : "",
    rule: await ruleOfAlert(db, a.id),
    threshold: (await ctx.services.reader.readSafeThreshold(a.chainId as ChainId, safe.address as Address)) ?? 1,
    createdAt: a.createdAt.toISOString(),
  };
}
