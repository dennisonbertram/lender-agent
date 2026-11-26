import { toResponse } from "@/server/http";
import { getProposal } from "@/server/proposals/read";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  try {
    const { address, id } = await params;
    return Response.json({ proposal: await getProposal(await safeContext(req, address), id) });
  } catch (err) {
    return toResponse(err);
  }
}
