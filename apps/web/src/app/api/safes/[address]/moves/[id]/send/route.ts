import { appendServerMessage } from "@/server/agent/persist";
import { toResponse } from "@/server/http";
import { SendBlocked } from "@/server/proposals/send";
import { sendMove } from "@/server/moves/service";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

/** "Send move to Safe (step 1 of 2)" (BP-37). The proposal card is its own chat message, as for any proposal. */
export async function POST(req: Request, { params }: { params: Promise<{ address: string; id: string }> }) {
  try {
    const { address, id } = await params;
    const ctx = await safeContext(req, address);
    const r = await sendMove(ctx, id);
    if (r.stage === "queued" || r.stage === "sending") {
      await appendServerMessage(ctx.db, ctx.safe.id, { id: `proposal-${r.proposalId}`, parts: [{ type: "data-proposal", data: { proposalId: r.proposalId } }] });
    }
    if (r.stage === "not_sent") return Response.json({ proposalId: r.proposalId, stage: r.stage, error: r.error }, { status: 502 });
    return Response.json(r);
  } catch (err) {
    if (err instanceof SendBlocked) return Response.json({ error: err.message, line: err.line }, { status: 422 });
    return toResponse(err);
  }
}
