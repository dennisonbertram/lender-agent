import { HttpError, toResponse } from "@/server/http";
import { permissionState } from "@/server/reserve/policy-change";
import { requireNetwork } from "@/server/auth/access";
import { safeContext } from "@/server/request";
import { isChainId } from "@/shared/types";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ address: string }> };

/** `?chainId=` what the app does and what the chain still allows, and the sentence the page shows. */
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const chainId = Number(new URL(req.url).searchParams.get("chainId") ?? 8453);
    if (!isChainId(chainId)) throw new HttpError(400, "Unknown network.");
    requireNetwork(ctx.access, chainId);
    return Response.json(await permissionState(ctx, null, chainId, ctx.safe.id));
  } catch (err) {
    return toResponse(err);
  }
}
