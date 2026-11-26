import { HttpError, toResponse } from "@/server/http";
import { requestPolicyChange } from "@/server/reserve/policy-change";
import { safeContext } from "@/server/request";
import { isChainId } from "@/shared/types";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ address: string }> };

/** Change the reserve's limit and/or trigger: `{ chainId?, dailyLimitUsd?, trigger? }` (text, as typed). Returns the Reserve Safe transaction to sign. */
export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const b = await req.json().catch(() => ({}));
    const chainId = b.chainId ?? 8453;
    if (!isChainId(chainId)) throw new HttpError(400, "Unknown network.");
    for (const k of ["dailyLimitUsd", "trigger"]) if (b[k] !== undefined && typeof b[k] !== "string") throw new HttpError(400, "Enter the value as text.");
    return Response.json(await requestPolicyChange(ctx, chainId, { dailyLimitUsd: b.dailyLimitUsd, trigger: b.trigger }));
  } catch (err) {
    return toResponse(err);
  }
}
