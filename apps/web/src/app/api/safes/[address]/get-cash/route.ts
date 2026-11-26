import { getCashFor } from "@/server/blocks/get-cash";
import { HttpError, toResponse } from "@/server/http";
import { safeContext } from "@/server/request";
import { z } from "zod";

export const dynamic = "force-dynamic";

const Query = z.object({
  cash: z.coerce.number().finite().positive().optional(),
  asset: z.enum(["ETH", "wstETH", "WBTC"]).optional(),
  hfIdx: z.coerce.number().int().min(0).max(2).optional(),
  network: z.enum(["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"]).optional(),
});

/** Screen 1 and 2 of Get cash (BP-34): limits, chips, the safety choices and the ranked lenders at one block. */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) throw new HttpError(400, "Use numbers only, for example $5,000.");
    return Response.json(await getCashFor(await safeContext(req, address), q.data as Parameters<typeof getCashFor>[1]));
  } catch (err) {
    return toResponse(err);
  }
}
