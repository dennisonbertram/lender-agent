// Reading stored proposals for a signed-in owner (BP-28, G4): visible only to an owner of the Safe
// on the proposal's network.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { proposals } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import { requireNetwork } from "@/server/auth/access";
import type { SafeContext } from "@/server/request";
import type { Address, ChainId } from "@/shared/types";
import { refreshProposal } from "./follow";
import { checkStale } from "./stale";
import { OPEN_STAGES, proposalView, type ChainFacts, type ProposalRow, type ProposalView } from "./view";

const DEFAULT_THRESHOLD = 2;

/** Live owners and nonce for an open or stale proposal, plus our own earlier-nonce proposals it waits behind. A failed nonce read stays unknown. */
async function chainFactsOf(ctx: SafeContext, row: ProposalRow, cache: Map<string, Promise<Pick<ChainFacts, "owners" | "nonce">>>): Promise<ChainFacts | undefined> {
  if (row.stage !== "queued" && row.stage !== "stale") return undefined;
  const chainId = row.chainId as ChainId;
  const safe = ctx.safe.address as Address;
  if (!cache.has(String(chainId))) {
    cache.set(String(chainId), Promise.all([
      ctx.services.reader.readSafeOwners(chainId, safe).catch(() => null),
      ctx.services.reader.readSafeNonce(chainId, safe).catch(() => null),
    ]).then(([owners, nonce]) => ({ owners, nonce })));
  }
  const facts = await cache.get(String(chainId))!;
  let blockedBy: ChainFacts["blockedBy"];
  if (facts.nonce !== null && row.nonce !== null && facts.nonce < row.nonce) {
    const earlier = await ctx.db.select({ id: proposals.id, nonce: proposals.nonce, title: proposals.title }).from(proposals)
      .where(and(eq(proposals.safeId, ctx.safe.id), eq(proposals.chainId, chainId), inArray(proposals.stage, ["queued", "sending"])));
    blockedBy = earlier.filter((e) => e.nonce !== null && e.nonce >= facts.nonce! && e.nonce < row.nonce!).sort((a, b) => Number(a.nonce! - b.nonce!))
      .map((e) => ({ id: e.id, nonce: e.nonce!.toString(), title: e.title }));
  }
  return { ...facts, blockedBy };
}

const toView = async (ctx: SafeContext, row: ProposalRow, cache = new Map<string, Promise<Pick<ChainFacts, "owners" | "nonce">>>()): Promise<ProposalView> =>
  proposalView(row, { viewer: ctx.wallet, threshold: row.threshold ?? DEFAULT_THRESHOLD, safeAddress: ctx.safe.address as Address, chain: await chainFactsOf(ctx, row, cache) });

/** Last on-demand refresh per proposal: the card moves within one poll even without the worker (BP-15). */
const REFRESH_AFTER_MS = 10_000;
const lastRefresh = new Map<string, number>();

/** The view of one stored row (used by the owner routes after they change it). */
export const viewOfRow = (ctx: SafeContext, row: ProposalRow) => toView(ctx, row);

const HASH = /^0x[0-9a-fA-F]{64}$/;
const select = (ctx: SafeContext, id: string) => ctx.db.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.safeId, ctx.safe.id))).limit(1);

/** The app id of a proposal of this Safe, given either that id or its 0x safeTxHash (Safe's own links use the hash). Unknown stays as given, so the 404 is unchanged. */
async function resolveId(ctx: SafeContext, id: string): Promise<string> {
  if (!HASH.test(id)) return id;
  const rows = await ctx.db.select({ id: proposals.id }).from(proposals)
    .where(and(eq(proposals.safeId, ctx.safe.id), sql`lower(${proposals.safeTxHash}) = ${id.toLowerCase()}`, sql`not ${proposals.deletedFromQueue}`))
    .orderBy(desc(proposals.createdAt)).limit(1);
  return rows[0]?.id ?? id;
}

export async function getProposal(ctx: SafeContext, idOrHash: string): Promise<ProposalView> {
  const id = await resolveId(ctx, idOrHash);
  let [row] = await select(ctx, id);
  if (!row) throw new HttpError(404, "Proposal not found");
  requireNetwork(ctx.access, row.chainId as ChainId);
  // Only after the access check: follow it in the service (BP-15), then recheck it against live
  // data before it renders (BP-16, "staleness is rechecked on each tick and before render").
  if ((row.stage === "queued" || row.stage === "draft") && Date.now() - (lastRefresh.get(id) ?? 0) > REFRESH_AFTER_MS) {
    lastRefresh.set(id, Date.now());
    try {
      if (row.stage === "queued") await refreshProposal(ctx.db, ctx.services, id);
      await checkStale(ctx.db, ctx.services, id);
      [row] = await select(ctx, id);
    } catch {
      // the stored state is still right; the worker retries
    }
  }
  return await toView(ctx, row);
}

export async function listProposals(ctx: SafeContext, opts: { open?: boolean } = {}): Promise<ProposalView[]> {
  const owned = ctx.access.ownedChainIds;
  const rows = await ctx.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.safeId, ctx.safe.id), inArray(proposals.chainId, owned), opts.open ? inArray(proposals.stage, OPEN_STAGES) : undefined))
    .orderBy(desc(proposals.createdAt));
  const cache = new Map<string, Promise<Pick<ChainFacts, "owners" | "nonce">>>();
  return Promise.all(rows.map((r) => toView(ctx, r, cache)));
}
