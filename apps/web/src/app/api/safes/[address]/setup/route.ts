import { toResponse } from "@/server/http";
import { setupHandler, setupStatusHandler } from "@/server/safe-create/api";
import { getServices } from "@/server/services";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ address: string }> };

/** Set the Safe up on a network (relayer, or the user's own transaction). Idempotent. */
export async function POST(req: Request, { params }: Params) {
  try {
    return Response.json(await setupHandler(req, (await params).address, getServices()));
  } catch (err) {
    return toResponse(err);
  }
}

/** Deployed and indexed yet? */
export async function GET(req: Request, { params }: Params) {
  try {
    const chainId = new URL(req.url).searchParams.get("chainId");
    return Response.json(await setupStatusHandler(req, (await params).address, chainId, getServices()));
  } catch (err) {
    return toResponse(err);
  }
}
