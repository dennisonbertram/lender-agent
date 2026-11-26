// What the viewer may see of a Safe's activity (BP-27, G4), and the signature writer.
import { neutralText, timeLabel } from "@/lib/activity-copy";
import { shortAddress } from "@/lib/address";
import { eq, inArray } from "drizzle-orm";
import { proposals, safes } from "@/server/db/schema";
import { listActivity, recordActivity, type ActivityRow } from "@/server/activity";
import type { Db } from "@/server/db/client";
import type { SafeContext } from "@/server/request";
import { isChainId, type ActivityKind, type Address, type ChainId } from "@/shared/types";

export type ActivityView = {
  id: number;
  /** Epoch milliseconds. */
  at: number;
  /** "Agent", "Agent (reserve)", "You", or "Co-signer 0x1234…abcd". */
  actor: string;
  kind: ActivityKind;
  text: string;
  detail: string | null;
  timeLabel: string;
  /** What the row is about, from data the row already holds. Null when unknown. */
  chainId: ChainId | null;
  proposalId: string | null;
  /** A Safe transaction hash (from a signature row's key), for the Safe app link. */
  safeTxHash: string | null;
  /** An on-chain transaction hash named in the row's detail. */
  txHash: string | null;
  /** The chain `txHash` belongs to; null when not known, and then no link is made. */
  txChainId?: ChainId | null;
  /** Network mark to show for the row; null when a destination receipt chain is unknown. */
  displayChainId: ChainId | null;
  /** Address of the Safe the linked proposal belongs to (not this Safe for a Reserve setup). Null without a proposal. */
  proposalSafe?: string | null;
};

type Viewer = { wallet: string; ownedChainIds: ChainId[]; chat: boolean };

/** Rows with a chain only on networks the viewer owns; rows without a chain only with chat access. */
export function visibleTo(rows: ActivityRow[], viewer: Viewer): ActivityRow[] {
  return rows.filter((r) => (r.chainId == null ? viewer.chat : viewer.ownedChainIds.includes(r.chainId as ChainId)));
}

/** A signature's actor is computed per viewer from the stored confirmation owner. */
export function actorFor(row: Pick<ActivityRow, "actor" | "actorAddress">, wallet: string): string {
  if (row.actor !== "You" && row.actor !== "Co-signer") return row.actor;
  if (!row.actorAddress) return row.actor;
  return row.actorAddress.toLowerCase() === wallet.toLowerCase() ? "You" : `Co-signer ${shortAddress(row.actorAddress)}`;
}

/** Signature rows key their dedupe on `sig:<chain>:<safeTxHash>:<owner>`. */
function safeTxHashOf(eventKey: string | null): string | null {
  const m = eventKey?.match(/^sig:\d+:(0x[0-9a-fA-F]{64}):/);
  return m ? m[1] : null;
}

/** A linked proposal's hashes, used when the row itself holds none. */
export type ProposalHashes = Map<string, { txHash: string | null; safeTxHash: string | null; safeAddress?: string | null }>;

export function toView(rows: ActivityRow[], viewer: Viewer, now: number = Date.now(), linked: ProposalHashes = new Map()): ActivityView[] {
  return visibleTo(rows, viewer).map((r) => {
    const at = r.at.getTime();
    const actor = actorFor(r, viewer.wallet);
    const p = r.proposalId ? linked.get(r.proposalId) : undefined;
    const rowChain = (r.chainId ?? null) as ChainId | null;
    // A hash named in the detail may be on another chain ("Destination transaction on X (chain N): 0x…").
    // Older rows named the destination hash with no chain, so the row's chain would be a guess: no link.
    const named = r.txHash || p?.txHash ? null : r.detail?.match(/(?:\(chain (\d+)\)[^0x]*)?(0x[0-9a-fA-F]{64})\b/);
    const namedChain = named?.[1] ? Number(named[1]) : null;
    const unsure = !!named && !named[1] && /^Destination transaction /.test(r.detail ?? "");
    const txHash = r.txHash ?? p?.txHash ?? (unsure ? null : named?.[2]) ?? null;
    const txChainId = txHash ? (namedChain !== null ? (isChainId(namedChain) ? namedChain : null) : rowChain) : null;
    return {
      id: r.id, at, actor, kind: r.kind as ActivityKind, text: actor === "You" ? r.text : neutralText(r.text), detail: r.detail, timeLabel: timeLabel({ at }, now),
      chainId: (r.chainId ?? null) as ChainId | null,
      proposalId: r.proposalId ?? null,
      safeTxHash: r.safeTxHash ?? p?.safeTxHash ?? safeTxHashOf(r.eventKey),
      txHash,
      txChainId,
      displayChainId: unsure ? null : txHash ? txChainId : rowChain,
      proposalSafe: p?.safeAddress ?? null,
    };
  });
}

export async function activityFor(ctx: Pick<SafeContext, "db" | "safe" | "wallet" | "access">, opts: { order?: "newest" | "oldest"; now?: number } = {}): Promise<ActivityView[]> {
  const rows = await listActivity(ctx.db, ctx.safe.id, opts.order ?? "newest");
  const ids = [...new Set(rows.map((r) => r.proposalId).filter((x): x is string => !!x))];
  const linked: ProposalHashes = new Map();
  if (ids.length) {
    const ps = await ctx.db.select({ id: proposals.id, txHash: proposals.executedTxHash, safeTxHash: proposals.safeTxHash, safeAddress: safes.address }).from(proposals)
      .innerJoin(safes, eq(safes.id, proposals.safeId)).where(inArray(proposals.id, ids));
    for (const p of ps) linked.set(p.id, { txHash: p.txHash, safeTxHash: p.safeTxHash, safeAddress: p.safeAddress });
  }
  return toView(rows, { wallet: ctx.wallet, ownedChainIds: ctx.access.ownedChainIds, chat: ctx.access.chat }, opts.now, linked);
}

export type SignatureInput = {
  safeId: number;
  chainId: ChainId;
  proposalId: string;
  safeTxHash: string;
  /** From the Transaction Service: the confirmation's owner, never invented. */
  confirmations: { owner: Address; submittedAt: Date | string }[];
  title: string;
  /** Optional detail line, e.g. `proposalDetail(steps)`. */
  detail?: string | null;
};

/** One "signed" row per confirmation owner; a repeated poll writes nothing new. Returns rows written. */
export async function recordSignatures(db: Db, input: SignatureInput): Promise<number> {
  let written = 0;
  for (const c of input.confirmations) {
    const owner = c.owner.toLowerCase() as Address;
    const row = await recordActivity(db, {
      safeId: input.safeId,
      chainId: input.chainId,
      actor: "Co-signer",
      actorAddress: owner,
      kind: "signed",
      text: `Signed: ${input.title}`,
      detail: input.detail ?? null,
      proposalId: input.proposalId,
      eventKey: `sig:${input.chainId}:${input.safeTxHash.toLowerCase()}:${owner}`,
      at: new Date(c.submittedAt),
    });
    if (row) written++;
  }
  return written;
}
