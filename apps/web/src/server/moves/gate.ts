// The move check runs before delivery and again at queued owner actions (architecture 2 rule 4, BP-37).
// The current validator checks the stored quote and transaction. The deployed destination Safe must be
// verifiable on-chain, and its live owners must include the proposal's creator.
import { eq } from "drizzle-orm";
import type { Asset } from "@/lib/types";
import type { Db } from "@/server/db/client";
import { moves, proposals } from "@/server/db/schema";
import { isAddressEqual } from "viem";
import type { Address, SafeTx } from "@/shared/types";
import type { DestinationChain } from "./arrival";
import { isMoveStale } from "./expiry";
import { buildMoveBatch, checkMoveBatch, checkMoveQuote } from "./invariants";
import { chainName, networkOfChain } from "./networks";
import { liveDestinationOwners, ownsSafe } from "./ownership";
import { moveToken, toRaw } from "./tokens";
import { quoteFromJson, type AggregatorQuote, type QuoteParams } from "./types";

type ProposalRow = typeof proposals.$inferSelect;
export type MoveGate = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): MoveGate => ({ ok: false, reason });

export type MoveQuoteRequest = QuoteParams & { fromDecimals: number; toDecimals: number };

/** Build the original quote request from the persisted user request and current Safe identity. */
export function moveRequestForStoredSpec(p: {
  spec: unknown;
  rowSafeId: number;
  moveSafeId: number;
  chainId: number;
  fromChain: number;
  toChain: number;
  asset: string;
  safe: Address;
}): MoveQuoteRequest | null {
  try {
    const spec = p.spec as { kind?: string; safeId?: unknown; move?: { from?: unknown; to?: unknown; asset?: unknown; amount?: unknown } };
    const move = spec?.move;
    if (spec?.kind !== "move" || !move || p.rowSafeId !== p.moveSafeId || p.chainId !== p.fromChain || p.asset !== move.asset) return null;
    if (typeof spec.safeId !== "string" || !isAddressEqual(spec.safeId as Address, p.safe)) return null;
    if (typeof move.from !== "string" || typeof move.to !== "string" || networkOfChain(p.fromChain) !== move.from || networkOfChain(p.toChain) !== move.to) return null;
    if (typeof move.asset !== "string" || typeof move.amount !== "number" || !Number.isFinite(move.amount) || move.amount <= 0) return null;
    const asset = move.asset as Asset;
    const from = moveToken(asset, p.fromChain);
    const to = moveToken(asset, p.toChain);
    if (!from || !to) return null;
    const fromAmount = toRaw(move.amount, from.decimals);
    if (fromAmount <= 0n) return null;
    return {
      fromChain: p.fromChain,
      toChain: p.toChain,
      fromToken: from.address,
      toToken: to.address,
      fromAmount,
      address: p.safe,
      fromDecimals: from.decimals,
      toDecimals: to.decimals,
    };
  } catch {
    return null;
  }
}

/** The quote metadata must still describe that original request, including units and both Safe roles. */
export function quoteAnswersMoveRequest(q: AggregatorQuote, p: MoveQuoteRequest): boolean {
  return q.fromChain === p.fromChain && q.toChain === p.toChain
    && q.fromDecimals === p.fromDecimals && q.toDecimals === p.toDecimals
    && q.fromAmount === p.fromAmount
    && isAddressEqual(q.fromToken, p.fromToken) && isAddressEqual(q.toToken, p.toToken)
    && isAddressEqual(q.fromAddress, p.address) && isAddressEqual(q.toAddress, p.address)
    && isAddressEqual(q.tx.from, p.address) && q.tx.chainId === p.fromChain;
}

/**
 * Revalidate the stored move and destination Safe without changing either record. `safe` is the source Safe.
 * Before submission, the delivery caller settles a failed check as `not_sent`. Owner actions refuse a
 * failed check with HTTP 409 and keep the queued proposal and its reserved nonce for review.
 */
export async function gateMoveDelivery(db: Db, deps: { destination: DestinationChain; now(): Date }, row: ProposalRow, safe: Address): Promise<MoveGate> {
  const [mv] = await db.select().from(moves).where(eq(moves.proposalId, row.id)).limit(1);
  if (!mv) return fail("The move this proposal carries is missing.");
  // An expired quote can never be signed or proposed: the linked move's own expiry is the measure.
  if (isMoveStale(mv.expiresAt, deps.now())) return fail("The move's quote ran out.");
  let quote;
  try {
    quote = quoteFromJson(mv.quote);
  } catch {
    return fail("The stored quote cannot be read.");
  }
  const request = moveRequestForStoredSpec({
    spec: mv.spec, rowSafeId: row.safeId, moveSafeId: mv.safeId, chainId: row.chainId,
    fromChain: mv.fromChain, toChain: mv.toChain, asset: mv.asset, safe,
  });
  if (!request || !quoteAnswersMoveRequest(quote, request)) return fail("The stored quote does not match the requested move.");
  const bounds = { safe, fromChain: mv.fromChain, toChain: mv.toChain };
  // The stored quote is re-checked under the validator running NOW: a quote written before a facet was
  // tightened is refused rather than delivered.
  const checked = checkMoveQuote(quote, bounds);
  if (!checked.ok) return fail(`Test run failed: ${checked.reason}.`);
  const tx = row.tx as SafeTx | null;
  if (!tx) return fail("The stored transaction is missing.");
  // The transaction that would be signed must still be exactly what the (re-checked) quote produces.
  const batch = checkMoveBatch(quote, { ...bounds, calls: buildMoveBatch(quote), outer: tx });
  if (!batch.ok) return fail(`Test run failed: ${batch.reason}.`);
  // The destination must be a deployed Safe the proposal's creator owns: identity-verified live owners only —
  // a stored setup's owners are draft-time data, never a delivery pass, and unverifiable is never a pass.
  const owners = await liveDestinationOwners(deps.destination, mv.toChain, safe);
  if (!ownsSafe(owners, row.createdBy ?? "")) {
    return fail(owners === null ? `I could not confirm who owns this Safe on ${chainName(mv.toChain)}.` : `This Safe on ${chainName(mv.toChain)} is owned by a different wallet.`);
  }
  return { ok: true };
}
