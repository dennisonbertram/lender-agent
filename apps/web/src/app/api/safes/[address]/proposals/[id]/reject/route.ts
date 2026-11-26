import { toResponse } from "@/server/http";
import { rejectProposal } from "@/server/proposals/reject";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  try {
    const { address, id } = await params;
    return Response.json({ proposal: await rejectProposal(await safeContext(req, address), id) });
  } catch (err) {
    return toResponse(err);
  }
}
