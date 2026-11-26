// Standing rules (BP-25): one per loan, saved by an owner. Every change is an Activity row (G3).
import { and, eq } from "drizzle-orm";
import { recordActivity } from "@/server/activity";
import { requireNetwork } from "@/server/auth/access";
import { standingRules } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { loansFor } from "@/server/loans";
import type { SafeContext } from "@/server/request";
import { isChainId } from "@/shared/types";
import { RULE_OPTIONS, ruleNote, ruleOptionName, type RuleOption } from "./copy";

export type RuleView = { option: RuleOption; enabled: boolean };
export type RulePanelLoan = { loanId: string; lender: string; asset: string; rule: RuleView | null; note: string };

const chainIdOf = (loanId: string) => Number(loanId.split(":")[0]);

function checkLoanId(ctx: SafeContext, loanId: string) {
  const chainId = chainIdOf(loanId);
  if (!isChainId(chainId) || !loanId.toLowerCase().includes(`:${ctx.safe.address.toLowerCase()}:`)) throw new HttpError(404, "Loan not found");
  requireNetwork(ctx.access, chainId);
  return chainId;
}

const where = (safeId: number, loanId: string) => and(eq(standingRules.safeId, safeId), eq(standingRules.loanId, loanId.toLowerCase()));

export async function getRule(db: SafeContext["db"], safeId: number, loanId: string) {
  return (await db.select().from(standingRules).where(where(safeId, loanId)).limit(1))[0] ?? null;
}

async function lenderOf(ctx: SafeContext, loanId: string): Promise<string> {
  const loan = (await loansFor(ctx)).loans.find((l) => l.id.toLowerCase() === loanId.toLowerCase());
  if (!loan) throw new HttpError(404, "Loan not found");
  return loan.lender;
}

/** Create or change the loan's rule. Saving by another owner makes that owner the one the rule acts for. */
export async function saveRule(ctx: SafeContext, loanId: string, input: { option: RuleOption; enabled: boolean }): Promise<RuleView> {
  const chainId = checkLoanId(ctx, loanId);
  if (!RULE_OPTIONS.includes(input.option) || typeof input.enabled !== "boolean") throw new HttpError(400, "Choose what the rule should draft.");
  const lender = await lenderOf(ctx, loanId);
  const before = await getRule(ctx.db, ctx.safe.id, loanId);
  const now = new Date();
  const row = { safeId: ctx.safe.id, chainId, loanId: loanId.toLowerCase(), option: input.option, enabled: input.enabled, createdBy: ctx.wallet.toLowerCase(), updatedAt: now };
  await ctx.db.insert(standingRules).values(row).onConflictDoUpdate({ target: [standingRules.safeId, standingRules.loanId], set: row });
  const text = !before ? `Set a standing rule for ${lender}: ${ruleOptionName(input.option)} when it falls below your At-risk level.`
    : before.enabled && !input.enabled ? `Turned off the standing rule for ${lender}.`
    : !before.enabled && input.enabled && before.option === input.option ? `Turned on the standing rule for ${lender}: ${ruleOptionName(input.option)}.`
    : `Changed the standing rule for ${lender}: ${ruleOptionName(input.option)}${input.enabled ? "" : " (off)"}.`;
  await recordActivity(ctx.db, {
    safeId: ctx.safe.id, chainId, actor: "You", actorAddress: ctx.wallet, kind: "status", at: now, text,
    detail: before ? `Before: ${ruleOptionName(before.option as RuleOption)}, ${before.enabled ? "on" : "off"}.` : "The agent drafts it in the alert. You press Send to Safe, then sign.",
  });
  return { option: input.option, enabled: input.enabled };
}

export async function deleteRule(ctx: SafeContext, loanId: string): Promise<void> {
  const chainId = checkLoanId(ctx, loanId);
  const before = await getRule(ctx.db, ctx.safe.id, loanId);
  if (!before) throw new HttpError(404, "There is no rule for this loan.");
  const lender = await lenderOf(ctx, loanId).catch(() => "this loan");
  await ctx.db.delete(standingRules).where(where(ctx.safe.id, loanId));
  await recordActivity(ctx.db, {
    safeId: ctx.safe.id, chainId, actor: "You", actorAddress: ctx.wallet, kind: "status",
    text: `Deleted the standing rule for ${lender}.`, detail: `It was: ${ruleOptionName(before.option as RuleOption)}, ${before.enabled ? "on" : "off"}.`,
  });
}

/** Every loan of the Safe with its rule (or none) and the sentence Settings shows under it. */
export async function rulePanel(ctx: SafeContext): Promise<{ loans: RulePanelLoan[] }> {
  const { loans } = await loansFor(ctx);
  const out: RulePanelLoan[] = [];
  for (const l of loans) {
    const row = await getRule(ctx.db, ctx.safe.id, l.id);
    const rule = row ? { option: row.option as RuleOption, enabled: row.enabled } : null;
    out.push({
      loanId: l.id, lender: l.lender, asset: l.collateral.length === 1 ? l.collateral[0].asset : "collateral", rule,
      note: ruleNote({ lender: l.lender, option: rule?.option ?? "repay", agentActive: l.watched, enabled: rule?.enabled ?? false, belowNow: l.healthFactor !== null && l.healthFactor < l.levels.act }),
    });
  }
  return { loans: out };
}
