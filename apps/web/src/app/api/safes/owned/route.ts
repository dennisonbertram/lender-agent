import { DISCOVERY_CHAIN_IDS, mergeOwnedSafeSlices } from "@/lib/owned-safes";
import { HttpError, toResponse } from "@/server/http";
import { requireSession } from "@/server/request";
import { findOwnedSafes, findOwnedSafesOnChain } from "@/server/safes";
import { getServices } from "@/server/services";
import type { ChainId } from "@/shared/types";

export const dynamic = "force-dynamic";

/**
 * Safes the wallet owns (Transaction Service, confirmed on-chain).
 * `?chainId=` scopes the lookup to one served network so the picker can show each network's results as they arrive;
 * without it the response is the original all-networks aggregate.
 */
export async function GET(req: Request) {
  try {
    const services = getServices();
    const { session } = await requireSession(req, services);
    const param = new URL(req.url).searchParams.get("chainId");
    if (param === null) return Response.json({ safes: await findOwnedSafes(services, session.address) });
    const chainId = Number(param) as ChainId;
    if (!DISCOVERY_CHAIN_IDS.includes(chainId)) throw new HttpError(400, "Enter a served network.");
    return Response.json({ safes: mergeOwnedSafeSlices(await findOwnedSafesOnChain(services, chainId, session.address)) });
  } catch (err) {
    return toResponse(err);
  }
}
