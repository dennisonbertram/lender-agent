// Safe reads. Owners, threshold and nonce are read live (architecture section 5), never from the DB.
import type { Address, ChainId } from "@/shared/types";
import { safeAbi } from "./abis";
import { getPublicClient } from "./client";

export async function isDeployed(chainId: ChainId, safe: Address): Promise<boolean> {
  const code = await getPublicClient(chainId).getCode({ address: safe });
  // An EOA that delegates through EIP-7702 has code `0xef0100…`; it is still not a Safe.
  return !!code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100");
}

/** Owners, or null when there is no code at the address (not deployed, or an EOA). */
export async function readSafeOwners(chainId: ChainId, safe: Address): Promise<Address[] | null> {
  if (!(await isDeployed(chainId, safe))) return null;
  const owners = await getPublicClient(chainId).readContract({ address: safe, abi: safeAbi, functionName: "getOwners" });
  return [...owners];
}

export async function readSafeThreshold(chainId: ChainId, safe: Address): Promise<number | null> {
  if (!(await isDeployed(chainId, safe))) return null;
  return Number(await getPublicClient(chainId).readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }));
}

export async function readSafeNonce(chainId: ChainId, safe: Address): Promise<bigint | null> {
  if (!(await isDeployed(chainId, safe))) return null;
  return getPublicClient(chainId).readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
}
