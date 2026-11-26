import { fmt, usd, networkName } from "@/lib/format";
import type { UIBlock } from "@/lib/blocks";
import { MIN_LOAN } from "@/lib/loan-math";
import type { OpenSpec, Spec } from "@/lib/proposals";
import type { Asset, Network, NetworkConfig } from "@/lib/types";

/** The one plan being edited per Safe, shared by Get cash and the chat plan card. */
export type PlanDraft = {
  text: string;
  hfIdx: 0 | 1 | 2;
  months: 3 | 12 | 24;
  asset?: Asset;
  network?: Network;
  venueId?: string;
  /** Collateral the offer explorer chose. */
  collateral?: number;
  /** The plan message that is live. Earlier plan messages are frozen. */
  msgId?: string;
  /** A sizing answer: never sendable (the server refuses it). */
  hypothetical?: boolean;
  /** The proposal sent from this draft: once set, the plan is a receipt. */
  sentId?: string;
};

export const emptyDraft: PlanDraft = { text: "", hfIdx: 1, months: 12 };

/** `max` is the most the Safe can safely borrow: a plan asked for more starts at the maximum. */
export const seedDraft = (b: Extract<UIBlock, { kind: "plan" }>, msgId: string, max = Infinity): PlanDraft => ({
  text: usd(Math.min(b.cash, max)), hfIdx: b.hfIdx ?? 1, months: b.months ?? 12, asset: b.asset, network: b.network, venueId: b.venueId, msgId,
});

export const isLivePlan = (d: PlanDraft | undefined, msgId: string) => d?.msgId === msgId;

/** What was sent, from the proposal's own spec so it never recomputes. */
export function receiptLine(spec: Extract<Spec, { kind: "open" | "move" }>, venueName: string, networks: readonly NetworkConfig[]): string {
  if (spec.kind === "move") {
    const { move, then } = spec;
    return `Sent to your Safe: move ${fmt(move.amount, 2)} ${move.asset} to ${networkName(move.to, networks)}, then borrow ${usd(then.borrow)} from ${venueName}.`;
  }
  const o: OpenSpec = spec;
  return `Sent to your Safe: borrow ${usd(o.borrow)} from ${venueName}, locking ${fmt(o.amount, 2)} ${o.asset}.`;
}

/** Shown in the plan card while a request outside the limits is still at the limit (the maximum, or the smallest loan); the field is the only amount once the user edits it. */
export const cappedNote = (requested: number, max: number, current: number | null, min = MIN_LOAN) =>
  requested > max && current === max ? `Capped at ${usd(max)}, the most this Safe can borrow.`
  : requested < min && current === min ? `The smallest loan is ${usd(min)}, so this plan starts there.` : "";
