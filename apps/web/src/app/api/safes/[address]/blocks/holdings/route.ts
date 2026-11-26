import { holdingsFor } from "@/server/blocks/holdings";
import { toResponse } from "@/server/http";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    return Response.json(await holdingsFor(await safeContext(req, address)));
  } catch (err) {
    return toResponse(err);
  }
}
