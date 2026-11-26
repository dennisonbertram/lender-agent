// Repay part of a loan: one batch that pays exactly the amount the owner typed, in USDC from the
// Safe. The collateral stays locked; the debt falls by that amount (interest keeps accruing, so the
// remaining figure is an estimate). Unlike the at-risk fixes, nothing here is recalculated to a
// health-factor target. Like Close, the record is stored as "sending" before anything is signed,
// and `deliver` takes it to the queue.
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getAddress } from "viem";
import { centDigits, usd } from "@/lib/format";
import { healthFactor, DEFAULT_LEVELS } from "@/lib/loan-math";
import { compute, type Spec } from "@/lib/proposals";
import { requireNetwork } from "@/server/auth/access";
import { assertAgentActive } from "@/server/agent-role";
import { buildRepay, type Built } from "@/server/aave/build";
import { adapterFor } from "@/server/lenders";
import type { Db } from "@/server/db/client";
import { proposals } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { liveInputs, M1_NETWORKS } from "@/server/market-inputs";
import type { SafeContext } from "@/server/request";
import { safeTxHash } from "@/server/safe/hash";
import { parseLoanId } from "./close";
import { testRun } from "./test-run";
import { deliver, resultOf, SendBlocked, withNextProposalNonce, type SendResult } from "./send";
import { type Address, type ChainId, type SafeTx } from "@/shared/types";

/** The stored spec of a partial repay: the loan, the exact amount, and the debt it was drafted against. */
export type StoredRepaySpec = Extract<Spec, { kind: "repay" }> & { venue: string; /** USDC owed when drafted (debt + accrued): the "about X stays owed" of the review. */ owed: number; /** The lender's own market the batch repays on (absent for Aave, whose account is single). */ marketId?: string; /** The collateral side of a lender market, needed to account for shared Compound markets. */ collateral?: string };

/** A dollar amount the owner typed is supported to the cent: `String` gives the decimal back verbatim,
 * so a value that passes this converts to exact token units (`toUnits` reads the same string). */
function centAmount(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) throw new HttpError(400, "Enter how much to repay.");
  const frac = String(n).split(".")[1] ?? "";
  if (frac.length > 2 || /e/i.test(String(n))) {
    throw new HttpError(400, "Repay in whole cents — up to two decimals, like 200.50.");
  }
  return n;
}

/** Stages in which a repay still counts as the loan's open proposal for its amount. */
const OPEN = ["draft", "sending", "queued"];

function clientIntentKey(chainId: number, safe: string, key: string): string {
  return createHash("sha256").update(`repay-intent:v1:${chainId}:${safe.toLowerCase()}:${key}`).digest("hex");
}

/** Re-read the exact position and Safe funds before signing or sending a queued partial repayment. */
export async function repayEligibility(services: SafeContext["services"], chainId: ChainId, safe: Address, spec: StoredRepaySpec): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (typeof spec.amount !== "number" || !Number.isFinite(spec.amount) || spec.amount <= 0) {
    return { ok: false, reason: "This repayment has no valid amount. Review the loan and create a new repayment." };
  }
  if (spec.loanId.split(":")[2] === "compound-v3") {
    return { ok: false, reason: "Compound v3 can supply the part above the remaining debt. This repayment is unavailable; close the loan when you intend to repay it in full." };
  }
  let inputs;
  try {
    inputs = await liveInputs(services.reader, chainId, safe, services.lenders);
  } catch {
    return { ok: false, reason: "The loan or Safe balance could not be read right now. Try again in a moment." };
  }
  const lender = spec.loanId.split(":")[2];
  const facts = inputs.lenders.find((f) => f.id === lender);
  if (!facts || facts.readFailed) return { ok: false, reason: `${facts?.name ?? "The lender"} could not be read right now. Try again in a moment.` };
  const loan = facts.loan;
  const position = facts.position;
  if (!loan || (spec.marketId && (!position || position.marketId.toLowerCase() !== spec.marketId.toLowerCase()))) {
    return { ok: false, reason: "The selected loan market changed or is no longer available. Review the loan before signing or sending." };
  }
  const owed = loan.debt + loan.accrued;
  if (owed < spec.amount) return { ok: false, reason: "The loan now owes less than this repayment amount. Review the loan and create a new repayment." };
  if (inputs.balances.USDC < spec.amount) return { ok: false, reason: "The Safe no longer has enough USDC for this repayment. Add funds and create a new repayment." };
  return { ok: true };
}

export async function repayLoan(ctx: SafeContext, input: { loanId: string; amount?: number; idempotencyKey?: string }): Promise<SendResult> {
  const { db, services, safe, wallet } = ctx;
  const safeAddress = getAddress(safe.address) as Address;
  const { chainId, lender } = parseLoanId(input.loanId, safeAddress);
  requireNetwork(ctx.access, chainId);
  await assertAgentActive(services, chainId, safeAddress);
  const amount = centAmount(input.amount);

  const suppliedKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (suppliedKey && (suppliedKey.length < 8 || suppliedKey.length > 200 || /[\u0000-\u001f]/.test(suppliedKey))) {
    throw new HttpError(400, "That repayment request key is invalid.");
  }
  const key = suppliedKey ? clientIntentKey(chainId, safeAddress, suppliedKey) : null;
  if (key) {
    const [prior] = await db.select().from(proposals).where(eq(proposals.idempotencyKey, key)).limit(1);
    if (prior) {
      const s = prior.spec as { kind?: string; loanId?: string; amount?: number };
      if (s.kind !== "repay" || s.loanId !== input.loanId || s.amount !== amount) throw new HttpError(409, "That repayment request key was already used for a different loan or amount.");
      return resultOf(prior.stage === "sending" ? await deliver(db, services, prior, safeAddress) : prior);
    }
  }

  const inputs = await liveInputs(services.reader, chainId, safeAddress, services.lenders);
  const facts = inputs.lenders.find((f) => f.id === lender);
  const loan = facts?.loan ?? null;
  if (!facts || !loan) {
    if (facts?.readFailed) throw new HttpError(503, `${facts.name} could not be read right now. Try again in a moment.`);
    if (facts?.unavailable || (lender === "aave-v3" && inputs.unavailable)) throw new HttpError(409, "Repaying this loan is not available for this Safe yet.");
    throw new HttpError(409, "This Safe has no loan to repay.");
  }
  if (lender === "compound-v3") throw new HttpError(409, "Compound v3 partial repayments are unavailable because an amount above the remaining debt can be supplied as collateral. Close the loan to repay it in full.");
  const owed = loan.debt + loan.accrued;
  if (owed <= 0) throw new HttpError(409, "This loan has no debt to repay.");
  const collateral: "WETH" | "wstETH" = loan.collAsset === "wstETH" ? "wstETH" : "WETH";

  // One open proposal per loan: a changed amount must not leave two executable repayments in Safe.
  const findOpen = async (storage: Pick<Db, "select">) => {
    const open = await storage.select().from(proposals)
      .where(and(eq(proposals.safeId, safe.id), eq(proposals.chainId, chainId), inArray(proposals.stage, OPEN)));
    return open.find((r) => {
      const s = r.spec as { kind?: string; loanId?: string; amount?: number };
      return s.kind === "repay" && s.loanId === loan.id;
    });
  };
  const existing = await findOpen(db);
  if (existing) {
    const s = existing.spec as { amount?: number };
    if (s.amount !== amount) throw new HttpError(409, "A repayment for this loan is already in your Safe queue. Finish or remove it before requesting a different amount.");
    return resultOf(existing.stage === "sending" ? await deliver(db, services, existing, safeAddress) : existing);
  }

  // Queue deletion does not revoke signatures. Hold a repayment reservation until its Safe nonce
  // passes even when the Transaction Service no longer lists the old entry.
  const historical = await db.select().from(proposals)
    .where(and(eq(proposals.safeId, safe.id), eq(proposals.chainId, chainId), inArray(proposals.stage, ["stale", "rejected", "stopped", "replaced"])));
  const onChainNow = await services.reader.readSafeNonce(chainId, safeAddress).catch(() => null);
  if (onChainNow === null) throw new HttpError(503, "We couldn’t check which requests your Safe can still send. Try again.");
  for (const prior of historical) {
    const s = prior.spec as { kind?: string; loanId?: string };
    if (s.kind !== "repay" || s.loanId !== loan.id || prior.nonce === null || onChainNow > prior.nonce) continue;
    const unsignedDeleted = prior.stage === "rejected"
      && prior.confirmations.length === 0
      && (prior.testRun as { confirmedUnsignedDeletion?: boolean } | null)?.confirmedUnsignedDeletion === true;
    if (unsignedDeleted) continue;
    throw new HttpError(409, "An earlier repayment can still go through, even if it no longer appears in the queue. Open Activity to review it with the other owners before starting another repayment.");
  }

  if (amount >= owed) {
    const reason = `That is everything this loan owes ${usd(owed, centDigits(owed))} ${loan.debtAsset} or more. To repay it all and get your ${loan.collAsset} back, close the loan.`;
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }
  const held = inputs.balances.USDC;
  if (held < amount) {
    // Rounded up to the cent (the epsilon eats float noise): the Safe must hold at least this much more.
    const missing = Math.ceil((amount - held) * 100 - 1e-6) / 100;
    const reason = `To repay ${usd(amount, centDigits(amount))} ${loan.debtAsset} I need that much in the Safe. It holds ${usd(held, centDigits(held))}. Add ${usd(missing, centDigits(missing))} more USDC and ask again.`;
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }

  let built: Built;
  if (lender === "aave-v3") {
    built = buildRepay({ chainId, safe: safeAddress, asset: "USDC", amount });
  } else {
    built = adapterFor(lender).buildRepay({ lender, chainId, marketId: facts.position!.marketId, collateral }, safeAddress, amount);
  }
  const healthBefore = lender === "aave-v3" ? inputs.position?.healthFactor ?? null : facts.position?.health ?? null;
  const remaining = Math.max(0, owed - amount);
  // The simulation only reads Aave's account; for the other lenders health after is computed here the same way.
  const prices = { ...inputs.prices, ...facts.prices };
  const predicted = healthFactor(loan.collAmount * (prices[loan.collAsset] ?? 0), loan.lt, remaining);
  const spec = { kind: "repay" as const, loanId: loan.id, amount };
  const tr = await testRun({
    chainId, safe: safeAddress, spec, repay: built,
    healthBefore: healthBefore !== null && Number.isFinite(healthBefore) ? healthBefore : null, atRiskLevel: DEFAULT_LEVELS.act,
    ...(lender === "aave-v3" ? {} : { predictedHealthAfter: predicted }),
  }, services.testRunDeps);
  if (!tr.canSend) throw new SendBlocked(tr.reason ?? "The test run did not pass.", tr.line);

  const shown = compute(spec, inputs.lenders.flatMap((f) => (f.loan ? [f.loan] : [])), { prices, venues: inputs.venues, networks: M1_NETWORKS, feeEstimateUsd: tr.feeUsd });
  const steps = [...built.steps]; // the builder's own steps: the approval shown is the one signed
  const stored: StoredRepaySpec = { ...spec, venue: loan.venue, owed, collateral: facts.position?.collateral[0]?.asset ?? loan.collAsset, ...(facts.position?.marketId ? { marketId: facts.position.marketId } : {}) };

  const onChain = (await services.reader.readSafeNonce(chainId, safeAddress)) ?? 0n;
  const threshold = await services.reader.readSafeThreshold(chainId, safeAddress);
  // Legacy callers receive a new key; modern clients provide a stable key for an intent and reuse it after lost responses.
  const proposalKey = key ?? createHash("sha256").update(`repay:${chainId}:${safe.address.toLowerCase()}:${randomUUID()}`).digest("hex");
  const row = await withNextProposalNonce(db, safe.id, chainId, onChain, async (storage, nonce) => {
    const open = await findOpen(storage);
    if (open) {
      const s = open.spec as { amount?: number };
      if (s.amount !== amount) throw new HttpError(409, "A repayment for this loan is already in your Safe queue. Finish or remove it before requesting a different amount.");
      return open;
    }
    const tx: SafeTx = { ...tr.tx, nonce: nonce.toString() };
    const hash = safeTxHash(chainId, safeAddress, tx);
    const [inserted] = await storage.insert(proposals).values({
      id: randomUUID(), safeId: safe.id, chainId, spec: stored, tx, nonce, safeTxHash: hash, idempotencyKey: proposalKey,
      title: shown.title, steps, outcome: shown.outcome, stage: "sending", threshold,
      testRun: { ok: tr.ok, feeUsd: tr.feeUsd, healthAfter: Number.isFinite(tr.healthAfter) ? tr.healthAfter : null, reason: tr.reason ?? null },
      createdBy: wallet.toLowerCase(),
    }).onConflictDoNothing({ target: proposals.idempotencyKey }).returning();
    if (inserted) return inserted;
    const [twin] = await storage.select().from(proposals).where(eq(proposals.idempotencyKey, proposalKey)).limit(1);
    if (twin) {
      const s = twin.spec as { loanId?: string; amount?: number };
      if (s.loanId !== loan.id || s.amount !== amount) throw new HttpError(409, "That repayment request key was already used for a different loan or amount.");
      return twin;
    }
    const [sameTx] = await storage.select().from(proposals).where(and(eq(proposals.chainId, chainId), eq(proposals.safeTxHash, hash))).limit(1);
    if (!sameTx) throw new HttpError(503, "The repayment could not be saved. Retry the same request key.");
    return sameTx;
  });
  return resultOf(row.stage === "sending" ? await deliver(db, services, row, safeAddress) : row);
}
