import { requireNetwork } from "@/server/auth/access";
import type { ChainId } from "@/shared/types";
import { toResponse } from "@/server/http";
import { getMoveDeps } from "@/server/moves/deps";
import { expireMove, getMove, moveView } from "@/server/moves/service";
import { safeContext } from "@/server/request";
import { isMoveStale } from "@/server/moves/expiry";

export const dynamic = "force-dynamic";

/** One move card. An open move whose quote ran out is expired and re-drafted before it renders (D-13). */
export async function GET(req: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  try {
    const { address, id } = await params;
    const ctx = await safeContext(req, address);
    const deps = getMoveDeps(ctx.services);
    let row = await getMove(ctx.db, ctx.safe.id, id);
    requireNetwork(ctx.access, row.fromChain as ChainId);
    if (["quoted", "queued"].includes(row.status) && isMoveStale(row.expiresAt, deps.now())) {
      await expireMove(ctx.db, ctx.services, deps, row, deps.now());
      row = await getMove(ctx.db, ctx.safe.id, id);
    }
    return Response.json({ move: moveView(row, deps.now()) });
  } catch (err) {
    return toResponse(err);
  }
}
