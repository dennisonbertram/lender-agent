import { getDb } from "@/server/db/client";
import { destroySession, readSessionCookie, sessionCookie } from "@/server/auth/session";
import { toResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    await destroySession(await getDb(), readSessionCookie(req));
    const res = Response.json({ ok: true });
    res.headers.append("Set-Cookie", sessionCookie("", null));
    return res;
  } catch (err) {
    return toResponse(err);
  }
}
