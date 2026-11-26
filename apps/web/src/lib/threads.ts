import type { Loan, Network, Safe } from "@/lib/types";
import { compute, type Proposal, type ProposalInputs, type Spec } from "@/lib/proposals";

export const threadOf = <M extends { safeId: string }>(msgs: M[], safeId: string) => msgs.filter((m) => m.safeId === safeId);

/** The Safe a proposal belongs to: its own safeId for "open" and "move", else its loan's Safe. */
export function specSafeId(spec: Spec, loans: Loan[], fallback: string): string {
  if (spec.kind === "open" || spec.kind === "move") return spec.safeId;
  return loans.find((l) => l.id === spec.loanId)?.safeId ?? fallback;
}

/** The network a proposal is signed on: its own for "open", the source network for "move", else its loan's. */
export function specNetwork(spec: Spec, loans: Loan[]): Network | undefined {
  if (spec.kind === "open") return spec.network;
  if (spec.kind === "move") return spec.move.from;
  return loans.find((l) => l.id === spec.loanId)?.network;
}

/** The loan the chat acts on: the one on screen, or the Safe's only loan. Never another Safe's loan. */
export function loanInContext(loans: Loan[], safeId: string, ctxId: string): Loan | undefined {
  const mine = loans.filter((l) => l.safeId === safeId);
  return mine.find((l) => l.id === ctxId) ?? (mine.length === 1 ? mine[0] : undefined);
}

/** True when the proposal no longer matches the loans or balances it was drafted against. */
export function isStale(p: Proposal, loans: Loan[], balances: Safe["balances"], inputs: ProposalInputs): boolean {
  const s = p.spec;
  if (s.kind === "move" ? (balances[s.move.from]?.[s.move.asset] ?? 0) < s.move.amount : s.kind === "open" ? (balances[s.network]?.[s.asset] ?? 0) < s.amount : !loans.some((l) => l.id === s.loanId)) return true;
  const c = compute(s, loans, inputs);
  return c.title !== p.title || JSON.stringify(c.steps) !== JSON.stringify(p.steps);
}
