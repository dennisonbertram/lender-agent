// ENS names for Safe owners: reverse lookup on Ethereum mainnet, cached in memory per process.
// A lookup that fails or runs long gives no name, so callers fall back to the short address.
// Basenames (Base primary names) are not looked up: viem's getEnsName needs an L2 resolver route on mainnet that is not worth the extra RPC calls here.
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { parseRpcUrls } from "./chain/config";

export const ENS_TTL_MS = 60 * 60 * 1000;
export const ENS_TIMEOUT_MS = 2000;
export const DEFAULT_ENS_RPC = "https://ethereum-rpc.publicnode.com";

/** One reverse lookup: the primary name of an address, or null. Forward resolution is verified by viem's universal resolver. */
export type EnsLookup = (address: string) => Promise<string | null>;

export type EnsResolver = (addresses: string[]) => Promise<Map<string, string>>;

/** A resolver with its own cache. `now` and the timeout are injectable for tests. */
export function createEnsResolver(lookup: EnsLookup, o: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {}): EnsResolver {
  const ttl = o.ttlMs ?? ENS_TTL_MS;
  const timeoutMs = o.timeoutMs ?? ENS_TIMEOUT_MS;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { name: string | null; at: number }>();
  const one = async (lc: string): Promise<string | null> => {
    const hit = cache.get(lc);
    if (hit && now() - hit.at < ttl) return hit.name;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const name = await Promise.race([
        lookup(lc),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("ens timeout")), timeoutMs); }),
      ]);
      cache.set(lc, { name: name || null, at: now() });
      return name || null;
    } catch {
      return null; // not cached: try again on the next request
    } finally {
      clearTimeout(timer);
    }
  };
  return async (addresses) => {
    const lcs = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const names = await Promise.all(lcs.map(one));
    const out = new Map<string, string>();
    lcs.forEach((lc, i) => { const n = names[i]; if (n) out.set(lc, n); });
    return out;
  };
}

/** The mainnet RPC ENS lookups use: the first URL of the shared `RPC_URL_1` list, else the public default. */
export function ensRpcUrl(): string {
  return parseRpcUrls(process.env.RPC_URL_1)[0] ?? DEFAULT_ENS_RPC;
}

const viemLookup: EnsLookup = async (address) => {
  const client = createPublicClient({ chain: mainnet, transport: http(ensRpcUrl(), { timeout: ENS_TIMEOUT_MS, retryCount: 0 }) });
  return client.getEnsName({ address: address as `0x${string}` });
};

/** The app's resolver: mainnet via `RPC_URL_1`. */
export const resolveEnsNames: EnsResolver = createEnsResolver(viemLookup);
