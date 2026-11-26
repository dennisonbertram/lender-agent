import type { Asset, Network, Stable } from "@/lib/types";
import { MIN_LOAN, parseUsd } from "@/lib/loan-math";
import { MAX_DROP, nearestDropStep } from "@/lib/whatif-drop";
import { centDigits, usd } from "@/lib/format";
import { starterChips, type UIBlock, type Urgent } from "@/lib/blocks";

/** The worst of the Safe's loans, read live. Healthy only when every loan is affirmatively healthy; a failed or missing read is "unknown". */
export type LoanStanding = { status: "healthy" | "watch" | "risk" | "liquidatable" | "unknown"; health?: number; loanId?: string };
export type IntentCtx = { hasLoans: boolean; balances: Record<Asset | Stable, number>; loanInView?: string; /** Most the active Safe can safely borrow, optionally on one network. */ maxCash: (n?: Network) => number; /** A loan is at risk: no Borrow chip (VC-03). */ urgent?: Urgent; /** The Safe has an open loan (a live read, never a monitor snapshot): loan questions answer about it. */ hasLoan?: boolean; /** The Safe has a loan proposal waiting for signatures. */ openProposal?: boolean; /** Where the open loans stand; absent = unknown. */ standing?: LoanStanding };
export type Intent = { text?: string; block?: UIBlock };

const ADD_FUNDS: Intent = { text: "First add crypto to borrow against. Send it to this address.", block: { kind: "addfunds" } };

const assetOf = (q: string): Asset | undefined => (/wsteth/.test(q) ? "wstETH" : /wbtc|bitcoin|btc/.test(q) ? "WBTC" : /\beth\b|ether/.test(q) ? "ETH" : undefined);
const networkOf = (q: string): Network | undefined => (/\bbase\b/.test(q) ? "base" : /arbitrum/.test(q) ? "arbitrum" : /optimism/.test(q) ? "optimism" : /polygon/.test(q) ? "polygon" : /gnosis/.test(q) ? "gnosis" : /ethereum|mainnet/.test(q) ? "ethereum" : undefined);
const withAsset = <T extends UIBlock>(b: T, asset?: Asset, network?: Network): T => ({ ...b, ...(asset && { asset }), ...(network && { network }) });

/** Scripted router for the chat: which block answers this text. null = the existing router handles it. First match wins. */
export function routeIntent(text: string, ctx: IntentCtx): Intent | null {
  const q = text.toLowerCase();
  const asset = assetOf(q);
  const network = networkOf(q);
  const amount = parseUsd(text);
  const max = ctx.maxCash(network) || ctx.maxCash(); // a network with nothing on it falls back to the whole Safe
  const funded = ctx.maxCash() >= MIN_LOAN;

  // A sizing question ("what would it take for $50,000?") is the model path's hypothetical plan: it shows the collateral and cannot be sent.
  if (amount !== null && /what would it take|how much (collateral|would i need|do i need)/.test(q)) return { text: "Here is the collateral that amount would need. Nothing can be sent from it.", block: withAsset({ kind: "plan", cash: amount, hypothetical: true }, asset, network) };

  const loan = ctx.hasLoan || ctx.hasLoans || !!ctx.urgent;
  if (/who can (move|send|spend|take|access|touch)|who (controls|has access|owns)|can the (agent|bot|ai)|can you (move|send|take|spend)\b.*\b(funds|money)|who can .*\b(funds|money)/.test(q)) return { text: "Only the owners of this Safe can move your funds, by approving in this app. I only suggest.", block: { kind: "explain", topic: "safe" } };
  if (loan) {
    if (/\b(close (it|this|my loan|the loan)|pay (it |this |the loan |my loan )?(all |everything )?(off|back in full)|settle)\b/.test(q)) return { text: "You can repay any time, with no penalty. Closing repays all the debt and returns your collateral. Open your loan below to close it.", block: { kind: "status" } };
    if (/\b(pay (it |this |the loan |my loan )?back|repay\w*|paying (it )?back)\b/.test(q)) {
      const typed = amount !== null ? `, type ${usd(amount, centDigits(amount))},` : ", type the amount,";
      return { text: `You can repay any time, with no penalty. To repay part of it, open your loan below${typed} and tap Repay. To repay it all and get your collateral back, use "Close this loan" on the loan.`, block: { kind: "status" } };
    }
    if (/\binterest\b|\bapr\b|what('s| is) (my|the) rate|how much .*\b(cost|paying)\b/.test(q) && !/\bcompare\b/.test(q)) return { text: "Your rate and yearly cost are on your loan. Open it below.", block: { kind: "status" } };
    if (/how('s| is| am)( my| i)?( loan)?( doing)?|am i (ok|okay|safe|fine)|my loan\b.*\b(ok|okay|safe|healthy|doing)|is my loan/.test(q) && !/\b(fix|protect)\b/.test(q)) return { text: "Here is where your loan stands.", block: { kind: "status" } };
    if (!ctx.urgent && /\b(fix|protect|save)\b.*\bloan\b/.test(q)) {
      const st = ctx.standing;
      if (st?.status === "healthy") return { text: "Your loan is healthy; nothing to fix. You can see what a price drop would do.", block: { kind: "suggestions", items: ["What if the price drops?", "How is my loan doing?"] } };
      if (st?.status === "watch" && st.loanId) return { text: `Your loan is in the Watch range (health ${st.health === undefined ? "below the Watch level" : st.health.toFixed(2)}); here are ways to add margin. Nothing is sent until you approve it here, then your co-owner.`, block: { kind: "fix", loanId: st.loanId } };
      return { text: "I can't confirm your loan is healthy right now. Here is where it stands.", block: { kind: "status" } };
    }
    if (!ctx.urgent && funded && /borrow\b[^.?!]*\bmore\b|more (cash|money)|top.?up|another loan|add to (my|the|this) loan|borrow again/.test(q)) return { text: "Here is a top-up. It adds to your existing loan. Change anything below.", block: withAsset({ kind: "plan", cash: amount ?? max }, asset, network) };
  }
  if (/what('s| is| do i have)\b.*\bin (my|the) safe|what (do i|does the safe) (have|hold)|my (holdings|balances?)|show me with numbers|with numbers/.test(q)) return { text: "Here is what this Safe holds and what you could borrow against it.", block: { kind: "holdings" } };
  if (ctx.urgent && /\b(fix|protect)\b.*\bloan\b/.test(q)) return { text: "Here are ways to fix it. Nothing is sent until you approve it here, then your co-owner.", block: { kind: "fix", loanId: ctx.urgent.loanId } };
  if (/\b(edit|close|refinanc\w*|reserve|morpho)\b/.test(q)) return null;
  if (/add funds|deposit/.test(q)) return funded ? { text: "Send more to this address.", block: { kind: "addfunds" } } : ADD_FUNDS;
  if (/what if|drop|fall|crash/.test(q)) {
    const typed = /(\d{1,3})\s?(%|percent)/i.exec(text);
    const asked = typed ? Number(typed[1]) : null;
    const ask = asked === null ? {} : { drop: nearestDropStep(asked), ...(asked > MAX_DROP && { capped: true as const }) };
    return { text: "Here is what a price drop would do. Move the slider.", block: withAsset({ kind: "whatif", ...ask }, asset) };
  }
  if (!funded && (/how much|compare|lender|\brates?\b|offer/.test(q) || amount !== null || /\b(need|borrow|cash|loan)\b/.test(q))) return ADD_FUNDS;
  if (/how much (can|could) i borrow|what can i borrow|how much/.test(q)) return { text: "Here is what you could borrow against each asset in this Safe.", block: { kind: "holdings" } };
  if (/compare|lender|\brates?\b|offer/.test(q)) return { text: "Here are the lenders.", block: withAsset({ kind: "compare", cash: Math.min(amount ?? max, max) }, asset, network) };
  if (amount === null && /\b(need|want|borrow|cash|money|loan)\b/.test(q) && !/\b(max|most|all|everything|up to)\b/.test(q)) {
    const half = Math.floor(max / 2 / 100) * 100;
    return { text: "How much do you need?", block: { kind: "suggestions", items: [`Borrow ${usd(max)}`, ...(half >= MIN_LOAN && half < max ? [`Borrow ${usd(half)}`] : []), "How much can I borrow?"] } };
  }
  if (amount !== null || /\b(need|borrow|cash|loan)\b/.test(q)) return { text: "Here is a plan. Change anything below.", block: withAsset({ kind: "plan", cash: amount ?? max }, asset, network) };
  if (/how does|how it works|explain|what is|health|liquidat|collateral|safe |reserve is/.test(q)) {
    const topic = /liquidat/.test(q) ? "liquidation" : /health/.test(q) ? "health" : /collateral/.test(q) ? "collateral" : /\bsafe\b/.test(q) ? "safe" : "how";
    return { text: "Here is the short version.", block: { kind: "explain", topic } };
  }
  if (/how am i|status|my loans|am i ok/.test(q)) return { text: "Here is where you stand.", block: { kind: "status" } };
  return { text: "I can plan a loan, compare lenders, show what a price drop would do, or explain how this works.", block: { kind: "suggestions", items: starterChips(ctx.maxCash(), ctx.urgent) } };
}
