import { compareFor } from "@/server/blocks/compare";
import { HttpError, toResponse } from "@/server/http";
import { safeContext } from "@/server/request";
import { z } from "zod";

export const dynamic = "force-dynamic";

const Query = z.object({
  cash: z.coerce.number().finite().positive(),
  asset: z.enum(["ETH", "wstETH", "WBTC"]).optional(),
  network: z.enum(["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"]).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) throw new HttpError(400, "Use numbers only, for example $5,000.");
    return Response.json(await compareFor(await safeContext(req, address), q.data));
  } catch (err) {
    return toResponse(err);
  }
}
