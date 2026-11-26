// Safe 1.4.1 revert codes, so a failed simulation reads as a sentence.
const GS: Record<string, string> = {
  GS000: "The Safe is not set up correctly.",
  GS001: "The number of signatures needed is not met.",
  GS010: "Not enough gas to run it.",
  GS011: "Not enough gas to pay the refund.",
  GS012: "The refund payment failed.",
  GS013: "The transaction itself failed when it ran (for example a balance or approval is missing), so nothing was changed.",
  GS020: "The signature data is too short.",
  GS021: "The signature data is malformed.",
  GS022: "The signature data is malformed.",
  GS023: "The signature data is malformed.",
  GS024: "A contract signature was not valid.",
  GS025: "A signature was not approved: an owner has not signed, or approved the hash.",
  GS026: "A signature is not from a current owner, or the signatures are not in owner order.",
};

/** A readable reason from a viem error (or any message) holding a `GSxxx` code; raw text otherwise. */
export function decodeSafeRevert(err: unknown): string {
  const text = err instanceof Error ? [(err as { shortMessage?: string }).shortMessage, (err as { details?: string }).details, err.message].filter(Boolean).join(" ") : String(err);
  const code = text.match(/GS\d{3}/)?.[0];
  if (code && GS[code]) return `${GS[code]} (${code})`;
  const reason = text.match(/reverted with the following reason:\s*([^\n]+)/)?.[1];
  return reason ?? ((err as { shortMessage?: string }).shortMessage ?? text).split("\n")[0].slice(0, 200);
}
