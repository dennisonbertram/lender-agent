import { toResponse } from "@/server/http";
import { confirmProposal } from "@/server/proposals/sign";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  try {
    const { address, id } = await params;
    const ctx = await safeContext(req, address);
    const body = (await req.json().catch(() => ({}))) as { signature?: unknown };
    return Response.json({ proposal: await confirmProposal(ctx, id, body.signature) });
  } catch (err) {
    return toResponse(err);
  }
}
