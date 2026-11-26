// Reads on the destination network (any of the six; the rest of the app reads Base only). `destinationFromClient` is the
// logic over a small client; `createViemDestination` wires it to viem and RPC_URL_<chainId>.
import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http, keccak256, toHex, type Chain, type Hex } from "viem";
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from "viem/chains";
import { safeAbi } from "@/server/chain/abis";
import { CANONICAL_SAFE_SINGLETONS } from "@/server/safe/constants";
import { isSafeProxyCode } from "@/server/safe/setup";
import type { Address } from "@/shared/types";
import type { DestinationChain } from "./arrival";
import { NATIVE, type MoveChain } from "./types";

export type ProbeClient = {
  getTransactionReceipt(p: { hash: Hex }): Promise<{ status: "success" | "reverted"; blockNumber: bigint; logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] } | null>;
  getTransaction(p: { hash: Hex }): Promise<{ to: string | null; value: bigint }>;
  /** The call tree of the transaction (`debug_traceTransaction` with callTracer). Absent or throwing when the RPC has no traces. */
  traceCalls?(p: { hash: Hex }): Promise<TraceCall>;
  getCode(p: { address: Address }): Promise<Hex | undefined>;
  /** `eth_call` against a contract. Absent when this client cannot make plain calls. */
  ethCall?(p: { to: Address; data: Hex }): Promise<Hex | undefined>;
};

export type TraceCall = { type?: string; from?: string; to?: string; value?: string; error?: string; calls?: TraceCall[] };

/** Native value that reached `safe` through the call tree: successful, non-delegate calls only, nested ones only if every parent succeeded. */
function nativeInTrace(call: TraceCall, safe: string): bigint {
  if (call.error) return 0n;
  const type = (call.type ?? "CALL").toUpperCase();
  let sum = type !== "DELEGATECALL" && type !== "STATICCALL" && call.to?.toLowerCase() === safe.toLowerCase() && call.value ? BigInt(call.value) : 0n;
  for (const c of call.calls ?? []) sum += nativeInTrace(c, safe);
  return sum;
}

const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const GET_OWNERS = encodeFunctionData({ abi: safeAbi, functionName: "getOwners" });
const MASTER_COPY = encodeFunctionData({ abi: safeAbi, functionName: "masterCopy" });
const topicOf = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const no = (reason: string) => ({ ok: false as const, reason });

export function destinationFromClient(clientFor: (chainId: MoveChain) => ProbeClient): DestinationChain {
  return {
    async hasCode(chainId, address) {
      const code = await clientFor(chainId).getCode({ address });
      return !!code && code !== "0x";
    },
    async ownersOf(chainId, address) {
      try {
        const c = clientFor(chainId);
        if (!c.ethCall) return null;
        // Identity before owners: only a canonical Safe may answer. The code must be the audited SafeProxy
        // executable — byte for byte, with only the compiler's metadata tail allowed to differ, so a genuine
        // 1.3.0 proxy passes while any other contract that happens to implement getOwners fails here,
        // whatever it returns. And the singleton it serves — masterCopy(), answered by the proxy itself
        // from slot 0 — must be a canonical Safe implementation, else getOwners is the hostile code's answer.
        const code = await c.getCode({ address });
        if (!code || !isSafeProxyCode(code)) return null;
        const masterData = await c.ethCall({ to: address, data: MASTER_COPY });
        if (!masterData || masterData === "0x") return null;
        const singleton = getAddress(decodeFunctionResult({ abi: safeAbi, functionName: "masterCopy", data: masterData }));
        if (!CANONICAL_SAFE_SINGLETONS.some((s) => s.toLowerCase() === singleton.toLowerCase())) return null;
        const data = await c.ethCall({ to: address, data: GET_OWNERS });
        if (!data || data === "0x") return null;
        return [...decodeFunctionResult({ abi: safeAbi, functionName: "getOwners", data })];
      } catch {
        return null;
      }
    },
    async paysSafe({ chainId, txHash, safe, token, minRaw = 1n }) {
      try {
        const c = clientFor(chainId);
        const receipt = await c.getTransactionReceipt({ hash: txHash });
        if (!receipt) return no("the destination transaction is not confirmed yet");
        if (receipt.status !== "success") return no("the destination transaction reverted");
        let paid = 0n;
        if (token.toLowerCase() !== NATIVE) {
          // Token: Transfer(from, safe, value) events of that token in this transaction.
          for (const l of receipt.logs) {
            if (l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER && l.topics[2]?.toLowerCase() === topicOf(safe)) paid += BigInt(l.data);
          }
        } else {
          const tx = await c.getTransaction({ hash: txHash });
          if (tx.to && tx.to.toLowerCase() === safe.toLowerCase() && tx.value > 0n) paid = tx.value;
          else {
            // Native ETH can arrive inside the call (a relayer forwarding it). Only this transaction's own internal transfers prove
            // it: the Safe's block balance would count an unrelated deposit. Without traces we cannot prove it, and keep waiting.
            if (!c.traceCalls) return no("the destination transaction's internal transfers cannot be read yet");
            const trace = await c.traceCalls({ hash: txHash }).catch(() => null);
            if (!trace) return no("the destination transaction's internal transfers cannot be read yet");
            paid = nativeInTrace(trace, safe);
          }
        }
        if (paid <= 0n) return no("the destination transaction does not pay the Safe");
        return paid >= minRaw ? { ok: true, amountRaw: paid } : no("the destination transaction pays less than expected");
      } catch (e) {
        return no(`the destination transaction could not be read: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

const CHAINS: Record<number, Chain> = { 1: mainnet, 8453: base, 42161: arbitrum, 10: optimism, 137: polygon, 100: gnosis };

/** Real chains: `RPC_URL_<chainId>`, else the viem chain's public default. */
export function createViemDestination(env: Record<string, string | undefined> = process.env): DestinationChain {
  const clients = new Map<number, ProbeClient>();
  return destinationFromClient((chainId) => {
    let c = clients.get(chainId);
    if (!c) {
      const chain = CHAINS[chainId];
      if (!chain) throw new Error(`Network ${chainId} is not supported.`);
      const pc = createPublicClient({ chain, transport: http(env[`RPC_URL_${chainId}`]?.split(",")[0]?.trim() || undefined) });
      c = Object.assign(pc, {
        traceCalls: ({ hash }: { hash: Hex }) => (pc as unknown as { request(a: { method: string; params: unknown[] }): Promise<TraceCall> }).request({ method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] }),
        ethCall: async ({ to, data }: { to: Address; data: Hex }) => (await pc.call({ to, data })).data,
      }) as unknown as ProbeClient;
      clients.set(chainId, c);
    }
    return c;
  });
}
