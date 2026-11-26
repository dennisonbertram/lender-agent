import { createPublicClient, fallback, http, shouldThrow, type PublicClient } from "viem";
import type { ChainId } from "@/shared/types";
import { VIEM_CHAINS, rpcUrls } from "./config";

const cache = new Map<ChainId, PublicClient>();

/**
 * Stop at a contract revert instead of asking the next RPC: a revert is the answer, and another (possibly lagging)
 * node must never turn it into a success. Only provider failures (429, timeouts, 5xx) move on.
 */
export function isTerminal(error: Error): boolean {
  if (shouldThrow(error)) return true;
  const e = error as Error & { code?: number; data?: unknown; cause?: unknown };
  if (e.code === 3) return true; // execution reverted (EIP-1474)
  if (typeof e.data === "string" && e.data.startsWith("0x") && e.data.length > 2) return true; // revert data
  if (/revert/i.test(e.message)) return true;
  return e.cause instanceof Error ? isTerminal(e.cause) : false;
}

/** A cached public client per chain id. */
export function getPublicClient(chainId: ChainId): PublicClient {
  let c = cache.get(chainId);
  if (!c) {
    // Batch JSON-RPC calls and multicall reads; with several configured RPCs, move to the next only on provider failures.
    const transports = rpcUrls(chainId).map((url) => http(url, { batch: { wait: 16 }, retryCount: 1, retryDelay: 250 }));
    c = createPublicClient({
      chain: VIEM_CHAINS[chainId],
      batch: { multicall: true },
      transport: transports.length > 1 ? fallback(transports, { retryCount: 2, retryDelay: 300, shouldThrow: isTerminal }) : transports[0]!,
    }) as PublicClient;
    cache.set(chainId, c);
  }
  return c;
}

/** Tests only: use `client` for a chain (e.g. an anvil fork); `undefined` clears it. */
export function setPublicClientForTests(chainId: ChainId, client: PublicClient | undefined) {
  if (client) cache.set(chainId, client);
  else cache.delete(chainId);
}
