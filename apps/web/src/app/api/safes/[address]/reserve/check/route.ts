import { requireNetwork } from "@/server/auth/access";
import { toResponse } from "@/server/http";
import { checkReserve } from "@/server/reserve";
import { safeContext } from "@/server/request";
import { isChainId, type ChainId } from "@/shared/types";

export const dynamic = "force-dynamic";

/** What the page shows before signing: the Reserve Safe's USDC, the field errors and the can/cannot lists for the typed values. */
export async function POST(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const ctx = await safeContext(req, address);
    const b = (await req.json().catch(() => null)) as { chainId?: number; reserveSafe?: string; dailyLimitUsd?: number; triggerHf?: number } | null;
    if (!b || !isChainId(Number(b.chainId)) || typeof b.reserveSafe !== "string") return Response.json({ error: "Bad request" }, { status: 400 });
    requireNetwork(ctx.access, Number(b.chainId) as ChainId);
    const r = await checkReserve(ctx, { chainId: Number(b.chainId) as 8453, reserveSafe: b.reserveSafe, dailyLimitUsd: Number(b.dailyLimitUsd), triggerHf: Number(b.triggerHf) });
    return Response.json(r);
  } catch (err) {
    return toResponse(err);
  }
}
