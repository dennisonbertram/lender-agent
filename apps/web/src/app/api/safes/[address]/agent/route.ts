import { toResponse } from "@/server/http";
import { addAgent, agentStatus, removeAgent } from "@/server/agent-role";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ address: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    return Response.json(await agentStatus(await safeContext(req, (await params).address)));
  } catch (err) {
    return toResponse(err);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const body = await req.json().catch(() => ({}));
    return Response.json(await addAgent(ctx, { chainId: body.chainId, signature: body.signature }));
  } catch (err) {
    return toResponse(err);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const body = await req.json().catch(() => ({}));
    return Response.json(await removeAgent(ctx, { signatures: Array.isArray(body.signatures) ? body.signatures : [] }));
  } catch (err) {
    return toResponse(err);
  }
}
