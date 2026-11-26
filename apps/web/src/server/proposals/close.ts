// Close a loan (BP-26): one batch that repays all the debt from the Safe's USDC and takes all the
// collateral back to the Safe. The amounts come from the lender's own position read now; the Test
// run must pass before anything is stored. Like Send, the record is stored as "sending" before
// anything is signed, and `deliver` takes it to the queue.
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getAddress } from "viem";
import { usd } from "@/lib/format";
import { compute, type Spec } from "@/lib/proposals";
import { DEFAULT_LEVELS } from "@/lib/loan-math";
import { requireNetwork } from "@/server/auth/access";
import { assertAgentActive } from "@/server/agent-role";
import { buildClose, closeAllowance, MAX_SIGNING_DELAY_SECONDS, type Built } from "@/server/aave/build";
import { adapterFor, type LenderId } from "@/server/lenders";
import type { Db } from "@/server/db/client";
import { proposals } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { liveInputs, M1_NETWORKS } from "@/server/market-inputs";
import type { SafeContext } from "@/server/request";
import { safeTxHash } from "@/server/safe/hash";
import { testRun } from "./test-run";
import { deliver, resultOf, SendBlocked, withNextProposalNonce, type SendResult } from "./send";
import { NETWORK_OF, isChainId, type Address, type ChainId, type SafeTx } from "@/shared/types";

/** The stored spec of a close: the loan, plus what the batch was sized from (the done line is written from these once the loan is gone). */
export type StoredCloseSpec = Extract<Spec, { kind: "close" }> & { venue: string; repaid: number; /** USDC the Safe must hold for the close to stay current. */ approved: number; /** ISO time after which the approval is not covered for interest: sign by then. */ deadline: string; collAsset: string; returned: number };

/** Stages in which a close still counts as the loan's one open proposal. */
const OPEN = ["draft", "sending", "queued"];

const LENDERS: LenderId[] = ["aave-v3", "compound-v3", "morpho-blue"];

/** A loan id is `{chainId}:{safe}:{lender}`. Anything else, another Safe's or an unknown lender is "no such loan" (404). */
export function parseLoanId(loanId: string, safe: Address): { chainId: ChainId; lender: LenderId } {
  const [chain, owner, lender, ...rest] = loanId.split(":");
  const chainId = Number(chain);
  if (rest.length > 0 || !isChainId(chainId) || !NETWORK_OF[chainId] || !owner || owner.toLowerCase() !== safe.toLowerCase() || !LENDERS.includes(lender as LenderId)) {
    throw new HttpError(404, "Unknown loan.");
  }
  return { chainId, lender: lender as LenderId };
}

export async function closeLoan(ctx: SafeContext, input: { loanId: string }): Promise<SendResult> {
  const { db, services, safe, wallet } = ctx;
  const safeAddress = getAddress(safe.address) as Address;
  const { chainId, lender } = parseLoanId(input.loanId, safeAddress);
  requireNetwork(ctx.access, chainId);
  await assertAgentActive(services, chainId, safeAddress);

  const inputs = await liveInputs(services.reader, chainId, safeAddress, services.lenders);
  const facts = inputs.lenders.find((f) => f.id === lender);
  const loan = facts?.loan ?? null;
  if (!facts || !loan) {
    if (facts?.unavailable || (lender === "aave-v3" && inputs.unavailable)) throw new HttpError(409, "Closing this loan is not available for this Safe yet.");
    throw new HttpError(409, "This Safe has no loan to close.");
  }
  const collateral: "WETH" | "wstETH" = loan.collAsset === "wstETH" ? "wstETH" : "WETH";

  // One open proposal per loan action: asking again returns the open one.
  const findOpen = async (storage: Pick<Db, "select">) => {
    const open = await storage.select().from(proposals)
      .where(and(eq(proposals.safeId, safe.id), eq(proposals.chainId, chainId), inArray(proposals.stage, OPEN)));
    return open.find((r) => (r.spec as { kind?: string; loanId?: string }).kind === "close" && (r.spec as { loanId?: string }).loanId === loan.id);
  };
  const existing = await findOpen(db);
  if (existing) return resultOf(existing.stage === "sending" ? await deliver(db, services, existing, safeAddress) : existing);

  const owed = loan.debt + loan.accrued;
  const held = inputs.balances.USDC;
  // Every lender's approval covers the debt plus interest for the signing delay, and the Safe must hold all of it.
  const needed = closeAllowance(chainId, owed, loan.apr);
  if (held < needed) {
    // Rounded up to the cent: the Safe must hold at least this much more.
    const missing = Math.ceil((needed - held) * 100) / 100;
    const reason = `To close this loan I need ${usd(needed)} USDC in the Safe to pay it back. It holds ${usd(held)}. Add ${usd(missing)} more USDC and ask again.`;
    throw new SendBlocked(reason, `${reason} Nothing was sent.`);
  }

  let built: Built;
  if (lender === "aave-v3") {
    built = buildClose({ chainId, safe: safeAddress, debt: owed, apr: loan.apr, collateral });
  } else {
    const position = facts.position!;
    built = await adapterFor(lender).buildClose({ ref: { lender, chainId, marketId: position.marketId, collateral }, safe: safeAddress });
  }
  const healthBefore = lender === "aave-v3" ? inputs.position?.healthFactor ?? null : facts.position?.health ?? null;
  const spec = { kind: "close" as const, loanId: loan.id };
  const tr = await testRun({
    chainId, safe: safeAddress, spec, close: built,
    healthBefore: healthBefore !== null && Number.isFinite(healthBefore) ? healthBefore : null, atRiskLevel: DEFAULT_LEVELS.act,
    // Only Aave's account is simulated for health: after a close the debt is zero.
    ...(lender === "aave-v3" ? {} : { predictedHealthAfter: Number.POSITIVE_INFINITY }),
  }, services.testRunDeps);
  if (!tr.canSend) throw new SendBlocked(tr.reason ?? "The test run did not pass.", tr.line);

  const shown = compute(spec, inputs.lenders.flatMap((f) => (f.loan ? [f.loan] : [])), { prices: inputs.prices, venues: inputs.venues, networks: M1_NETWORKS, feeEstimateUsd: tr.feeUsd });
  // Aave holds an ETH loan's collateral as WETH, and WETH is what comes back (the batch does not unwrap).
  const asset = collateral;
  const steps = [...built.steps]; // the builder's own steps: the approval shown is the one signed
  const outcome = loan.collAsset === "ETH" ? shown.outcome.replace(/ ETH\.$/, " WETH (the ETH you locked, wrapped).") : shown.outcome;
  const stored: StoredCloseSpec = { ...spec, venue: loan.venue, repaid: owed, approved: needed, deadline: new Date(Date.now() + MAX_SIGNING_DELAY_SECONDS * 1000).toISOString(), collAsset: asset, returned: loan.collAmount };

  const onChain = (await services.reader.readSafeNonce(chainId, safeAddress)) ?? 0n;
  const threshold = await services.reader.readSafeThreshold(chainId, safeAddress);
  // A close asked again after a refusal or replacement gets a fresh key.
  const key = createHash("sha256").update(`close:${chainId}:${safe.address.toLowerCase()}:${randomUUID()}`).digest("hex");
  const row = await withNextProposalNonce(db, safe.id, chainId, onChain, async (storage, nonce) => {
    const open = await findOpen(storage);
    if (open) return open;
    const tx: SafeTx = { ...tr.tx, nonce: nonce.toString() };
    const hash = safeTxHash(chainId, safeAddress, tx);
    const [inserted] = await storage.insert(proposals).values({
      id: randomUUID(), safeId: safe.id, chainId, spec: stored, tx, nonce, safeTxHash: hash, idempotencyKey: key,
      title: shown.title, steps, outcome, stage: "sending", threshold,
      testRun: { ok: tr.ok, feeUsd: tr.feeUsd, healthAfter: null, reason: tr.reason ?? null },
      createdBy: wallet.toLowerCase(),
    }).onConflictDoNothing().returning();
    if (inserted) return inserted;
    const [twin] = await storage.select().from(proposals).where(and(eq(proposals.chainId, chainId), eq(proposals.safeTxHash, hash))).limit(1);
    return twin!;
  });
  return resultOf(row.stage === "sending" ? await deliver(db, services, row, safeAddress) : row);
}
