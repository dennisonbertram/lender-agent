import { alertView } from "@/server/alerts/view";
import { HttpError, toResponse } from "@/server/http";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  try {
    const { address, id } = await params;
    if (!/^\d+$/.test(id)) throw new HttpError(404, "Alert not found");
    return Response.json({ alert: await alertView(await safeContext(req, address), Number(id)) });
  } catch (err) {
    return toResponse(err);
  }
}
