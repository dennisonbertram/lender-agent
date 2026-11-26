// What every block needs: live inputs per owned network plus the Safe's name and threshold.
// Figures are computed here from chain (G1) and carry their block number and read time.
import { shortAddress } from "@/lib/address";
import { MIN_LOAN } from "@/lib/loan-math";
import { SERVED_CHAIN_IDS } from "@/lib/safe-create";
import { borrowLimit, liveInputs, type BorrowLimit, type LiveInputs } from "@/server/market-inputs";
import type { SafeContext } from "@/server/request";
import { CHAIN_NAME, isChainId, NETWORK_OF, type Address, type ChainId } from "@/shared/types";
import type { Network } from "@/lib/types";

/** The parts of `SafeContext` the block builders use (so tests need no database). */
export type BlockCtx = Pick<SafeContext, "services" | "safe" | "networks" | "access"> & Partial<Pick<SafeContext, "db">>;

export type Stamp = { blockNumber: number; readAt: number };
export type SourceNote = { network: Network; chainId: ChainId; name: string };

export type BlockData = {
  name: string;
  address: string;
  threshold: number;
  /** One entry per network the wallet owns, in `ownedChainIds` order. */
  inputs: LiveInputs[];
  /** Live inputs of the first owned network (M1: Base). */
  primary: LiveInputs;
  /** The one borrow limit: the most the Safe can safely borrow now, and the lender and asset that give it. */
  limit: BorrowLimit;
  /** `limit.max`. */
  max: number;
} & Stamp;

export async function readBlockData(ctx: BlockCtx): Promise<BlockData> {
  const addr = ctx.safe.address as Address;
  const chains = ctx.access.ownedChainIds;
  const inputs = await Promise.all(chains.map((c) => liveInputs(ctx.services.reader, c, addr, ctx.services.lenders)));
  const threshold = (await ctx.services.reader.readSafeThreshold(chains[0], addr)) ?? 1;
  const name = ctx.safe.name || shortAddress(ctx.safe.address);
  const primary = inputs[0];
  const limit = borrowLimit(primary);
  return {
    name, address: ctx.safe.address, threshold, inputs, primary, limit, max: limit.max,
    blockNumber: Number(inputs.reduce((m, i) => (i.blockNumber > m ? i.blockNumber : m), 0n)),
    readAt: Math.max(...inputs.map((i) => i.readAt)),
  };
}

export const networkIdsOf = (d: BlockData) => d.inputs.map((i) => NETWORK_OF[i.chainId]);

/** One owned, served network's live read with its borrow ceiling; a failed read keeps the error for reporting. */
export type SourceScan = { chainId: ChainId; inputs: LiveInputs; max: number } | { chainId: ChainId; error: unknown };
export const sourceRead = (s: SourceScan): s is Extract<SourceScan, { inputs: LiveInputs }> => "inputs" in s;

/** The networks the wallet owns where loans are served, in served order (Base first). */
export const servedOwned = (ctx: Pick<SafeContext, "access">): ChainId[] => SERVED_CHAIN_IDS.filter(isChainId).filter((c) => ctx.access.ownedChainIds.includes(c));

/** Networks omitted from data because either ownership could not be confirmed or a live read failed. */
export function unreadSources(ctx: Pick<SafeContext, "access">, scans: SourceScan[]): SourceNote[] {
  const ids = new Set<ChainId>(ctx.access.unreadChainIds ?? []);
  for (const s of scans) if (!sourceRead(s)) ids.add(s.chainId);
  return [...ids].map((chainId) => ({ chainId, network: NETWORK_OF[chainId], name: CHAIN_NAME[chainId] }));
}

/** Every owned, served network (plus an explicitly requested chain) read once, in parallel. */
export async function scanSources(ctx: Pick<SafeContext, "services" | "safe" | "access">, requested?: ChainId): Promise<SourceScan[]> {
  const chainIds = [...new Set<ChainId>([...servedOwned(ctx), ...(requested !== undefined ? [requested] : [])])];
  const addr = ctx.safe.address as Address;
  return Promise.all(chainIds.map(async (chainId) => {
    try {
      const inputs = await liveInputs(ctx.services.reader, chainId, addr, ctx.services.lenders);
      return { chainId, inputs, max: borrowLimit(inputs).max };
    } catch (error) {
      return { chainId, error };
    }
  }));
}

/** The network a plan belongs on: the requested one — whose own read error reaches the caller, never a silent fallback — else the funded one in served order (Base first), else the first readable, so "empty" still names a real source. */
export function pickSource(scans: SourceScan[], requested?: ChainId): Extract<SourceScan, { inputs: LiveInputs }> {
  const ok = scans.filter(sourceRead);
  if (requested !== undefined) {
    const found = ok.find((s) => s.chainId === requested);
    if (!found) throw (scans.find((s) => s.chainId === requested) as { error: unknown }).error;
    return found;
  }
  if (!ok.length) throw (scans[0] as { error: unknown }).error;
  return ok.find((s) => s.max >= MIN_LOAN) ?? ok[0];
}
