// Facts the app tells the model each turn. Plain statements, no tool call needed; the model still never writes the figures.
import type { Loan } from "@/lib/types";

/** The Safe's open loans as a note for the system prompt, so the model knows they exist (rule 8). Empty when there are none. */
export function loansNote(loans: readonly (Pick<Loan, "venue" | "network" | "debt"> & { collAsset: string })[], unknown = false, unread: readonly string[] = []): string {
  if (unknown && !loans.length) return "App note: the app could not read this Safe's loans right now, so whether one is open is unknown. Do not say a loan is open or not; use showStatus.";
  if (!loans.length && unread.length) return `App note: couldn't read ${unread.join(" and ")} just now, so whether a loan is open there is unknown. Do not say there is no open loan or that the loans are healthy; use showStatus.`;
  if (!loans.length) return "App-verified: this Safe has no open loan.";
  const list = loans.map((l) => `a ${l.venue} loan on ${l.network} against ${l.collAsset}`).join("; ");
  return `App-verified: this Safe has ${loans.length === 1 ? "an open loan" : `${loans.length} open loans`}: ${list}. These loans are real. Never say a loan is not open or was not funded. Use showStatus for its figures.${unread.length ? ` Couldn't read ${unread.join(" and ")} just now: do not say these are the only loans or that all loans are healthy.` : ""}`;
}
