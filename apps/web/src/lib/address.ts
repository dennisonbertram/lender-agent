import { getAddress, isAddress } from "viem";

/** Returns an error message, or null when `address` is a well-formed 0x address that is not already in `existing`. */
export function validateAddress(address: string, existing: string[] = []): string | null {
  const a = address.trim();
  if (!a) return "Enter an address.";
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return "This is not a valid address. Addresses start with 0x and are 42 characters long.";
  if (existing.some((e) => e.toLowerCase() === a.toLowerCase())) return "You already added this Safe.";
  return null;
}

/** Checksummed and shortened (`0x5aFE…0001`); input that is not an address is shortened as is. */
export const shortAddress = (a: string) => {
  const c = isAddress(a, { strict: false }) ? getAddress(a) : a;
  return `${c.slice(0, 6)}…${c.slice(-4)}`;
};

/** The name the shell shows for a Safe: its name, or the short address while it has none. */
export const safeLabel = (s: { name: string | null | undefined; address: string }) => s.name || shortAddress(s.address);
