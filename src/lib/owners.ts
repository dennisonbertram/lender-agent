import { validateAddress } from "@/lib/address";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** One error (or null) per owner. Index 0 is the user and is never an error. Case and spaces are ignored. */
export function ownerErrors(owners: string[]): (string | null)[] {
  return owners.map((o, i) => {
    if (i === 0) return null;
    const bad = validateAddress(o);
    if (bad) return bad;
    if (same(o, owners[0])) return "This is your address. Add someone else.";
    return owners.slice(1, i).some((x) => same(x, o)) ? "This owner is already listed." : null;
  });
}

/** One co-signer defaults to 1 of 2 so a lost key does not lock the Safe. Two or more default to 2. */
export const defaultApprovals = (n: number) => (n >= 3 ? 2 : 1);

export function approvalsLabel(k: number, n: number): string {
  if (n === 2) return k === 1 ? "Either of you (1 of 2)" : "Both of you (2 of 2)";
  if (k === 1) return `Any one (1 of ${n})`;
  return k === n ? `All ${n} (${n} of ${n})` : `${k} of ${n}`;
}

export function approvalsHelp(k: number, n: number): string {
  if (k === 1) return "Any one owner can approve alone. If one key is stolen, the thief can move the money.";
  if (k < n) return `${k} of ${n} must approve. One stolen key cannot move the money, and one lost key does not lock you out.`;
  return n === 2
    ? "Both of you must approve. If one of you loses a key, nobody can move the money."
    : `All ${n} owners must approve. If one owner loses a key, nobody can move the money.`;
}

export function approvalsSummary(k: number, n: number): string {
  if (n === 1) return "Only you approve transactions.";
  if (n === 2) return k === 1 ? "Either of you can approve a transaction alone." : "Both of you must approve each transaction.";
  if (k === 1) return `Any one of the ${n} owners can approve a transaction alone.`;
  return k === n ? `All ${n} owners must approve each transaction.` : `${k} of the ${n} owners must approve each transaction.`;
}
