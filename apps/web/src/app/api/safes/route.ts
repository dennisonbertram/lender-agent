import { listSafesForWallet } from "@/server/auth/access";
import { HttpError, toResponse } from "@/server/http";
import { requireSession } from "@/server/request";
import { addSafe } from "@/server/safes";
import { getServices } from "@/server/services";

export const dynamic = "force-dynamic";

/** The signed-in user's Safes (still owned on-chain now). */
export async function GET(req: Request) {
  try {
    const services = getServices();
    const { db, session } = await requireSession(req, services);
    return Response.json({ safes: await listSafesForWallet(db, services.access, session.userId) });
  } catch (err) {
    return toResponse(err);
  }
}

/** Add a Safe by address. 400 with the error text when it is not valid or not owned. */
export async function POST(req: Request) {
  try {
    const services = getServices();
    const { db, session } = await requireSession(req, services);
    const body = (await req.json().catch(() => null)) as { address?: unknown; name?: unknown } | null;
    if (!body || typeof body.address !== "string") throw new HttpError(400, "Enter an address.");
    const name = typeof body.name === "string" ? body.name : undefined;
    return Response.json(await addSafe(db, services, { userId: session.userId, wallet: session.address, address: body.address, name }), { status: 201 });
  } catch (err) {
    return toResponse(err);
  }
}
