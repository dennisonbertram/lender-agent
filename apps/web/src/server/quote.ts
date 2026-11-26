// The plan quote (BP-12): one response, one block number, every figure from the domain library's
// `planFor` fed with live inputs (VC-02: one quote function). No figure comes from the model (G1).
// Health uses the lender's own parameters and oracle price, read at the same block (D-07).
import { defaultAsset, feesLine as libFeesLine, lenderLimit, planFor, quoteLoan, costLine, type CashPlan } from "@/lib/cash-plan";
import { canOpen } from "@/server/lenders/common";
import { networkName, usd } from "@/lib/format";
import { BALANCED_HF, DEFAULT_LEVELS, LEAN_HF, healthStatus, hfAfterDrop, maxPriceDrop, minLoanFor, type HealthStatus } from "@/lib/loan-math";
import { cappedNote } from "@/lib/plan-draft";
import type { Asset, Loan, Network, Venue } from "@/lib/types";
import type { PlanQuote } from "@/components/blocks/PlanBlock";
import { HttpError } from "@/server/http";
import { servedChainOf } from "@/lib/networks";
import { NETWORK_OF, type Address, type ChainId } from "@/shared/types";
import type { Db } from "@/server/db/client";
import { levelsForPlan } from "@/server/levels";
import { draftState, saveQuoteDraft, type DraftState } from "@/server/plan-drafts";
import { AAVE_VENUE_ID, AAVE_VENUE_NAME, M1_NETWORKS, liveInputs, type LenderFacts, type LiveInputs } from "@/server/market-inputs";
import { testRun } from "@/server/proposals/test-run";
import type { SafeRow } from "@/server/request";
import type { Services } from "@/server/services";

/** Safety levels, in the order of the card's choices: Extra safe, Balanced, Lean. */
export const HF_LEVELS = [2.0, BALANCED_HF, LEAN_HF] as const;

export type QuoteInput = {
  cash: number;
  asset?: Asset;
  network?: Network;
  /** The chain of the collateral's network; derived from `network` when absent (Base by default). */
  chainId?: ChainId;
  venueId?: string;
  hfIdx?: 0 | 1 | 2;
  months?: 3 | 12 | 24;
  /** The chat message that holds the plan card (OC-04). */
  messageId?: string;
  /** A sizing question: the collateral for `cash` whatever the Safe holds; never sendable. */
  hypothetical?: boolean;
  /** The owner picked this lender (a Compare row, "Plan this"), as opposed to the card's default: it is never swapped for another. */
  venueChosen?: boolean;
};

export type QuoteResponse = {
  status: "ok" | "notFeasible" | "unavailable";
  /** The network the figures — and any send of this plan — are for. */
  chainId: ChainId;
  network: Network;
  /** The lender the figures are for (`aave-v3` by default). */
  venueId: string;
  blockNumber: number;
  readAt: number;
  /** The amount the quote is for, after capping. */
  cash: number;
  /** The most this Safe can borrow at the chosen safety level, in dollars. Null when the lender is the problem (not available, frozen), so no maximum applies. */
  maxCash: number | null;
  cappedNote?: string;
  quote: PlanQuote;
  /** The cost sentence from `costLine`; says "on the full $X loan" when the plan adds to an existing loan. */
  costLine?: string;
  testRun: { line: string; canSend: boolean; reason?: string };
  draft: DraftState;
};

export type QuoteCtx = { db: Db; services: Pick<Services, "reader" | "testRunDeps" | "lenders">; safe: Pick<SafeRow, "id" | "address">; ownedChainIds?: readonly number[] };

/** The chain a plan is for: the one named, else the one of the network, else Base. */
export function planChainOf(input: Pick<QuoteInput, "network" | "chainId">): ChainId {
  if (input.chainId !== undefined) return input.chainId;
  if (!input.network) return 8453;
  const chainId = servedChainOf(input.network);
  if (chainId === null) throw new HttpError(400, "Loans are not offered on that network yet.");
  return chainId;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const NOT_YET = "not available for this Safe yet";

function feesText(plan: CashPlan, feeUsd: number) {
  return feeUsd < 0.01 ? "One-time network fee: less than $0.01 to set up the loan." : feeUsd < 1 ? `One-time network fee: about ${usd(feeUsd, 2)} to set up the loan.` : libFeesLine(plan, feeUsd);
}


const listOf = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0] ?? "");

export type Need = { asset: Asset; cash: number; months: number; targetHf: number; network: Network };

/** One lender's answer to one need: a plan with its figures, or the reason it cannot (r33 wording). The one function every surface reads. */
export type Attempt =
  | { ok: true; plan: CashPlan; price: number; cash: number; maxCash: number; capped: string; venue: Venue; facts: LenderFacts }
  | { ok: false; reason: string; cash: number; maxCash: number | null; facts: LenderFacts };

export const roundedVenue = (v: Venue): Venue => ({ ...v, apr: round2(v.apr) });

/** Existing loans in the library's shape, rates rounded as quoted. */
export const loansOf = (inputs: LiveInputs): Loan[] => inputs.lenders.flatMap((l) => (l.loan ? [{ ...l.loan, apr: round2(l.loan.apr) }] : []));

export function attempt(inputs: LiveInputs, f: LenderFacts, n: Need, opts: { cap: boolean }): Attempt {
  const net = networkName(n.network, M1_NETWORKS);
  const no = (reason: string, cash = n.cash, maxCash: number | null = null): Attempt => ({ ok: false, reason, cash, maxCash, facts: f });
  const venue = f.venue && roundedVenue(f.venue);
  if (!venue) return no(f.id === AAVE_VENUE_ID ? `${AAVE_VENUE_NAME} is paused or frozen on ${net} right now, so no new loan can be made. Try again later.` : `${f.note ?? `${f.name} is not lending now`}. Try again later.`);
  const market = venue.markets[n.asset];
  if (!market) return no(`${f.name} on ${net} does not take ${n.asset} as collateral. It takes ${listOf(Object.keys(venue.markets))}.`);
  const price = f.prices[n.asset] ?? inputs.prices[n.asset];
  const max = lenderLimit(venue, n.asset, inputs.balances[n.asset], price, n.targetHf) ?? 0;
  // The app minimum, or the lender's own on-chain minimum (Compound v3 baseBorrowMin) when higher.
  const min = minLoanFor(f.markets[n.asset]?.minBorrow);
  if (max < min) return no(`This Safe doesn't hold enough ${n.asset} on ${net} to borrow ${usd(min)} safely.`, n.cash, 0);
  const cash = opts.cap ? Math.min(Math.max(n.cash, min), max) : n.cash;
  if (cash < min) return no(`The smallest loan on ${f.name} is ${usd(min)}.`, cash, max);
  if (cash > max) return no(`Can lend up to ${usd(max)} against your ${n.asset}.`, cash, max);
  if (cash > f.liquidity) return no(`${f.name} can lend only about ${usd(Math.floor(f.liquidity))} right now, so it can't fund ${usd(cash)}. Try a smaller amount.`, cash, max);
  const plan = planFor({ ...n, cash }, inputs.balances[n.asset], price, venue, loansOf(inputs));
  if (!plan.feasible) return no(`Your ${n.asset} can't safely back ${usd(cash)} right now. Try a smaller amount or another safety level.`, cash, max);
  const m = f.markets[n.asset];
  if (m) {
    const c = canOpen(m, cash, plan.collateral);
    if (!c.ok) return no(`${c.reason}.`, cash, max);
  }
  const capped = n.cash < min && cash === min ? `The smallest ${f.name} loan is ${usd(min)}, so this plan starts there. No other lender fits ${usd(n.cash)} for this Safe.` : cappedNote(n.cash, max, cash, min);
  return { ok: true, plan, price, cash, maxCash: max, capped, venue, facts: f };
}

/** The figures of a loan, from the same math whether it is a plan, a compared row, a what-if or an open loan. */
export type Figures = { apr: number; yearly: number; liqPrice: number; dropPct: number; hf: number; status: HealthStatus; /** "ETH can fall" N percent. */ canFallPct: number };

export function figuresOf(q: Pick<CashPlan, "apr" | "yearly" | "liqPrice" | "hf">, levels = DEFAULT_LEVELS): Figures {
  const canFallPct = Math.round(maxPriceDrop(q.hf) * 100);
  return { apr: q.apr, yearly: q.yearly, liqPrice: q.liqPrice, dropPct: canFallPct, hf: q.hf, status: healthStatus(q.hf, levels.warn, levels.act), canFallPct };
}

/** An open loan's figures (dashboard, what-if): the plan math with nothing added. `health` is the lender's own number when it is known, as on the dashboard. */
export function figuresOfLoan(loan: Loan, price: number, opts: { levels?: typeof DEFAULT_LEVELS; health?: number | null } = {}): Figures {
  const q = quoteLoan({ id: "", name: loan.venue, borrowAsset: "USDC", apr: loan.apr, liquidity: 0, networks: [loan.network], markets: { [loan.collAsset]: { maxLtv: loan.lt, lt: loan.lt } } }, loan.collAsset, 0, 0, price, [loan]);
  return figuresOf({ ...q, hf: opts.health != null && Number.isFinite(opts.health) ? opts.health : q.hf }, opts.levels);
}

/** Which lender the plan is for: the one asked for, else Aave (the default). An unknown id is Aave too. */
export const pickLender = (inputs: LiveInputs, venueId?: string): LenderFacts => inputs.lenders.find((l) => l.id === venueId) ?? inputs.lenders[0];

/** The lender for a plan: the one asked for, unless its own smallest loan is above the amount asked and another lender allows it. The new lender (when any) comes with the plain sentence for the card. */
export function lenderForAmount(inputs: LiveInputs, wanted: LenderFacts, n: { cash: number; asset?: Asset; months: number; targetHf: number; network: Network }): { facts: LenderFacts; note?: string } {
  if (wanted.loan || !wanted.venue) return { facts: wanted };
  const assets = (Object.keys(wanted.venue.markets) as Asset[]).filter((a) => !n.asset || a === n.asset);
  const min = Math.min(...assets.map((a) => minLoanFor(wanted.markets[a]?.minBorrow)));
  if (!Number.isFinite(min) || n.cash >= min) return { facts: wanted };
  for (const l of inputs.lenders) {
    if (l === wanted || l.unavailable || l.loan || !l.venue) continue;
    for (const a of (Object.keys(l.venue.markets) as Asset[]).filter((x) => !n.asset || x === n.asset)) {
      if (attempt(inputs, l, { asset: a, cash: n.cash, months: n.months, targetHf: n.targetHf, network: n.network }, { cap: false }).ok) {
        return { facts: l, note: `The smallest ${wanted.name} loan is ${usd(min)}; ${l.name} allows ${usd(n.cash)}, so this plan uses ${l.name}.` };
      }
    }
  }
  return { facts: wanted };
}

export async function quotePlan(ctx: QuoteCtx, input: QuoteInput): Promise<QuoteResponse> {
  const hfIdx = input.hfIdx ?? 1;
  const months = input.months ?? 12;
  const targetHf = HF_LEVELS[hfIdx];
  const chainId = planChainOf(input);
  const network: Network = NETWORK_OF[chainId];
  const inputs = await liveInputs(ctx.services.reader, chainId, ctx.safe.address as Address, ctx.services.lenders);
  if (input.venueChosen && input.venueId && !inputs.lenders.some((l) => l.id === input.venueId)) throw new HttpError(409, "That lender is not available for this plan.");
  const wanted = pickLender(inputs, input.venueId);
  const picked = input.hypothetical || input.venueChosen ? { facts: wanted } : lenderForAmount(inputs, wanted, { cash: input.cash, asset: input.asset, months, targetHf, network });
  const facts = picked.facts;
  const existing = facts.loan ? { ...facts.loan, apr: round2(facts.loan.apr) } : undefined;
  const venue = facts.venue ? roundedVenue(facts.venue) : null;
  const asset: Asset | undefined = input.asset ?? existing?.collAsset ?? (venue ? defaultAsset(inputs.balances, { ...inputs.prices, ...facts.prices }, [venue], input.cash, targetHf, network) ?? undefined : undefined);
  const base = { blockNumber: Number(inputs.blockNumber), readAt: inputs.readAt };
  const draftFields = { text: usd(input.cash), hfIdx, months, ...(input.asset ? { asset: input.asset } : {}), network, venueId: input.venueId, cash: input.cash, hypothetical: !!input.hypothetical };

  const finish = async (status: QuoteResponse["status"], p: { cash: number; maxCash?: number | null; quote: PlanQuote; testRun: QuoteResponse["testRun"]; cappedNote?: string; costLine?: string }): Promise<QuoteResponse> => {
    await saveQuoteDraft(ctx.db, ctx.safe.id, { ...draftFields, messageId: input.messageId });
    return { status, chainId, network, venueId: facts.id, ...base, cash: p.cash, maxCash: p.maxCash ?? null, quote: p.quote, testRun: p.testRun, draft: await draftState(ctx.db, ctx.safe.id, input.messageId, ctx.ownedChainIds), ...(p.cappedNote ? { cappedNote: p.cappedNote } : {}), ...(p.costLine ? { costLine: p.costLine } : {}) };
  };
  const unavailable = (reason: string) => finish("unavailable", { cash: input.cash, quote: { kind: "unavailable" }, testRun: { line: "", canSend: false, reason } });
  const notFeasible = (cash: number, reason: string, maxCash: number | null = null) =>
    finish("notFeasible", { cash, maxCash, quote: { kind: "notFeasible", asset: asset ?? "ETH", cash, reason }, testRun: { line: "", canSend: false, reason } });

  // Another collateral or debt asset in the lender's account, or a request for a different asset than the existing loan's.
  if (facts.unavailable || (existing && input.asset && input.asset !== existing.collAsset)) return unavailable(NOT_YET);
  if (!venue || !asset) {
    const why = attempt(inputs, facts, { asset: asset ?? "ETH", cash: input.cash, months, targetHf, network }, { cap: true });
    const reason = !venue && !why.ok ? why.reason : `${facts.name} on ${networkName(network, M1_NETWORKS)} does not take ${input.asset ?? "that"} as collateral. It takes ${listOf(Object.keys(venue?.markets ?? {}))}.`;
    return notFeasible(input.cash, reason);
  }
  if (input.hypothetical) {
    // A sizing question: the collateral this amount needs at this safety level, whatever the Safe holds. Never sendable.
    const hAsset: Asset = venue.markets[asset] ? asset : (Object.keys(venue.markets)[0] as Asset);
    const price = facts.prices[hAsset] ?? inputs.prices[hAsset];
    const plan = planFor({ asset: hAsset, cash: input.cash, months, targetHf, network }, Infinity, price, venue, []);
    const fig = figuresOf(plan);
    return finish("ok", {
      cash: input.cash, maxCash: input.cash, testRun: { line: "This only shows the collateral that amount would need. Nothing can be sent from it.", canSend: false, reason: "A sizing question is not a plan to send." },
      quote: { kind: "ok", cash: input.cash, borrowAsset: "USDC", asset: hAsset, collateral: plan.collateral, collateralUsd: plan.collateral * price, price, liqPrice: fig.liqPrice, dropPct: fig.dropPct, adding: false, apr: fig.apr, yearly: fig.yearly, feesLine: "Network fees are shown when you plan a real loan.", lender: venue.name, network: networkName(network, M1_NETWORKS) },
    });
  }
  if (input.venueChosen && !facts.loan) {
    const min = minLoanFor(facts.markets[asset]?.minBorrow);
    if (input.cash < min) return notFeasible(input.cash, `The smallest ${facts.name} loan is ${usd(min)}.`);
  }
  const a = attempt(inputs, facts, { asset, cash: input.cash, months, targetHf, network }, { cap: true });
  if (!a.ok) return notFeasible(a.cash, a.reason, a.maxCash);
  const { plan, price, cash } = a;

  let run: QuoteResponse["testRun"] & { feeUsd: number };
  try {
    const r = await testRun({
      chainId, safe: ctx.safe.address as Address,
      atRiskLevel: (await levelsForPlan(ctx.db, ctx.safe.id, facts.id === AAVE_VENUE_ID ? inputs.position?.id : facts.loan?.id)).act,
      healthBefore: facts.id === AAVE_VENUE_ID ? inputs.position?.healthFactor ?? null : facts.position?.health ?? null,
      spec: { kind: "open", venueId: venue.id, asset, amount: plan.collateral, borrow: cash, safeId: ctx.safe.address.toLowerCase(), network },
      ...(facts.id === AAVE_VENUE_ID ? {} : { predictedHealthAfter: plan.hf }),
    }, ctx.services.testRunDeps);
    run = { line: r.line, canSend: r.canSend, feeUsd: r.feeUsd, ...(r.reason ? { reason: r.reason } : {}) };
  } catch {
    run = { line: "The test run could not be done. Nothing was sent.", canSend: false, reason: "The test run could not be done.", feeUsd: 0 };
  }

  const { feeUsd, ...testRunOut } = run;
  const fig = figuresOf(plan);
  return finish("ok", {
    cash, maxCash: a.maxCash, cappedNote: a.capped || picked.note || undefined, costLine: plan.scope === "added" ? costLine(plan, months) : undefined, testRun: testRunOut,
    quote: {
      kind: "ok", cash, borrowAsset: "USDC", asset, collateral: plan.collateral, collateralUsd: plan.collateral * price, price,
      liqPrice: fig.liqPrice, dropPct: fig.dropPct, adding: plan.scope === "added", apr: fig.apr, yearly: fig.yearly,
      feesLine: feesText(plan, feeUsd), lender: venue.name, network: networkName(network, M1_NETWORKS),
    },
  });
}
