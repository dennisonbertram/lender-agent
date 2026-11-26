// "Use reserve now" (BP-42): an owner of both Safes picks the reserve option on an alert above the trigger and
// confirms an exact quoted maximum. It runs through the same executor and on-chain limit as the automatic repay.
// When the reserve cannot act, the option is disabled with the reason (`blockLabel`).
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { DEFAULT_LEVELS, reserveTargetHf } from "@/lib/loan-math";
import { usd } from "@/lib/format";
import { blockLabel, blockMessage, capResetLabel, reserveBlock, type ReserveBlock } from "@/lib/reserve";
import { requireNetwork } from "@/server/auth/access";
import { HttpError } from "@/server/http";
import { levelsByLoan } from "@/server/levels";
import { reserveRuns } from "@/server/db/schema";
import { sumUsd } from "@/server/loans";
import type { SafeContext } from "@/server/request";
import { isChainId, type Address, type LoanPosition } from "@/shared/types";
import type { ExecLink } from "../types";
import { allowanceNow } from "../allowance";
import { planReserveRepay } from "./plan";
import { executeReserve, type ReserveRunOutcome } from "./run";
import { getReserveRuntime } from "./runtime";
import { linkFingerprint, loadReserveLink } from "./store";

export type ReserveNowOption = {
  enabled: boolean;
  block: ReserveBlock | null;
  /** Short subtitle under the button: why it is disabled, or "Runs now, without a signature". */
  label: string;
  /** Full sentence when disabled. */
  message: string | null;
  /** Maximum USDC request, in dollars (stablecoin = $1), when enabled. */
  amount: number | null;
  /** The confirm dialog's title. */
  confirm: string | null;
  /** Exact quote identity and maximum USDC request reviewed by the borrower. */
  binding: ReserveNowBinding | null;
};

export type ReserveNowBinding = {
  loanId: string;
  reserveSafe: string;
  linkFingerprint: string;
  triggerHf: number;
  policyMaxRefillRaw: string;
  policyRefillRaw: string;
  policyPeriodRaw: string;
  allowanceBalanceRaw: string;
  allowanceTimestampRaw: string;
  reserveBalanceRaw: string;
  maxAmountRaw: string;
};

type Live = { link: ExecLink; position: LoanPosition; balance: number; balanceRaw: bigint; left: number; leftRaw: bigint; resetsAt: number | null; executorIsMember: boolean; authorizationReady: boolean; allowance: { maxRefill: bigint; refill: bigint; period: bigint; balance: bigint; timestamp: bigint } };

async function load(ctx: SafeContext, loanId: string, allowNoDebt = false): Promise<Live> {
  const chainId = Number(loanId.split(":")[0]);
  if (!isChainId(chainId) || !loanId.toLowerCase().includes(`:${ctx.safe.address.toLowerCase()}:`)) throw new HttpError(404, "Loan not found");
  requireNetwork(ctx.access, chainId);
  const link = await loadReserveLink(ctx.db, ctx.safe.id, chainId);
  if (!link) throw new HttpError(404, "No Reserve Safe is linked on this network.");
  // Both Safes: the wallet must own the main Safe (checked above) and the Reserve Safe, read from chain now (G4).
  const owners = await ctx.services.reader.readSafeOwners(chainId, link.reserveSafe);
  if (!owners?.some((o) => o.toLowerCase() === ctx.wallet.toLowerCase())) throw new HttpError(403, "Using the reserve needs you to own both Safes.");
  const { position } = await ctx.services.reader.readAavePosition(chainId, ctx.safe.address as Address);
  if (!position || position.id.toLowerCase() !== loanId.toLowerCase() || (!allowNoDebt && !position.debt.some((d) => d.amount > 0))) throw new HttpError(404, "Loan not found");
  const rt = getReserveRuntime(ctx.services, () => {});
  const { allowance: state, nowSec, balance: bal, executorIsMember, policyAsDesigned } = await rt.chain.read(link);
  const unit = 10 ** link.tokenDecimals;
  const leftRaw = allowanceNow(state, nowSec).left;
  return { link, position, balance: Number(bal) / unit, balanceRaw: bal, left: Number(leftRaw) / unit, leftRaw, resetsAt: state.period > 0n ? Number(state.timestamp) * 1000 : null, executorIsMember, authorizationReady: executorIsMember && policyAsDesigned, allowance: { maxRefill: state.maxRefill, refill: state.refill, period: state.period, balance: state.balance, timestamp: state.timestamp } };
}

const targetOf = async (ctx: SafeContext, l: Live) => reserveTargetHf((await levelsByLoan(ctx.db, ctx.safe.id)).get(l.position.id.toLowerCase()) ?? DEFAULT_LEVELS, l.link.trigger);

/** The reserve option for one loan: enabled with the amount it would use, or disabled with the reason. */
export async function reserveNowOption(ctx: SafeContext, loanId: string): Promise<ReserveNowOption> {
  const l = await load(ctx, loanId);
  const supported = l.position.lender === "aave-v3" && l.position.chainId === l.link.chainId
    && l.position.collateral.length > 0 && l.position.debt.length === 1
    && l.position.debt[0]!.asset === l.link.tokenSymbol && l.position.debt[0]!.amount > 0;
  if (!supported) return { enabled: false, block: null, label: "This loan cannot be repaid from the reserve", message: "The reserve can only repay a Base Aave loan with one USDC debt. This loan needs another fix.", amount: null, confirm: null, binding: null };
  if (!l.link.active) return {
    enabled: false, block: "paused", label: "Reserve off",
    message: l.executorIsMember
      ? "The agent has stopped using the reserve. The Safe permission stays active until the owners execute its removal transaction."
      : "Reserve protection is off. You can review the limits and approve it again in Reserve.",
    amount: null, confirm: null, binding: null,
  };
  if (!l.authorizationReady) return {
    enabled: false, block: "paused", label: "Reserve permission needs attention",
    message: "The Safe permission is not ready for the reserve to use. Review the Reserve setup before using it.",
    amount: null, confirm: null, binding: null,
  };
  const target = await targetOf(ctx, l);
  const debt = l.position.debt[0]!;
  const loan = { amount: 1, price: sumUsd(l.position.collateral) ?? 0, lt: l.position.liquidationThreshold, debt: debt.amount };
  const block = reserveBlock(loan, target, { coll: 0, stable: l.balance }, { armed: l.link.active, emergencyHF: l.link.trigger, dailyCapUsd: l.left, usedUsd24h: 0 });
  if (block) {
    const reset = l.resetsAt === null ? null : capResetLabel(l.resetsAt, Date.now());
    const hf = l.position.healthFactor;
    return { enabled: false, block, label: blockLabel(block, { hf, target, coll: "collateral", debt: l.link.tokenSymbol, reset }), message: blockMessage(block, { cap: l.left, used: 0, coll: "collateral", debt: l.link.tokenSymbol, reset, hf }), amount: null, confirm: null, binding: null };
  }
  // Keep the quote itself within both live constraints. executeReserve repeats this cap from its own
  // latest chain read when the borrower confirms.
  const requestLimitRaw = l.leftRaw < l.balanceRaw ? l.leftRaw : l.balanceRaw;
  const requestLimit = Number(requestLimitRaw) / (10 ** l.link.tokenDecimals);
  const plan = planReserveRepay({ collateralUsd: loan.price, lt: loan.lt, debt: loan.debt, trigger: Infinity, target, balance: l.balance, allowanceLeft: requestLimit, decimals: l.link.tokenDecimals, allowanceLeftRaw: requestLimitRaw });
  if (!plan || plan.requestRaw <= 0n) return { enabled: false, block: "noBalance", label: blockLabel("noBalance", { hf: l.position.healthFactor, target, coll: "collateral", debt: l.link.tokenSymbol, reset: null }), message: null, amount: null, confirm: null, binding: null };
  const raw = plan.requestRaw.toString();
  const binding: ReserveNowBinding = {
    loanId: l.position.id.toLowerCase(), reserveSafe: l.link.reserveSafe.toLowerCase(), linkFingerprint: linkFingerprint(l.link),
    triggerHf: l.link.trigger, policyMaxRefillRaw: l.allowance.maxRefill.toString(), policyRefillRaw: l.allowance.refill.toString(),
    policyPeriodRaw: l.allowance.period.toString(), allowanceBalanceRaw: l.allowance.balance.toString(),
    allowanceTimestampRaw: l.allowance.timestamp.toString(), reserveBalanceRaw: l.balanceRaw.toString(), maxAmountRaw: raw,
  };
  const amount = Number(plan.requestRaw) / (10 ** l.link.tokenDecimals);
  const exact = formatExactRawAmount(plan.requestRaw, l.link.tokenDecimals);
  return { enabled: true, block: null, label: "Runs now, without a signature", message: null, amount, confirm: `Use up to $${exact} from reserve?`, binding };
}

export function formatExactRawAmount(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = (raw / scale).toLocaleString("en-US");
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Amount/balance snapshots may change as interest accrues or the allowance is used. These fields
 * identify the loan and policy the borrower reviewed; maxAmountRaw stays the immutable submitted cap. */
const sameIdentity = (a: ReserveNowBinding | null, b: ReserveNowBinding) =>
  !!a && a.loanId.toLowerCase() === b.loanId.toLowerCase()
  && a.reserveSafe.toLowerCase() === b.reserveSafe.toLowerCase()
  && a.linkFingerprint === b.linkFingerprint
  && a.triggerHf === b.triggerHf
  && a.policyMaxRefillRaw === b.policyMaxRefillRaw
  && a.policyRefillRaw === b.policyRefillRaw
  && a.policyPeriodRaw === b.policyPeriodRaw;

const matchesLiveIdentity = (binding: ReserveNowBinding, live: Live) =>
  binding.loanId.toLowerCase() === live.position.id.toLowerCase()
  && binding.reserveSafe.toLowerCase() === live.link.reserveSafe.toLowerCase()
  && binding.linkFingerprint === linkFingerprint(live.link)
  && binding.triggerHf === live.link.trigger
  && binding.policyMaxRefillRaw === live.allowance.maxRefill.toString()
  && binding.policyRefillRaw === live.allowance.refill.toString()
  && binding.policyPeriodRaw === live.allowance.period.toString();

export type UseNowResult = ReserveRunOutcome & { message: string };

/** Run it. `confirm` must be true: the dialog is the owner's consent. Same limit as the automatic repay: the chain decides. */
export async function useReserveNow(ctx: SafeContext, loanId: string, input: { confirm: boolean; binding: ReserveNowBinding | null }): Promise<UseNowResult> {
  if (input.confirm !== true) throw new HttpError(400, "Confirm to use the reserve.");
  if (!input.binding || !/^[1-9][0-9]*$/.test(input.binding.maxAmountRaw)) {
    throw new HttpError(409, "The reserve, loan, or limit changed since you reviewed this request. Review the updated amount before trying again.");
  }
  // Confirm identity before returning a prior run: an old quote never carries across a re-link or policy change.
  const reviewedState = await load(ctx, loanId, true);
  if (!matchesLiveIdentity(input.binding, reviewedState)) {
    throw new HttpError(409, "The reserve, loan, or limit changed since you reviewed this request. Review the updated amount before trying again.");
  }
  const runKey = `now:${input.binding.loanId.toLowerCase()}:${stableBindingKey(input.binding)}`;
  const [prior] = await ctx.db.select().from(reserveRuns).where(and(
    eq(reserveRuns.safeId, ctx.safe.id), eq(reserveRuns.loanId, input.binding.loanId.toLowerCase()), eq(reserveRuns.key, runKey),
  )).limit(1);
  if (prior) {
    if (prior.status === "done" && prior.txHash) return { status: "done", runId: prior.id, txHash: prior.txHash, hfBefore: prior.hfBefore, hfAfter: prior.hfAfter, message: "Done. The reserve repaid part of your loan without your signature." };
    if (prior.status === "pending") return { status: "pending", runId: prior.id, txHash: prior.txHash ?? "", message: "The repay is pending. Check back for confirmation." };
    if (prior.status === "failed") return { status: "failed", runId: prior.id, error: prior.error ?? "The reserve could not repay.", message: "The reserve could not repay, so nothing moved." };
  }
  const option = await reserveNowOption(ctx, loanId);
  if (!option.enabled) throw new HttpError(409, option.message ?? option.label);
  if (!sameIdentity(option.binding, input.binding)) {
    throw new HttpError(409, "The reserve, loan, or limit changed since you reviewed this request. Review the updated amount before trying again.");
  }
  const l = await load(ctx, loanId);
  if (!matchesLiveIdentity(input.binding, l)) {
    throw new HttpError(409, "The reserve, loan, or limit changed since you reviewed this request. Review the updated amount before trying again.");
  }
  // Money moves next, and the access snapshot can be up to 15 s old: re-read the main Safe's owners now (G4).
  const mainOwners = await ctx.services.reader.readSafeOwners(l.link.chainId, ctx.safe.address as Address);
  if (!mainOwners?.some((o) => o.toLowerCase() === ctx.wallet.toLowerCase())) throw new HttpError(403, "You are not an owner of this Safe on this network");
  const out = await executeReserve(
    { db: ctx.db, reader: ctx.services.reader, now: new Date(), log: (m, d) => console.error(m, d), services: ctx.services },
    // `authorizedBy` lets the locked broadcast gate re-verify the caller still owns BOTH Safes at the boundary (BP-52).
    { link: l.link, position: l.position, origin: "now", authorizedBy: ctx.wallet, target: await targetOf(ctx, l), keySuffix: stableBindingKey(input.binding), maxAmountRaw: BigInt(input.binding.maxAmountRaw) },
  );
  const message = out.status === "done" ? "Done. The reserve repaid part of your loan without your signature."
    : out.status === "failed" ? "The reserve could not repay, so nothing moved."
    : out.status === "pending" ? "The repay is pending. Check back for confirmation." : "The reserve did not act.";
  return { ...out, message };
}

function stableBindingKey(binding: ReserveNowBinding): string {
  const canonical = [
    binding.loanId.toLowerCase(), binding.reserveSafe.toLowerCase(), binding.linkFingerprint, String(binding.triggerHf),
    binding.policyMaxRefillRaw, binding.policyRefillRaw, binding.policyPeriodRaw, binding.allowanceBalanceRaw,
    binding.allowanceTimestampRaw, binding.reserveBalanceRaw, binding.maxAmountRaw,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

