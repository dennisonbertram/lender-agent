import { type Asset, type Network, type Stable } from "@/data";
import { MIN_LOAN, parseUsd } from "@/lib/loan-math";
import { starterChips, type UIBlock } from "@/lib/blocks";

export type IntentCtx = { hasLoans: boolean; balances: Record<Asset | Stable, number>; loanInView?: string; /** Most the active Safe can safely borrow, optionally on one network. */ maxCash: (n?: Network) => number };
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

  if (/\b(edit|close|refinanc\w*|reserve|morpho)\b/.test(q)) return null;
  if (/add funds|deposit/.test(q)) return funded ? { text: "Send more to this address.", block: { kind: "addfunds" } } : ADD_FUNDS;
  if (/what if|drop|fall|crash/.test(q)) return { text: "Here is what a price drop would do. Move the slider.", block: withAsset({ kind: "whatif" }, asset) };
  if (!funded && (/how much|compare|lender|\brates?\b|offer/.test(q) || amount !== null || /\b(need|borrow|cash|loan)\b/.test(q))) return ADD_FUNDS;
  if (/how much (can|could) i borrow|what can i borrow|how much/.test(q)) return { text: "Here is what you could borrow against each asset in this Safe.", block: { kind: "holdings" } };
  if (/compare|lender|\brates?\b|offer/.test(q)) return { text: "Here are the lenders.", block: withAsset({ kind: "compare", cash: Math.min(amount ?? max, max) }, asset, network) };
  if (amount !== null || /\b(need|borrow|cash|loan)\b/.test(q)) return { text: "Here is a plan. Change anything below.", block: withAsset({ kind: "plan", cash: amount ?? max }, asset, network) };
  if (/how does|how it works|explain|what is|health|liquidat|collateral|safe |reserve is/.test(q)) {
    const topic = /liquidat/.test(q) ? "liquidation" : /health/.test(q) ? "health" : /collateral/.test(q) ? "collateral" : /\bsafe\b/.test(q) ? "safe" : "how";
    return { text: "Here is the short version.", block: { kind: "explain", topic } };
  }
  if (/how am i|status|my loans|am i ok/.test(q)) return { text: "Here is where you stand.", block: { kind: "status" } };
  return { text: "I can plan a loan, compare lenders, show what a price drop would do, or explain how this works.", block: { kind: "suggestions", items: starterChips(ctx.maxCash()) } };
}
