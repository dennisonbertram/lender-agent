// The signed-in owner's alert email: the address and the on/off choice (BP-21). Used for alerts only.
import { emailSettings, saveEmailSettings } from "@/server/email/prefs";
import { HttpError, toResponse } from "@/server/http";
import { requireSession } from "@/server/request";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { db, session } = await requireSession(req);
    return Response.json(await emailSettings(db, session.userId));
  } catch (err) {
    return toResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const { db, session } = await requireSession(req);
    const body = (await req.json().catch(() => null)) as { email?: unknown; enabled?: unknown } | null;
    if (!body || (body.email !== undefined && body.email !== null && typeof body.email !== "string") || (body.enabled !== undefined && typeof body.enabled !== "boolean")) throw new HttpError(400);
    return Response.json(await saveEmailSettings(db, session.userId, { email: body.email as string | null | undefined, enabled: body.enabled as boolean | undefined }));
  } catch (err) {
    return toResponse(err);
  }
}
