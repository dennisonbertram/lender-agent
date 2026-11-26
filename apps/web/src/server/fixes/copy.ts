// Wording for the urgent fix card (BP-23, D-10, R-15). Never says "cancelled" before a transaction with
// that nonce has executed: signing the fix does not cancel the other, deleting does not revoke signatures.
export const D10_NOTE =
  "If another transaction is already waiting in your Safe, this fix takes the same place in the queue, and both stay pending. " +
  "Whichever is executed first goes through; the other can then no longer run and must be proposed again if still wanted. " +
  "Signing this fix does not cancel the other, and deleting a proposal does not take back signatures already given.";

/** The note on an urgent fix card: it is proposed at the Safe's current nonce, next to whatever is queued there. */
export const urgentNote = (): string => D10_NOTE;

/** The draft's one sentence about consent (r30): a pick is not a send. */
export const stillNeedsSignature = (needs: number): string =>
  `Drafted, not yet sent to Safe. It still needs ${needs} signature${needs === 1 ? "" : "s"} in Safe.`;
