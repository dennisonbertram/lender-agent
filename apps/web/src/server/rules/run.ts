// Run the standing rule at a crossing (BP-25). The rule only chooses and drafts; the work is `fixOptionsFor` and
// `draftFix`, so the draft carries the same Test run. It never calls `sendFix`: nothing is queued until the
// owner presses Send to Safe on the fix card (architecture 2, rule 5).
// It acts for the owner who set it, and only while that owner still owns the Safe (G4). It runs once per
// alert: the claim row `rule_runs.alert_id` is written first.
import { eq } from "drizzle-orm";
import { recordActivity } from "@/server/activity";
import type { alerts } from "@/server/db/schema";
import { ruleRuns, safeNetworks, safes } from "@/server/db/schema";
import { draftFix, fixOptionsFor, type FixOptionKey } from "@/server/fixes";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import { servedOnly } from "@/server/auth/access";
import { getServices, type Services } from "@/server/services";
import type { Address, ChainId } from "@/shared/types";
import type { AlertDeps } from "@/server/alerts/crossing";
import { ruleDraftedLine, ruleNothingLine } from "./copy";
import { getRule } from "./store";

type AlertRow = typeof alerts.$inferSelect;
type Outcome = { outcome: "drafted" | "nothing"; line: string; draftId?: string };

/** What the rule did at this alert, as one sentence for the card and chat; null when the loan has no enabled rule. Never throws. */
export async function applyRule(deps: AlertDeps & { services?: Services }, a: AlertRow): Promise<string | null> {
  const { db, now, log } = deps;
  try {
    const [done] = await db.select().from(ruleRuns).where(eq(ruleRuns.alertId, a.id));
    if (done) return done.outcome === "running" ? await interrupted(deps, a) : done.line;
    const rule = await getRule(db, a.safeId, a.loanId);
    if (!rule || !rule.enabled) return null;
    const claimed = await db.insert(ruleRuns).values({ alertId: a.id, outcome: "running", line: "", createdAt: now }).onConflictDoNothing().returning();
    if (claimed.length === 0) return null; // another delivery owns this run; the next one reads its result
    const result = await attempt(deps, a, rule);
    await db.update(ruleRuns).set({ outcome: result.outcome, line: result.line, draftId: result.draftId ?? null }).where(eq(ruleRuns.alertId, a.id));
    await recordActivity(db, { safeId: a.safeId, chainId: a.chainId as ChainId, actor: "Agent", kind: "status", at: now, eventKey: `rule-run:${a.id}`, text: result.line });
    return result.line;
  } catch (e) {
    log(`rules: alert ${a.id} failed`, e);
    return null;
  }
}

async function interrupted(deps: AlertDeps, a: AlertRow): Promise<string> {
  const line = ruleNothingLine("the rule was interrupted, so check your Safe's queue before drafting again");
  await deps.db.update(ruleRuns).set({ outcome: "nothing", line }).where(eq(ruleRuns.alertId, a.id));
  return line;
}

async function attempt(deps: AlertDeps & { services?: Services }, a: AlertRow, rule: NonNullable<Awaited<ReturnType<typeof getRule>>>): Promise<Outcome> {
  const { db } = deps;
  const chainId = a.chainId as ChainId;
  const nothing = (reason: string): Outcome => ({ outcome: "nothing", line: ruleNothingLine(reason) });
  const [safe] = await db.select().from(safes).where(eq(safes.id, a.safeId));
  if (!safe) return nothing("the Safe is not tracked");
  const owners = await deps.reader.readSafeOwners(chainId, safe.address as Address);
  if (!owners || !owners.some((o) => o.toLowerCase() === rule.createdBy)) return nothing("the owner who set this rule no longer owns the Safe");
  const services = deps.services ?? getServices();
  const wallet = rule.createdBy as Address;
  const ctx: SafeContext = {
    db, services, wallet, safe, networks: (await db.select().from(safeNetworks).where(eq(safeNetworks.safeId, safe.id))).filter((n) => servedOnly([n.chainId]).length > 0),
    session: { userId: 0, address: wallet, chainId, expiresAt: new Date(deps.now.getTime() + 60_000) },
    access: { ownedChainIds: [chainId], trackedChainIds: [chainId], chat: true, ownersDiffer: false },
  };
  try {
    const opts = await fixOptionsFor(safe, { id: a.loanId, chainId }, { db, services });
    const picked = opts?.options.find((o) => o.k === rule.option);
    if (!opts || !picked) return nothing("the loan could not be read");
    if (picked.short) return nothing(picked.sub);
    const draft = await draftFix(ctx, { loanId: a.loanId, option: rule.option as FixOptionKey }, { onlyIfSendable: true });
    return { outcome: "drafted", line: ruleDraftedLine(draft.title), draftId: draft.id };
  } catch (e) {
    if (e instanceof HttpError) return nothing(e.message);
    throw e;
  }
}
