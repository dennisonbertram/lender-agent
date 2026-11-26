import { HttpError, toResponse } from "@/server/http";
import { turnReserveOff } from "@/server/reserve/policy-change";
import { safeContext } from "@/server/request";
import { isChainId } from "@/shared/types";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ address: string }> };

/** Turn the reserve off (BP-43): the executor stops now; the response holds the Reserve Safe transaction that removes the role. `{ chainId? }` */
export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const b = await req.json().catch(() => ({}));
    const chainId = b.chainId ?? 8453;
    if (!isChainId(chainId)) throw new HttpError(400, "Unknown network.");
    return Response.json(await turnReserveOff(ctx, chainId));
  } catch (err) {
    return toResponse(err);
  }
}
