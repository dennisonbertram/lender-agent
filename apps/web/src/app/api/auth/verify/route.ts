import { getDb } from "@/server/db/client";
import { SiweError, verifySignIn } from "@/server/auth/siwe";
import { createSession, sessionCookie } from "@/server/auth/session";
import { HttpError, toResponse } from "@/server/http";
import type { Hex } from "@/shared/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { message?: unknown; signature?: unknown } | null;
    if (typeof body?.message !== "string" || typeof body.signature !== "string") throw new HttpError(400, "message and signature are required");
    const domain = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    const db = await getDb();
    const { address, chainId } = await verifySignIn(db, { message: body.message, signature: body.signature as Hex, domain }).catch((e) => {
      throw e instanceof SiweError ? new HttpError(401, e.message) : e;
    });
    const { token, expiresAt } = await createSession(db, { address, chainId });
    const res = Response.json({ address });
    res.headers.append("Set-Cookie", sessionCookie(token, expiresAt));
    return res;
  } catch (err) {
    return toResponse(err);
  }
}
