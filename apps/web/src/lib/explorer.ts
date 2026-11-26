// Block explorer and Safe{Wallet} links. Pure: safe to import from client and server.
import { getAddress, isAddress } from "viem";
import { SAFE_PREFIX } from "@/shared/types";

const EXPLORERS: Record<number, { base: string; name: string }> = {
  1: { base: "https://etherscan.io", name: "Etherscan" },
  8453: { base: "https://basescan.org", name: "Basescan" },
  84532: { base: "https://sepolia.basescan.org", name: "Basescan" },
  42161: { base: "https://arbiscan.io", name: "Arbiscan" },
};
const PREFIXES: Record<number, string> = { 1: "eth", ...SAFE_PREFIX };
const SAFE_APP = "https://app.safe.global";

export const explorerBaseUrl = (chainId: number): string | null => EXPLORERS[chainId]?.base ?? null;
export const explorerName = (chainId: number): string | null => EXPLORERS[chainId]?.name ?? null;

const checksum = (a: string): string | null => (isAddress(a, { strict: false }) ? getAddress(a) : null);

function addressPath(kind: "address" | "token", chainId: number, a: string): string | null {
  const base = explorerBaseUrl(chainId);
  const c = checksum(a);
  return base && c ? `${base}/${kind}/${c}` : null;
}

export const explorerAddressUrl = (chainId: number, address: string) => addressPath("address", chainId, address);
export const explorerTokenUrl = (chainId: number, token: string) => addressPath("token", chainId, token);

export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const base = explorerBaseUrl(chainId);
  return base && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? `${base}/tx/${txHash}` : null;
}

/** EIP-3770 `prefix:checksummed` for a Safe, or null for an unknown chain or bad address. */
export function safeShortName(chainId: number, safe: string): string | null {
  const prefix = PREFIXES[chainId];
  const c = checksum(safe);
  return prefix && c ? `${prefix}:${c}` : null;
}

export function safeAppUrl(chainId: number, safe: string): string | null {
  const s = safeShortName(chainId, safe);
  return s ? `${SAFE_APP}/home?safe=${s}` : null;
}

/** Checksummed and shortened: `0x1234…abcd`. Invalid input comes back unchanged. */
export function formatAddress(address: string): string {
  const c = checksum(address);
  return c ? `${c.slice(0, 6)}…${c.slice(-4)}` : address;
}
