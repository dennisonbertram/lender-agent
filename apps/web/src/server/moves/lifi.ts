// A thin HTTP client for LI.FI (D-18): GET /v1/quote and GET /v1/status, nothing else. Behind `BridgeAggregator`,
// so tests use recorded responses and nothing in the app depends on LI.FI's shapes.
import { getAddress } from "viem";
import type { Address, Hex } from "@/shared/types";
import { AggregatorError, NATIVE, type AggregatorQuote, type BridgeAggregator, type QuoteParams, type StatusParams, type TransferStatus } from "./types";

/** The LI.FI Diamond: the same address on every network we use (M0-7). The only contract a move may call or approve. */
export const LIFI_DIAMOND: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type LifiOptions = { fetch?: FetchLike; apiKey?: string; baseUrl?: string; now?: () => number; timeoutMs?: number };

type Token = { address: string; decimals: number };
type Cost = { amountUSD?: string };
type WireQuote = {
  id: string; tool: string;
  action: { fromChainId: number; toChainId: number; fromToken: Token; toToken: Token; fromAddress: string; toAddress: string };
  estimate: { approvalAddress?: string; skipApproval?: boolean; fromAmount: string; toAmount: string; toAmountMin: string; executionDuration?: number; feeCosts?: Cost[]; gasCosts?: Cost[] };
  transactionRequest?: { from: string; to: string; chainId: number; data: string; value?: string };
};
type WireStatus = { status?: string; substatus?: string; substatusMessage?: string; receiving?: { txHash?: string; chainId?: number; amount?: string; token?: { address?: string } } };

const usd = (costs: Cost[] | undefined) => (costs ?? []).reduce((sum, c) => sum + (Number(c.amountUSD) || 0), 0);

export function createLifi(opts: LifiOptions = {}): BridgeAggregator {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = opts.baseUrl ?? "https://li.quest";
  const now = opts.now ?? Date.now;
  const headers: Record<string, string> = { accept: "application/json", ...(opts.apiKey ? { "x-lifi-api-key": opts.apiKey } : {}) };

  async function get(path: string, query: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const url = `${base}${path}?${new URLSearchParams(query)}`;
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
      const text = await res.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, body };
    } catch (e) {
      throw new AggregatorError(`The bridge service could not be reached: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    async quote(p: QuoteParams): Promise<AggregatorQuote | null> {
      const { status, body } = await get("/v1/quote", {
        fromChain: String(p.fromChain), toChain: String(p.toChain), fromToken: p.fromToken, toToken: p.toToken,
        fromAmount: p.fromAmount.toString(), fromAddress: p.address, toAddress: p.address, slippage: String(p.slippage ?? 0.005),
      });
      if (status === 404 || status === 422) return null; // no route (codes 1001, 1002)
      if (status < 200 || status >= 300 || !body) throw new AggregatorError(`The bridge service answered ${status}.`);
      const q = body as WireQuote;
      const tx = q.transactionRequest;
      if (!tx || !q.estimate || !q.action) throw new AggregatorError("The bridge quote had no transaction.");
      const native = q.action.fromToken.address.toLowerCase() === NATIVE;
      return {
        id: q.id, tool: q.tool,
        fromChain: q.action.fromChainId, toChain: q.action.toChainId,
        fromToken: getAddress(q.action.fromToken.address), toToken: getAddress(q.action.toToken.address),
        fromAmount: BigInt(q.estimate.fromAmount), toAmount: BigInt(q.estimate.toAmount), toAmountMin: BigInt(q.estimate.toAmountMin),
        fromDecimals: q.action.fromToken.decimals, toDecimals: q.action.toToken.decimals,
        fromAddress: getAddress(q.action.fromAddress), toAddress: getAddress(q.action.toAddress),
        approvalAddress: native || q.estimate.skipApproval || !q.estimate.approvalAddress ? null : getAddress(q.estimate.approvalAddress),
        durationSec: q.estimate.executionDuration ?? 0,
        feeUsd: usd(q.estimate.feeCosts) + usd(q.estimate.gasCosts),
        tx: { to: getAddress(tx.to), data: tx.data as Hex, value: BigInt(tx.value ?? 0), from: getAddress(tx.from), chainId: tx.chainId },
        quotedAt: now(),
      };
    },

    async status(p: StatusParams): Promise<TransferStatus> {
      const { status, body } = await get("/v1/status", { txHash: p.txHash, fromChain: String(p.fromChain), toChain: String(p.toChain), ...(p.bridge ? { bridge: p.bridge } : {}) });
      // "Not found" is not failure (docs): the transfer may not be indexed yet. HTTP 404 code 1003, or 200 NOT_FOUND.
      if (status === 404) return { state: "not_found" };
      if (status < 200 || status >= 300 || !body) throw new AggregatorError(`The bridge service answered ${status}.`);
      const s = body as WireStatus;
      const out: TransferStatus = { state: s.status === "DONE" ? "done" : s.status === "FAILED" ? "failed" : s.status === "PENDING" ? "pending" : "not_found" };
      if (s.substatus) out.sub = s.substatus;
      if (s.substatusMessage) out.message = s.substatusMessage;
      if (s.receiving?.txHash && s.receiving.chainId !== undefined && s.receiving.amount !== undefined) {
        out.receiving = { txHash: s.receiving.txHash as Hex, chainId: s.receiving.chainId, amount: BigInt(s.receiving.amount), token: s.receiving.token?.address ? getAddress(s.receiving.token.address) : null };
      }
      return out;
    },
  };
}
