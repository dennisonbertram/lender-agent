import { toResponse } from "@/server/http";
import { listProposals } from "@/server/proposals/read";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const open = new URL(req.url).searchParams.get("open") === "1";
    return Response.json({ proposals: await listProposals(await safeContext(req, address), { open }) });
  } catch (err) {
    return toResponse(err);
  }
}
