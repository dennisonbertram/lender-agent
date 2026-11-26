import { appendServerMessage } from "@/server/agent/persist";
import { toResponse } from "@/server/http";
import { repayLoan } from "@/server/proposals/repay";
import { SendBlocked } from "@/server/proposals/send";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

/** Repay part of a loan: drafts "approve + repay the typed amount" in one batch and sends it to the Safe queue. The loan id names the exact position: `{chainId}:{safe}:{lender}`; an unknown one is a 404. The body carries `{ amount }` in USDC. */
export async function POST(req: Request, { params }: { params: Promise<{ address: string; loanId: string }> }) {
  try {
    const { address, loanId } = await params;
    const ctx = await safeContext(req, address);
    const body = await req.json().catch(() => null) as { amount?: number; idempotencyKey?: string } | null;
    const r = await repayLoan(ctx, { loanId: decodeURIComponent(loanId), amount: body?.amount, idempotencyKey: body?.idempotencyKey });
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
