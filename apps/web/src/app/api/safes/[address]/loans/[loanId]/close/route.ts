import { appendServerMessage } from "@/server/agent/persist";
import { toResponse } from "@/server/http";
import { closeLoan } from "@/server/proposals/close";
import { SendBlocked } from "@/server/proposals/send";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

/** Close a loan (BP-26): drafts "repay all, withdraw all" in one batch and sends it to the Safe queue. The loan id names the exact position: `{chainId}:{safe}:{lender}`; an unknown one is a 404. */
export async function POST(req: Request, { params }: { params: Promise<{ address: string; loanId: string }> }) {
  try {
    const { address, loanId } = await params;
    const ctx = await safeContext(req, address);
    const r = await closeLoan(ctx, { loanId: decodeURIComponent(loanId) });
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
