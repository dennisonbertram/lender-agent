import { requireNetwork } from "@/server/auth/access";
import { toResponse } from "@/server/http";
import { linkReserve } from "@/server/reserve";
import { reserveViewOf } from "@/server/reserve/view";
import { safeContext } from "@/server/request";
import { isChainId } from "@/shared/types";

export const dynamic = "force-dynamic";

const chainOf = (req: Request) => {
  const c = Number(new URL(req.url).searchParams.get("chainId") ?? 8453);
  return isChainId(c) ? c : 8453;
};

/** The Reserve's status and policy for this Safe (BP-39, BP-40), read from chain and cached briefly. */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const ctx = await safeContext(req, address);
    requireNetwork(ctx.access, chainOf(req));
    return Response.json(await reserveViewOf(ctx, chainOf(req)));
  } catch (err) {
    return toResponse(err);
  }
}

/** Link a Reserve Safe: validates the limits, then sends the setup to the Reserve Safe's queue for the owners to sign. */
export async function POST(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const ctx = await safeContext(req, address);
    const b = (await req.json().catch(() => null)) as { chainId?: number; reserveSafe?: string; dailyLimitUsd?: number; triggerHf?: number } | null;
    if (!b || !isChainId(Number(b.chainId)) || typeof b.reserveSafe !== "string" || typeof b.dailyLimitUsd !== "number" || typeof b.triggerHf !== "number") return Response.json({ error: "Bad request" }, { status: 400 });
    const r = await linkReserve(ctx, { chainId: Number(b.chainId) as 8453, reserveSafe: b.reserveSafe, dailyLimitUsd: b.dailyLimitUsd, triggerHf: b.triggerHf });
    if (r.stage === "not_sent") return Response.json({ ...r, error: r.error }, { status: 502 });
    return Response.json(r);
  } catch (err) {
    return toResponse(err);
  }
}
