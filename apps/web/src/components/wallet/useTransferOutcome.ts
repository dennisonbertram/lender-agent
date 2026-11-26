"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";

export type Outcome = "pending" | "success" | "reverted" | "cancelled" | "replaced" | "stalled";

/** How often the receipt wait is started again after it ends without an answer (viem's own wait gives up after 180 s). */
export const RECEIPT_WAIT_ATTEMPTS = 3;

export const REPLACED_TEXT = "This transfer was replaced by a different transaction in your wallet. Check your wallet.";
export const stalledText = (explorerName: string) => `Still waiting for the network. Check the transfer on ${explorerName}.`;

/** Follows a sent transaction: reverted, cancelled, replaced by a different transaction, or sped up (then the new hash is followed).
 *  The inline notice and the toast both use this, so they never disagree. */
export function useTransferOutcome(hash: `0x${string}` | undefined, chainId: number, onHash: (h: `0x${string}`) => void): Outcome {
  const client = usePublicClient({ chainId });
  const [outcome, setOutcome] = useState<Outcome>("pending");
  useEffect(() => {
    if (!hash || !client) return;
    let live = true;
    setOutcome("pending");
    const sticky = (o: Outcome) => o === "cancelled" || o === "replaced";
    void (async () => {
      for (let attempt = 0; attempt < RECEIPT_WAIT_ATTEMPTS && live; attempt++) {
        try {
          const rc = await client.waitForTransactionReceipt({
            hash,
            onReplaced: (r) => {
              if (!live) return;
              // Only a speed-up ("repriced") keeps the same transfer; a different to/value/data is not our transfer.
              if (r.reason === "cancelled") setOutcome("cancelled");
              else if (r.reason === "replaced") setOutcome("replaced");
              else onHash(r.transaction.hash);
            },
          });
          if (live) setOutcome((o) => (sticky(o) ? o : rc.status === "success" ? "success" : "reverted"));
          return;
        } catch {
          // timed out or the node hiccuped: wait again, then say so
        }
      }
      if (live) setOutcome((o) => (o === "pending" ? "stalled" : o));
    })();
    return () => { live = false; };
  }, [hash, client, onHash]);
  return outcome;
}
