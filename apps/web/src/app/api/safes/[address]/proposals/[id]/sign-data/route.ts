import { toResponse } from "@/server/http";
import { getSignData } from "@/server/proposals/sign";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  try {
    const { address, id } = await params;
    const ctx = await safeContext(req, address);
    return Response.json(await getSignData(ctx, id));
  } catch (err) {
    return toResponse(err);
  }
}
