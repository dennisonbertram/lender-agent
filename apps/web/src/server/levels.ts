// Alert levels per loan (BP-19): validate with the domain library's `levelErrors`, save, and say what the
// loan now shows. Nothing is saved on invalid input.
import { eq } from "drizzle-orm";
import { DEFAULT_LEVELS, healthStatus, levelErrors, parseLevels, type HealthStatus, type Levels } from "@/lib/loan-math";
import { levelsSavedText } from "@/lib/settings-copy";
import { recordActivity } from "@/server/activity";
import type { Db } from "@/server/db/client";
import { loanLevels } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { loansFor } from "@/server/loans";
import type { SafeContext } from "@/server/request";
import { isChainId } from "@/shared/types";

/** Saved levels of the Safe's loans by loan id (lowercase); a loan with no row uses the defaults. */
export async function levelsByLoan(db: Db, safeId: number): Promise<Map<string, Levels>> {
  const rows = await db.select().from(loanLevels).where(eq(loanLevels.safeId, safeId));
  return new Map(rows.map((r) => [r.loanId.toLowerCase(), { warn: r.warn, act: r.act }]));
}

/** The levels a loan's status is judged by: the owner's saved ones, else the defaults. The one place every status computation reads them. */
export const levelsFor = (saved: Map<string, Levels>, loanId: string): Levels => saved.get(loanId.toLowerCase()) ?? DEFAULT_LEVELS;

/** The levels the Test run and the quote judge a plan by: an existing loan's saved ones (else the defaults); a brand-new loan (`loanId` undefined) uses the defaults. */
export async function levelsForPlan(db: Db, safeId: number, loanId: string | undefined): Promise<Levels> {
  return loanId ? levelsFor(await levelsByLoan(db, safeId), loanId) : DEFAULT_LEVELS;
}

export type SavedLevels = { levels: Levels; status: HealthStatus; message: string };

export async function saveLevels(ctx: SafeContext, loanId: string, warn: string, act: string): Promise<SavedLevels> {
  const { db, safe, access } = ctx;
  const chainId = Number(loanId.split(":")[0]);
  if (!isChainId(chainId) || !loanId.toLowerCase().includes(`:${safe.address.toLowerCase()}:`)) throw new HttpError(404, "Loan not found");
  if (!access.ownedChainIds.includes(chainId)) throw new HttpError(403);
  const errors = levelErrors(warn, act);
  const message = errors.warn ?? errors.act;
  const levels = parseLevels(warn, act);
  if (message || !levels) throw new HttpError(400, message ?? "Enter both levels.");
  const loan = (await loansFor(ctx)).loans.find((l) => l.id.toLowerCase() === loanId.toLowerCase());
  if (!loan) throw new HttpError(404, "Loan not found");
  const before = loan.levels ?? DEFAULT_LEVELS;
  const id = loan.id.toLowerCase();
  const row = { safeId: safe.id, loanId: id, chainId, warn: levels.warn, act: levels.act, updatedAt: new Date() };
  await db.insert(loanLevels).values(row).onConflictDoUpdate({ target: [loanLevels.safeId, loanLevels.loanId], set: row });
  const hf = loan.healthFactor ?? Number.POSITIVE_INFINITY;
  await recordActivity(db, {
    safeId: safe.id, chainId, actor: "You", kind: "status",
    text: `Changed alert levels for ${loan.lender}: Watch ${levels.warn}, At-risk ${levels.act}.`,
    detail: `Before: Watch ${before.warn}, At-risk ${before.act}.`,
  });
  return { levels, status: healthStatus(hf, levels.warn, levels.act), message: levelsSavedText(loan.lender, hf, before, levels) };
}
