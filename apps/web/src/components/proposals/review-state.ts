// The proposal page's one table: where a proposal is for the viewer -> words, one primary and the
// secondary actions (sign-flow decision; copy from the internal panel's states table). Pure.
import type { ProposalView } from "@/server/proposals/view";

export type Phase = "idle" | "walletOpen" | "walletClosed" | "saving";
export type Tone = "warning" | "success" | "destructive" | "muted" | "working";

export type ReviewCtx = {
  phase: Phase;
  /** Default on: the last approver approves and sends in one step. */
  lastSignerSends: boolean;
  /** The viewer's wallet is a smart account: approving is an on-chain approveHash step. */
  smartAccount?: boolean;
  /** "about $0.02", when the simulation passed. */
  fee?: string | null;
  /** The wallet has no ETH for the network fee. */
  noFeeEth?: boolean;
  /** The wallet has some ETH, but not enough for the estimated fee. */
  feeShort?: boolean;
  /** The pre-send simulation reverted: why. */
  wouldFail?: string | null;
  /** A new simulation passes, so a failed send can be tried again. */
  retryable?: boolean;
  /** Whether the latest send precheck completed successfully. */
  precheckReady?: boolean;
  /** The latest send precheck is still running. */
  precheckBusy?: boolean;
  /** The latest send precheck could not be completed. */
  precheckError?: string | null;
  /** The signed-in wallet is not an owner of this Safe. */
  wrongWallet?: boolean;
  /** When the viewer approved, e.g. "2:31 pm". */
  approvedAt?: string;
  /** The Safe's short address, for the wallet check ("0x5afe…0001"). */
  safe?: string;
  /** A send is in flight in this tab. */
  sendBusy?: boolean;
  /** The send was submitted from this tab and the server has not reported executed/failed yet. */
  sending?: boolean;
  /** Explorer link for the transaction this tab sent. */
  txUrl?: string;
  /** The network fee actually paid, "0.00002 ETH ($0.06)", only from the execution receipt. Never an estimate. */
  feePaid?: string;
  /** The last estimate, "about $0.02", shown after the run when no paid figure is known. */
  feeEstimate?: string;
  /** Who sent the executed transaction: "you" or a name. */
  sender?: string;
  /** The executed plan's loan is listed. */
  loanListed?: boolean;
  /** Where "Make a new plan" / "Back to the loan" goes, from ProposalNext. */
  next?: { text: string; href: string } | null;
};

export type PrimaryKey = "sign" | "approveSend" | "send" | "copy" | "earlier" | "newPlan" | "seeNew" | "loan" | "retrySend" | "checkAgain" | "switch" | "wait" | "none";
export type Secondary = "decline" | "safe" | "fundedSafe" | "onlyApprove" | "tryAgain" | "viewTx" | "receipt" | "checkAgain" | "rejectInSafe" | "seeChanged" | "signOut";

export type Descriptor = {
  /** Machine name of the state or variant (tests, screenshots). */
  id: string;
  pill: string | null;
  tone: Tone;
  headline: string;
  body?: string;
  note?: { tone: "info" | "ok" | "warn" | "bad" | "muted"; text: string; /** Phones show `short` and put the rest under "What to check". */ short?: string };
  primary: { key: PrimaryKey; label: string; busy?: boolean; disabled?: boolean; href?: string; external?: boolean };
  helper?: string;
  secondary: Secondary[];
};

const FREE = "Free. Approving sends no money.";
const NEW_PLAN_HELP = "Review the latest account details before trying again.";

/** "your co-owner" / "2 co-owners": the owners who haven't approved yet, excluding the viewer. */
export function coOwnerName(p: ProposalView): string {
  const waiting = (p.owners ?? []).filter((o) => !o.signed && !o.isYou).length;
  return waiting > 1 ? `${waiting} co-owners` : "your co-owner";
}
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function precheckUnavailable(ctx: ReviewCtx, headline = "Checking if it can be sent", allowApprove = false): Descriptor {
  return {
    id: "precheck_unavailable", pill: "Can't check yet", tone: "warning", headline,
    note: { tone: "warn", text: `${ctx.precheckError ?? "We couldn't check whether this transaction can be sent."} Nothing was approved or sent. Check again before sending.` },
    primary: { key: "checkAgain", label: ctx.precheckBusy ? "Checking…" : "Check again", busy: ctx.precheckBusy, disabled: ctx.precheckBusy },
    secondary: allowApprove ? ["onlyApprove", "decline", "safe"] : ["safe"],
  };
}

function feeRecovery(p: ProposalView, ctx: ReviewCtx, approvalNeeded: boolean): string {
  const fee = ctx.fee ?? "a small network fee";
  const network = NETWORK_NAME[p.chainId] ?? "this network";
  const wallet = ctx.noFeeEth ? "This wallet has no ETH" : "This wallet doesn't have enough ETH";
  if (approvalNeeded) return `Your approval is the last one needed, and approving is free. Sending it needs ${fee} in ETH on ${network}. ${wallet}. Approve in your wallet first. Once it's recorded, an owner with enough ETH can send it, or add ETH to this wallet.`;
  const solo = p.threshold === 1 && p.owners?.length === 1;
  return `The proposal is ready to send. Sending needs ${fee} in ETH on ${network}. ${wallet}. ${solo ? "The only owner will need enough ETH to send it, or add ETH to this wallet." : "Either owner can send from a wallet with enough ETH, or add ETH to this wallet."}`;
}

export function isOwner(p: ProposalView): boolean {
  return !!p.owners?.some((o) => o.isYou);
}

export function describe(p: ProposalView, ctx: ReviewCtx): Descriptor {
  const none = { key: "none" as const, label: "" };
  if (ctx.wrongWallet) {
    return { id: "wrong_wallet", pill: null, tone: "muted", headline: "This needs a different wallet", body: "You're connected with a wallet that isn't an owner of this Safe. This plan needs approval from an owner.", primary: { key: "switch", label: "Switch wallet" }, secondary: ["signOut"] };
  }
  if (p.hashMismatch) {
    return { id: "hash_mismatch", pill: "Can't be approved", tone: "destructive", headline: "This plan doesn't match what's stored", body: "Don't approve it. Check it in Safe{Wallet} or make a new plan.", primary: { key: "newPlan", label: "Make a new plan", href: ctx.next?.href }, secondary: ["safe"] };
  }
  if (p.stage === "sending") return sendingDescriptor(p, ctx);
  const state = p.state;
  // A send is pending (this tab, or the server has the hash): never show Ready or "out of date" meanwhile.
  if (state !== "executed" && state !== "failed" && (ctx.sending || p.pendingTxHash)) return sendingDescriptor(p, ctx);
  if (state === "failed" && ctx.sending) return sendingDescriptor(p, ctx);
  const owner = isOwner(p);
  const name = coOwnerName(p);
  const t = p.threshold ?? 2;
  const fee = ctx.fee ? ctx.fee : "a small network fee";
  const walletShort = `Your wallet will ask you to sign for Safe ${ctx.safe ? `${ctx.safe} ` : ""}on ${NETWORK_NAME[p.chainId] ?? "Base"}.`;
  const walletNote = `${walletShort.slice(0, -1)}, with a code starting ${p.safeTxHash?.slice(0, 6) ?? "0x…"}. If it shows anything else, don't approve.`;
  const decline: Secondary[] = owner ? ["decline", "safe"] : ["safe"];

  switch (state) {
    case "needs_your_signature": {
      if (ctx.phase === "walletOpen") {
        return { id: "wallet_open", pill: "Check your wallet", tone: "warning", headline: "Confirm in your wallet", body: "A request from your wallet should be open. Approve it there; this page updates the moment you come back.", primary: { key: "wait", label: "Waiting for your wallet…", busy: true, disabled: true }, helper: "Don't see it? Open your wallet app.", secondary: ["tryAgain"] };
      }
      if (ctx.phase === "saving") {
        return { id: "saving", pill: "Saving your approval", tone: "warning", headline: "Got it. Saving your approval…", body: "Your wallet confirmed. This takes a few seconds; you can stay on this page.", primary: { key: "wait", label: "Saving…", busy: true, disabled: true }, secondary: [] };
      }
      // One approval is enough (solo) is a threshold; being the only owner is a roster fact.
      const solo = t === 1;
      const onlyOwner = solo && p.owners?.length === 1;
      const who = onlyOwner ? "You're the only owner, so approving is all it takes." : "Your approval is enough: any one owner can approve and send.";
      const last = p.signedCount === t - 1 && (p.signedCount > 0 || solo);
      const closed = ctx.phase === "walletClosed";
      const headline = closed ? "You closed the wallet request" : solo ? "Your approval is needed" : last ? `${upper(name)} approved. Now it's you` : "Your approval is needed";
      const lead = closed ? "Nothing was approved." : solo ? (ctx.lastSignerSends && p.canSend ? `${who} You can approve and send in one step.` : `${onlyOwner ? "You're the only owner. " : "Your approval is enough. "}Once you approve, it's ready to send.`) : last ? (ctx.lastSignerSends && p.canSend ? "Your approval is the last one needed. You can approve and send in one step." : "Once you approve, it's ready to send.") : !p.owners ? (t > 2 || p.threshold === undefined ? `Nothing moves until ${t} owners approve and someone presses Send.` : "Nothing moves until both of you approve and someone presses Send.") : undefined; // with the approvals panel on the page its caption says this
      if (ctx.smartAccount) {
        return { id: "smart_account", pill: "Needs your approval", tone: "warning", headline, body: "Your wallet is a smart account, so approving is a small on-chain step. It counts once it's confirmed, usually in under a minute.", primary: { key: "sign", label: `Approve (${fee})` }, helper: "Paid from your wallet in ETH.", secondary: decline };
      }
      if (last && ctx.lastSignerSends && p.canSend && !closed) {
        // The combined approve-and-send was checked and would not go through: surface the reason and
        // recoveries, never another "Approve and send". The free approval is still a valid fallback.
        if (ctx.wouldFail) {
          return { id: "approve_send_failed", pill: "Can't send yet", tone: "warning", headline: "Approve and send can't run right now", note: { tone: "warn", text: `${ctx.wouldFail.replace(/\.$/, "")}. Nothing was approved or sent.` }, primary: { key: "checkAgain", label: ctx.precheckBusy ? "Checking…" : "Check again", busy: ctx.precheckBusy, disabled: ctx.precheckBusy }, helper: "Check the latest loan and Safe state before sending.", secondary: ["onlyApprove", ...decline] };
        }
        if (ctx.precheckReady === false) {
          return precheckUnavailable(ctx, "Checking if it can be sent", true);
        }
        if (ctx.noFeeEth || ctx.feeShort) {
          return { id: "needs_last_no_fee", pill: "Needs your approval", tone: "warning", headline, body: feeRecovery(p, ctx, true), primary: { key: "sign", label: "Approve in your wallet" }, helper: FREE, secondary: decline };
        }
        return { id: "needs_last_send", pill: "Needs your approval", tone: "warning", headline, body: lead, note: { tone: "info", text: `${walletNote} It also sends the transaction.`, short: walletShort }, primary: { key: "approveSend", label: "Approve and send" }, helper: ctx.fee ? `One step: approves and sends together. ${feeToRun(ctx.fee)}` : "One step: approves and sends together. You pay a small network fee.", secondary: ["onlyApprove", ...decline] };
      }
      return { id: closed ? "wallet_closed" : last ? "needs_last" : "needs_your_signature", pill: "Needs your approval", tone: "warning", headline, body: lead, note: closed ? undefined : { tone: "info", text: walletNote, short: walletShort }, primary: { key: "sign", label: "Approve in your wallet" }, helper: FREE, secondary: decline };
    }
    case "waiting_for_others": {
      return { id: "waiting_for_others", pill: `Waiting for ${name}`, tone: "warning", headline: `Waiting for ${name}`, body: `${ctx.approvedAt ? `You approved at ${ctx.approvedAt}. ` : ""}Send ${name} the link so they can review and approve here. This page updates when they do.`, primary: { key: "copy", label: `Copy link for ${name}` }, secondary: decline };
    }
    case "ready_to_send": {
      if (ctx.wouldFail) {
        return { id: "would_fail", pill: "Can't send yet", tone: "warning", headline: "Sending would fail right now", note: { tone: "warn", text: `${ctx.wouldFail.replace(/\.$/, "")}. Nothing was sent and no fee was charged.` }, primary: { key: "checkAgain", label: ctx.precheckBusy ? "Checking…" : "Check again", busy: ctx.precheckBusy, disabled: ctx.precheckBusy }, helper: "Check the latest loan and Safe state before sending.", secondary: ["safe"] };
      }
      const headline = t > 2 ? "All approvals are in. Ready to send" : "Both approved. Ready to send";
      if (ctx.precheckReady === false) return precheckUnavailable(ctx, headline);
      if (ctx.noFeeEth || ctx.feeShort || !p.canSend) {
        const solo = p.threshold === 1 && p.owners?.length === 1;
        return { id: "no_fee_eth", pill: "Ready to send", tone: "warning", headline, body: feeRecovery(p, ctx, false), primary: solo ? none : { key: "copy", label: "Copy link for another owner" }, secondary: ["safe"] };
      }
      return { id: "ready_to_send", pill: "Ready to send", tone: "warning", headline, body: "Either of you can send it. Nothing moves until someone presses Send.", note: ctx.fee ? { tone: "muted", text: feeToRun(ctx.fee) } : undefined, primary: { key: "send", label: "Send transaction", busy: ctx.sendBusy, disabled: ctx.sendBusy }, helper: "Paid in ETH from the wallet you're connected with.", secondary: ["safe"] };
    }
    case "sending":
      return sendingDescriptor(p, ctx);
    case "executed":
      return { id: "executed", pill: null, tone: "success", headline: p.specKind === "open" ? "Your loan is open" : "Done", body: p.specKind === "open" ? p.doneLine?.replace(/^Done\.\s*/, "") : undefined, note: { tone: "ok", text: executedLine(p, ctx) }, primary: ctx.loanListed ? { key: "loan", label: "View loan" } : { key: "loan", label: "Go to overview" }, secondary: [...(p.specKind === "open" ? ["fundedSafe" as const] : []), "receipt", "safe"] };
    case "failed":
      return { id: "failed", pill: "Didn't go through", tone: "destructive", headline: "It didn't go through", note: { tone: "bad", text: failedLine(p, ctx) }, primary: ctx.retryable ? { key: "retrySend", label: "Try sending again" } : { key: "newPlan", label: ctx.next?.text ?? "Make a new plan", href: ctx.next?.href }, helper: ctx.retryable ? "It was checked again just now and should go through." : NEW_PLAN_HELP, secondary: ["viewTx", "safe"] };
    case "blocked": {
      const b = p.blockedBy?.[0];
      return { id: "blocked", pill: "Waiting on an earlier transaction", tone: "warning", headline: "An earlier transaction has to go first", note: { tone: "warn", text: `${b ? `“${b.title}” was made before this one and hasn't been sent. ` : "An earlier transaction hasn't been sent. "}Your Safe runs transactions in order, so this one waits. Nothing is lost by waiting.` }, primary: b ? { key: "earlier", label: "Open the earlier transaction", href: `./${b.id}` } : { key: "earlier", label: "Open the earlier transaction in Safe{Wallet} ↗", href: p.links.queue, external: true }, helper: "Send or reject it, then come back.", secondary: decline };
    }
    case "out_of_date":
      if (p.inSafe && p.noncePassed === true) return { id: "out_of_date_nonce_passed", pill: "Out of date", tone: "muted", headline: "This plan can no longer run", note: { tone: "muted", text: "Your Safe has already moved past this plan. It cannot be executed, even if its old queue entry is still visible." }, primary: { key: "newPlan", label: ctx.next?.text ?? "Make a new plan", href: ctx.next?.href }, helper: NEW_PLAN_HELP, secondary: ["seeChanged"] };
      if (p.inSafe) {
        const nonceUnknown = p.noncePassed === null || p.noncePassed === undefined;
        return { id: "out_of_date_in_safe", pill: "Check this plan in Safe", tone: "warning", headline: "This plan may still be in your Safe queue", note: { tone: "warn", text: nonceUnknown ? "We couldn't check whether your Safe has moved past this plan. It may still be approved and sent. Check the queue and reject it there before making another plan." : "This transaction is still in your Safe queue and might still be approved and sent. Check the queue and reject it there before making another plan." }, primary: none, secondary: ["rejectInSafe"] };
      }
      return { id: "out_of_date", pill: "Out of date", tone: "muted", headline: "This plan is out of date", note: { tone: "muted", text: "Another transaction from your Safe went first, so this one can no longer run. Nothing was sent and nothing was spent. Approvals on this plan don't carry over." }, primary: { key: "newPlan", label: ctx.next?.text ?? "Make a new plan", href: ctx.next?.href }, helper: NEW_PLAN_HELP, secondary: ["seeChanged"] };
    case "settling":
      return { id: "settling", pill: "Checking the result", tone: "working", headline: "Checking whether this ran", body: "Your Safe has moved on. We are checking whether this transaction was the one that ran; this takes up to a minute.", primary: none, secondary: [] };
    case "rejected": {
      if (p.stage === "replaced") {
        // Approvals already given keep the old plan in Safe's queue; it shares the nonce with the new one, so only one can go through.
        const stillLive = p.signedCount > 0 && p.inSafe;
        const text = stillLive
          ? "This older plan already has approvals and can still be sent from Safe{Wallet}. Only one of the two can go through. Reject it in Safe{Wallet} if you don't want it."
          : "A newer plan replaces this one, so only one can run. Nothing was sent from this plan.";
        return { id: "replaced", pill: "Replaced", tone: "muted", headline: "You made a newer plan", note: { tone: stillLive ? "warn" : "muted", text }, primary: p.replacedBy ? { key: "seeNew", label: "See the new plan", href: `./${p.replacedBy}` } : none, secondary: stillLive ? ["safe"] : [] };
      }
      const still = p.inSafe;
      return { id: "rejected", pill: "Rejected", tone: "muted", headline: "This plan was rejected", note: { tone: "muted", text: still ? "Nothing was sent. It still shows in Safe{Wallet}, and any approval already given still counts there, so it could be sent from there until your Safe runs another transaction. To cancel it for good, reject it in Safe{Wallet}." : "Nothing was sent, and it's gone from your Safe's queue." }, primary: { key: "newPlan", label: ctx.next?.text ?? "Make a new plan", href: ctx.next?.href }, secondary: still ? ["rejectInSafe"] : [] };
    }
    default:
      return { id: "draft", pill: "Draft", tone: "muted", headline: "This plan isn't sent to your Safe yet", primary: none, secondary: [] };
  }
}

function sendingDescriptor(p: ProposalView, ctx: ReviewCtx): Descriptor {
  const unresolved = p.stage === "sending";
  return { id: unresolved ? "sending_unknown" : "sending", pill: unresolved ? "Checking submission" : "Sending", tone: "working", headline: unresolved ? "Checking the Safe submission" : `Sending to ${NETWORK_NAME[p.chainId] ?? "Base"}…`, body: unresolved ? p.sentence : "Usually under a minute. You can leave this page; we'll keep watching.", primary: unresolved ? { key: "earlier", label: "Check Safe queue", href: p.links.queue, external: true } : { key: "wait", label: "Sending…", busy: true, disabled: true }, secondary: p.pendingTxHash || ctx.txUrl ? ["viewTx"] : [] };
}

const NETWORK_NAME: Record<number, string> = { 8453: "Base", 84532: "Base Sepolia", 1: "Ethereum", 42161: "Arbitrum", 10: "Optimism", 137: "Polygon", 100: "Gnosis" };

/** "1.24 ETH", the collateral the plan locks, read from the money rows. */
function lockedOf(p: ProposalView): string | null {
  const row = p.facts?.changes.find((c) => c.tone === "out" && /ETH|BTC/.test(c.amount));
  return row ? row.amount.replace(/^[−-]\s*/, "") : null;
}

/** Past tense for a finished plan: "You borrowed 1,000 USDC from Morpho and locked 0.5621 ETH." Null when the plan isn't an open loan we can read. */
export function doneSentence(p: ProposalView): string | null {
  if (p.specKind !== "open") return null;
  const got = p.facts?.changes.find((c) => c.tone === "in")?.amount.replace(/^\+\s*/, "");
  const locked = lockedOf(p);
  if (!got || !locked) return null;
  return `You borrowed ${got} from ${p.facts?.terms.find((x) => x.label === "Lender")?.value ?? "your lender"} and locked ${locked}.`;
}

/** The one sentence for the fee before it runs: an estimate, paid by whoever presses Send. */
const feeToRun = (fee?: string | null) => `Network fee to run it: ${fee} (paid by whoever presses Send)`;

function executedLine(p: ProposalView, ctx: ReviewCtx): string {
  const by = ctx.sender === "you" ? ", by you" : "";
  const fee = ctx.feePaid ? ` Network fee paid: ${ctx.feePaid}${by}.` : ctx.feeEstimate ? ` Network fee: ${ctx.feeEstimate}.` : "";
  // The card body already says what was borrowed and locked (doneSentence), so the note carries only the fee.
  return doneSentence(p) ? fee.trim() : `${p.doneLine ?? "Done."}${fee}`;
}

function failedLine(p: ProposalView, ctx: ReviewCtx): string {
  const reason = (p.failedReason ?? "The transaction reverted.").replace(/\s*Nothing in your Safe changed\.?$/, "").replace(/\.$/, "");
  return `${reason}. Nothing in your Safe changed. The network fee${ctx.feePaid ? ` of ${ctx.feePaid}` : ""} was still paid${ctx.sender === "you" ? " by you" : ""}.`;
}

/** The words for the one link to the proposal page from a list surface (chat card, overview, sent view). */
export function actionLabel(d: Descriptor): string {
  if (d.id === "sending_unknown") return "Check Safe queue";
  if (d.id === "sending") return "Sending…";
  if (d.id === "precheck_unavailable" || d.id === "would_fail" || d.id === "approve_send_failed") return "Check again";
  if (d.id === "blocked" || d.id === "failed") return "See why";
  if (d.id.startsWith("needs") || d.id === "wallet_open" || d.id === "wallet_closed" || d.id === "saving" || d.id === "smart_account") return "Review and approve";
  if (d.id === "ready_to_send" || d.id === "no_fee_eth") return "Review and send";
  return "Review";
}

/** The fee a receipt shows: "0.00004 ETH ($0.12)", from gasUsed × effectiveGasPrice. The dollars need a known ETH price. */
export function feeFromReceipt(receipt: { gasUsed: bigint; effectiveGasPrice: bigint }, ethUsd?: number | null): string {
  const wei = receipt.gasUsed * receipt.effectiveGasPrice;
  const eth = Number(wei) / 1e18;
  const ethText = eth === 0 ? "0 ETH" : eth < 0.000001 ? "under 0.000001 ETH" : `${Number(eth.toPrecision(2))} ETH`;
  if (!ethUsd) return ethText;
  const usd = eth * ethUsd;
  return `${ethText} (${usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`})`;
}
