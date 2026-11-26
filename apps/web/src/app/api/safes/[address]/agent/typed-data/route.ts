import { toResponse } from "@/server/http";
import { agentTypedData } from "@/server/agent-role";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const body = await req.json().catch(() => ({}));
    return Response.json(agentTypedData(ctx, body.chainId));
  } catch (err) {
    return toResponse(err);
  }
}
