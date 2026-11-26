// The in-progress "Create a Safe" setup, kept so a reload can pick up where it stopped (r31 journey "Create an account").
// localStorage only: the Safe itself is saved on the server by the create call. This stores what the server cannot —
// the name and the payment hash already sent — so resuming never asks the user to pay twice.

export type CreateProgress = { address: string; name: string; chainIds: number[]; hashes: Record<number, string>; paymentIntents: Record<number, "unknown"> };

export const createProgressKey = (wallet: string, address: string) =>
  `la:create:${wallet.toLowerCase()}:${address.toLowerCase()}`;

export function loadCreateProgress(wallet: string, address: string): CreateProgress | null {
  try {
    const raw = localStorage.getItem(createProgressKey(wallet, address));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<CreateProgress>;
    if (typeof p.address !== "string" || !Array.isArray(p.chainIds)) return null;
    return { address: p.address, name: typeof p.name === "string" ? p.name : "", chainIds: p.chainIds.map(Number), hashes: p.hashes ?? {}, paymentIntents: p.paymentIntents ?? {} };
  } catch {
    return null; // storage blocked or a malformed entry
  }
}

export function saveCreateProgress(wallet: string, p: CreateProgress): void {
  try {
    localStorage.setItem(createProgressKey(wallet, p.address), JSON.stringify(p));
  } catch { /* storage blocked: the in-page state still resumes */ }
}

/** The hash of the deployment the user's wallet sent. Kept so a reload re-checks it instead of paying again. */
export function recordPaidHash(wallet: string, address: string, chainId: number, hash: string): void {
  const p = loadCreateProgress(wallet, address);
  if (p) saveCreateProgress(wallet, { ...p, hashes: { ...p.hashes, [chainId]: hash }, paymentIntents: { ...p.paymentIntents, [chainId]: "unknown" } });
}

/** Persist before opening the wallet prompt so reloads cannot create a second payment attempt. */
export function markPaymentUnknown(wallet: string, address: string, chainId: number): void {
  const p = loadCreateProgress(wallet, address);
  if (p) saveCreateProgress(wallet, { ...p, paymentIntents: { ...p.paymentIntents, [chainId]: "unknown" } });
}

/** Clear only after a definite rejection or a confirmed reverted receipt. */
export function clearPaymentAttempt(wallet: string, address: string, chainId: number): void {
  const p = loadCreateProgress(wallet, address);
  if (!p) return;
  const paymentIntents = { ...p.paymentIntents };
  const hashes = { ...p.hashes };
  delete paymentIntents[chainId];
  delete hashes[chainId];
  saveCreateProgress(wallet, { ...p, hashes, paymentIntents });
}

export function clearCreateProgress(wallet: string, address: string): void {
  try {
    localStorage.removeItem(createProgressKey(wallet, address));
  } catch { /* storage blocked */ }
}
