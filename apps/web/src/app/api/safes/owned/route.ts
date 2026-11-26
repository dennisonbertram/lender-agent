import { toResponse } from "@/server/http";
import { requireSession } from "@/server/request";
import { findOwnedSafes } from "@/server/safes";
import { getServices } from "@/server/services";

export const dynamic = "force-dynamic";

/** Safes the wallet owns (Transaction Service, confirmed on-chain). */
export async function GET(req: Request) {
  try {
    const services = getServices();
    const { session } = await requireSession(req, services);
    return Response.json({ safes: await findOwnedSafes(services, session.address) });
  } catch (err) {
    return toResponse(err);
  }
}
