import { z } from "zod";
import { HttpError, toResponse } from "@/server/http";
import { requireNetwork } from "@/server/auth/access";
import { pickSource, scanSources, servedOwned } from "@/server/blocks/block-inputs";
import { planChainOf, quotePlan } from "@/server/quote";
import { safeContext } from "@/server/request";
import { NETWORK_OF } from "@/shared/types";

export const dynamic = "force-dynamic";

const Body = z.object({
  cash: z.number().finite().positive(),
  asset: z.enum(["ETH", "wstETH", "WBTC", "USDC", "DAI"]).optional(),
  network: z.string().optional(),
  chainId: z.number().int().positive().optional(),
  venueId: z.string().optional(),
  hfIdx: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  months: z.union([z.literal(3), z.literal(12), z.literal(24)]).optional(),
  messageId: z.string().max(200).optional(),
  hypothetical: z.boolean().optional(),
  venueChosen: z.boolean().optional(),
});

/** The plan's figures at one block (BP-12). The plan belongs where the funds are: a named network is checked and quoted as asked; one not named lands on the funded owned network, like Get cash. */
export async function POST(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "Use numbers only, for example $5,000.");
    const input = body.data as Parameters<typeof quotePlan>[1];
    if (input.network === undefined && input.chainId === undefined) {
      if (!servedOwned(ctx).length) requireNetwork(ctx.access, 8453);
      input.network = NETWORK_OF[pickSource(await scanSources(ctx)).chainId];
    } else {
      requireNetwork(ctx.access, planChainOf(input));
    }
    return Response.json(await quotePlan({ ...ctx, ownedChainIds: ctx.access.ownedChainIds }, input));
  } catch (err) {
    return toResponse(err);
  }
}
