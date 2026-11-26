import { PRICES, VENUES, fmt, networkName, usd, type Asset, type Loan, type Network, type Stable } from "@/data";
import { DEFAULT_LEVELS, healthFactor, liquidationPrice, yearlyInterest } from "@/lib/loan-math";
import { networkFeeUsd, quoteLoan, type Move } from "@/lib/cash-plan";
import { actionName } from "@/lib/loan-copy";

export type Spec =
  | { kind: "protect"; loanId: string; addColl: number; repay: number }
  | { kind: "open"; venueId: string; asset: Asset; amount: number; borrow: number; safeId: string; network: Network }
  | { kind: "close"; loanId: string }
  | { kind: "refi"; loanId: string; venueId: string }
  /** Move collateral to the lender's network; the loan in `then` is drafted once the move has executed. */
  | { kind: "move"; safeId: string; move: Move; then: OpenSpec };

export type OpenSpec = Extract<Spec, { kind: "open" }>;

/** The loan the agent drafts next: only once a move has executed (stage 3). Never before, and never for other proposals. */
export const followUpAfter = (p: { spec: Spec; stage: number }): OpenSpec | null => (p.spec.kind === "move" && p.stage === 3 ? p.spec.then : null);

export type Proposal = {
  id: string;
  spec: Spec;
  stage: number; // 0 drafted, 1 in queue, 2 one signed, 3 executed, -1 rejected, -2 replaced, -3 out of date
  title: string;
  /** What the user gets, what it costs and the liquidation price. */
  outcome: string;
  /** Message posted when the proposal executes. */
  done: string;
  steps: string[];
  /** Health factor after execution, or null when the loan is closed. */
  hfAfter: number | null;
  feeUsd: number;
  loanId: string;
  /** True when the proposal was in the Safe queue (stage 1 or 2) when it was rejected or went out of date. */
  queued?: boolean;
};

/** The one sentence that says where a rejected or out-of-date proposal still is. */
export function stoppedLine(stage: -1 | -3, queued: boolean): string {
  const head = stage === -1 ? "Rejected" : "Out of date: the loan changed";
  if (!queued) return `${head}. Nothing was sent.`;
  return `${stage === -1 ? "Rejected here" : head}. It is still in your Safe queue. Reject it in Safe too.`;
}

/** The one button that moves a proposal forward, by stage; null once nothing is left to press. */
export function advanceAction(stage: number, needs: number): { label: string; variant: "default" | "secondary" } | null {
  if (stage === 0) return { label: "Send to Safe", variant: "default" };
  if (stage === 1) return { label: "Sign in Safe (demo)", variant: "default" };
  if (stage === 2 && needs > 1) return { label: "Simulate co-signer", variant: "secondary" };
  return null;
}

/** The stage after one press: a Safe that needs one signature goes from queued straight to executed. */
export const nextStage = (stage: number, needs: number) => (stage === 1 && needs === 1 ? 3 : stage + 1);

const hf2 = (n: number) => n.toFixed(2);
const liq = (l: Loan) => usd(liquidationPrice(l.collAmount, l.lt, l.debt));

/** The "test run" line on a proposal card; `blocked` means Send to Safe must be disabled. */
export function testRunLine(hfAfter: number | null, feeUsd: number): { text: string; blocked: boolean } {
  const fee = usd(feeUsd);
  if (hfAfter !== null && hfAfter < 1) return { text: "Test run failed: this would be liquidated right away.", blocked: true };
  if (hfAfter !== null && hfAfter < DEFAULT_LEVELS.act) return { text: `Test run passed, but this is close to liquidation. Network fee about ${fee}.`, blocked: false };
  return { text: `Test run passed. Network fee about ${fee}.`, blocked: false };
}

const withHF = (l: Loan) => healthFactor(l.collAmount * PRICES[l.collAsset], l.lt, l.debt);

/** Pure: the proposal text and the loan list as it will look once the proposal executes. */
export function compute(spec: Spec, loans: Loan[]) {
  let title = "";
  let steps: string[] = [];
  let loanId = "";
  let next = loans;
  let hfAfter: number | null = null;
  let outcome = "";
  let done = "";

  if (spec.kind === "protect") {
    const l = loans.find((x) => x.id === spec.loanId)!;
    loanId = l.id;
    const u = { ...l, collAmount: l.collAmount + spec.addColl, debt: Math.max(0, l.debt - spec.repay) };
    if (spec.addColl > 0) steps.push(`Allow ${l.venue} to use ${fmt(spec.addColl, 1)} ${l.collAsset}`, `Supply ${fmt(spec.addColl, 1)} ${l.collAsset} to ${l.venue}`);
    if (spec.repay > 0) steps.push(`Allow ${l.venue} to use ${fmt(spec.repay)} ${l.debtAsset}`, `Repay ${fmt(spec.repay)} ${l.debtAsset} on ${l.venue}`);
    title = `Protect ${l.venue} loan`;
    next = loans.map((x) => (x.id === l.id ? u : x));
    hfAfter = withHF(u);
    const uses = [spec.addColl > 0 && `${fmt(spec.addColl, 2)} ${l.collAsset}`, spec.repay > 0 && `${fmt(spec.repay)} ${l.debtAsset}`].filter(Boolean).join(" and ");
    outcome = `Uses ${uses} from the Safe. Health factor ${hf2(withHF(l))} → ${hf2(hfAfter)}. Liquidation price: ${l.collAsset} at ${liq(u)}.`;
    done = `Done. Your ${l.venue} loan's health factor is now ${hf2(hfAfter)}.`;
  } else if (spec.kind === "open") {
    const v = VENUES.find((x) => x.id === spec.venueId)!;
    const m = v.markets[spec.asset]!;
    const safeLoans = loans.filter((x) => x.safeId === spec.safeId && x.network === spec.network);
    const q = quoteLoan(v, spec.asset, spec.amount, spec.borrow, PRICES[spec.asset], safeLoans);
    const name = actionName(q, spec.borrow);
    const old = safeLoans.find((x) => x.venue === v.name && x.collAsset === spec.asset);
    steps = [
      `Allow ${v.name} to use ${fmt(spec.amount, 2)} ${spec.asset}`,
      `Lock ${fmt(spec.amount, 2)} ${spec.asset} in ${v.name}`,
      `Borrow ${fmt(spec.borrow)} ${v.borrowAsset}`,
    ];
    title = name.title;
    hfAfter = q.hf;
    if (old) {
      loanId = old.id;
      next = loans.map((x) => (x.id === old.id ? { ...old, collAmount: q.totalCollateral, debt: q.debt } : x));
    } else {
      const n: Loan = {
        id: `${v.id}-${spec.asset.toLowerCase()}-${spec.safeId}`, safeId: spec.safeId, network: spec.network, venue: v.name, collAsset: spec.asset, collAmount: spec.amount,
        debtAsset: v.borrowAsset, debt: spec.borrow, lt: m.lt, apr: v.apr, accrued: 0,
      };
      loanId = n.id;
      next = [...loans, n];
    }
    const yearly = q.scope === "added" ? `Interest per year on the full ${usd(q.debt)} loan: ${usd(q.yearly)} at ${q.apr}%.` : `Interest per year: ${usd(q.yearly)} at ${q.apr}%.`;
    outcome = `On ${networkName(spec.network)}. You get ${fmt(spec.borrow)} ${v.borrowAsset} and lock ${fmt(spec.amount, 2)} ${spec.asset}. ${yearly} Safe unless ${spec.asset} falls below ${usd(q.liqPrice)}.`;
    done = `Done. ${name.past}${q.scope === "added" ? ` It is now ${usd(q.debt)}.` : ""} ${fmt(spec.borrow)} ${v.borrowAsset} is in your Safe. Health factor ${hf2(q.hf)}.`;
  } else if (spec.kind === "move") {
    const { from, to, asset, amount, minutes } = spec.move;
    const a = `${fmt(amount, 2)} ${asset}`;
    steps = [`Allow ${a} to leave ${networkName(from)}`, `Send ${a} from ${networkName(from)} to ${networkName(to)}`];
    title = `Move ${a} to ${networkName(to)}`;
    outcome = `Step 1 of 2. Moves ${a} from ${networkName(from)} to ${networkName(to)}, about ${minutes} minutes. You still hold it: it goes to your Safe's address on ${networkName(to)}. When it arrives I draft the loan, step 2, for you to sign.`;
    done = `Your ${a} is on ${networkName(to)} now, in the same Safe. Step 2 of 2: sign the loan below.`;
  } else if (spec.kind === "close") {
    const l = loans.find((x) => x.id === spec.loanId)!;
    loanId = l.id;
    const owed = l.debt + l.accrued;
    steps = [`Allow ${l.venue} to use ${fmt(owed)} ${l.debtAsset}`, `Repay ${fmt(owed)} ${l.debtAsset} on ${l.venue}`, `Withdraw ${fmt(l.collAmount, 2)} ${l.collAsset}`];
    title = `Close ${l.venue} loan`;
    outcome = `You pay back ${fmt(owed)} ${l.debtAsset} from the Safe and get back ${fmt(l.collAmount, 2)} ${l.collAsset}.`;
    done = `Done. Your ${l.venue} loan is closed. ${fmt(l.collAmount, 2)} ${l.collAsset} is back in the Safe.`;
    next = loans.filter((x) => x.id !== l.id);
  } else {
    const l = loans.find((x) => x.id === spec.loanId)!;
    const v = VENUES.find((x) => x.id === spec.venueId)!;
    const m = v.markets[l.collAsset]!;
    loanId = l.id;
    const u: Loan = { ...l, venue: v.name, lt: m.lt, apr: v.apr, debtAsset: v.borrowAsset };
    const saved = yearlyInterest(l.debt, l.apr) - yearlyInterest(l.debt, v.apr);
    steps = [
      `Repay ${fmt(l.debt)} ${l.debtAsset} on ${l.venue} (flash loan)`,
      `Withdraw ${fmt(l.collAmount, 2)} ${l.collAsset} from ${l.venue}`,
      `Supply ${fmt(l.collAmount, 2)} ${l.collAsset} to ${v.name}`,
      `Borrow ${fmt(l.debt)} ${v.borrowAsset} from ${v.name}`,
    ];
    title = `Refinance ${l.venue} loan to ${v.name}`;
    next = loans.map((x) => (x.id === l.id ? u : x));
    hfAfter = withHF(u);
    outcome = `Same debt. Interest rate ${l.apr}% → ${v.apr}%, about ${usd(saved)} a year less. Liquidation price: ${l.collAsset} at ${liq(l)} → ${liq(u)}.${l.debtAsset !== v.borrowAsset ? ` Your debt changes from ${l.debtAsset} to ${v.borrowAsset}.` : ""}`;
    done = `Done. Your loan is now on ${v.name}. Health factor ${hf2(hfAfter)}.`;
  }
  const feeUsd = spec.kind === "move" ? spec.move.feeUsd : networkFeeUsd(steps.length, PRICES.ETH);
  return { title, outcome, done, steps, loanId, next, hfAfter, feeUsd };
}

export function buildProposal(id: string, spec: Spec, loans: Loan[]): Proposal {
  const { next: _n, ...rest } = compute(spec, loans);
  return { id, spec, stage: 0, ...rest };
}

type Bal = Record<Asset | Stable, number>;

/** Balances of the network the proposal runs on, after it executes. Never below 0; returns a new object. Pass loans from before execution. */
// ponytail: clamps at 0 instead of blocking an unaffordable proposal; add a pre-check if the demo needs it.
export function balancesAfter(b: Bal, spec: Spec, loans: Loan[]): Bal {
  const n = { ...b };
  const add = (k: Asset | Stable, d: number) => (n[k] = Math.max(0, n[k] + d));
  if (spec.kind === "open") {
    add(spec.asset, -spec.amount);
    add(VENUES.find((v) => v.id === spec.venueId)!.borrowAsset, spec.borrow);
  } else if (spec.kind === "move") {
    add(spec.move.asset, -spec.move.amount); // the source network's balances; the store adds it on the destination
  } else if (spec.kind === "protect" || spec.kind === "close") {
    const l = loans.find((x) => x.id === spec.loanId);
    if (!l) return n;
    if (spec.kind === "protect") {
      add(l.collAsset, -spec.addColl);
      add(l.debtAsset, -spec.repay);
    } else {
      add(l.collAsset, l.collAmount);
      add(l.debtAsset, -(l.debt + l.accrued));
    }
  }
  return n;
}
