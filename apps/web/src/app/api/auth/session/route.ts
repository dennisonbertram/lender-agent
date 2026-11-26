import { getDb } from "@/server/db/client";
import { getSession, readSessionCookie } from "@/server/auth/session";
import { HttpError, toResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await getSession(await getDb(), readSessionCookie(req));
    if (!session) throw new HttpError(401);
    return Response.json({ address: session.address });
  } catch (err) {
    return toResponse(err);
  }
}
