import { requireNetwork } from "@/server/auth/access";
import { getAddress } from "viem";
import { appendServerMessage } from "@/server/agent/persist";
import { toResponse, HttpError } from "@/server/http";
import { getMoveDeps } from "@/server/moves/deps";
import { chainOf, MOVE_NETWORKS } from "@/server/moves/networks";
import { planCrossNetwork } from "@/server/moves/plan";
import { draftMove, moveView } from "@/server/moves/service";
import { safeContext } from "@/server/request";
import type { Address, ChainId } from "@/shared/types";
import { HF_LEVELS } from "@/server/quote";

export const dynamic = "force-dynamic";
const ASSETS = ["ETH", "wstETH", "WBTC"] as const;
const NETWORKS = MOVE_NETWORKS.map((n) => n.id);

/** Plan a cross-network loan with a real quote and draft its move (BP-36). Body: parameters only, `{ cash, asset, network, hfIdx? }`. */
export async function POST(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const b = await req.json().catch(() => ({}));
    if (typeof b.cash !== "number" || !(b.cash > 0) || !ASSETS.includes(b.asset) || !NETWORKS.includes(b.network)) throw new HttpError(400, "Say how much cash, against which asset, held on which network.");
    requireNetwork(ctx.access, chainOf(b.network) as ChainId);
    const deps = getMoveDeps(ctx.services);
    const safeAddress = getAddress(ctx.safe.address) as Address;
    const world = await deps.world?.({ db: ctx.db, services: ctx.services, safeId: ctx.safe.id, safeAddress }, { network: b.network });
    const plan = world && await planCrossNetwork({ aggregator: deps.aggregator, networks: MOVE_NETWORKS, chainOf }, { ...world, safeAddress, need: { cash: b.cash, months: 12, targetHf: HF_LEVELS[b.hfIdx === 0 || b.hfIdx === 2 ? b.hfIdx : 1], asset: b.asset, network: b.network } });
    if (!plan?.quote) throw new HttpError(409, "I can't offer a move for this: no lender on another of your networks can do it, or the bridge has no route.");
    const row = await draftMove(ctx.db, { safeId: ctx.safe.id, safeAddress, plan, now: deps.now(), wallet: ctx.wallet, destination: deps.destination });
    await appendServerMessage(ctx.db, ctx.safe.id, { id: `move-draft-${row.id}`, parts: [{ type: "data-move", data: { moveId: row.id } }] });
    return Response.json({ move: moveView(row, deps.now()) });
  } catch (err) {
    return toResponse(err);
  }
}
