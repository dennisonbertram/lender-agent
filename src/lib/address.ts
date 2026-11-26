/** Returns an error message, or null when `address` is a well-formed 0x address that is not already in `existing`. */
export function validateAddress(address: string, existing: string[] = []): string | null {
  const a = address.trim();
  if (!a) return "Enter an address.";
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return "This is not a valid address. Addresses start with 0x and are 42 characters long.";
  if (existing.some((e) => e.toLowerCase() === a.toLowerCase())) return "You already added this Safe.";
  return null;
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Deterministic fake address for the "create a Safe" demo. */
export function sampleAddress(seed: number): string {
  let x = (seed + 1) * 2654435761;
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += "0123456789abcdef"[(x >>> 16) & 15];
  }
  return out;
}
