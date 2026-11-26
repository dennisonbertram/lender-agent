import { appendServerMessage } from "@/server/agent/persist";
import { toResponse } from "@/server/http";
import { markDraftSent } from "@/server/plan-drafts";
import { refuseEditWithoutReplaces, replaceProposal, sendPlan } from "@/server/proposals/replace";
import { notifyCosigners } from "@/server/proposals/notify-cosigners";
import { SendBlocked } from "@/server/proposals/send";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ address: string }> };

/** Send to Safe (BP-14). Body: parameters only, `{ draftKey, chainId, cash, asset?, venueId?, venueChosen?, hfIdx?, months?, replaces?, intent? }`. `intent: "edit"` without `replaces` is a 409 while an open loan proposal exists. `replaces` is the id of the open proposal this edit replaces (BP-24). */
export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const b = await req.json().catch(() => ({}));
    const chainId = typeof b.chainId === "number" ? b.chainId : 8453;
    const input = { draftKey: b.draftKey, chainId, cash: b.cash, asset: b.asset, venueId: b.venueId, ...(b.venueChosen === true && { venueChosen: true }), hfIdx: b.hfIdx, months: b.months };
    if (b.intent === "edit" && typeof b.replaces !== "string") await refuseEditWithoutReplaces(ctx, chainId);
    const r = typeof b.replaces === "string" ? await replaceProposal(ctx, b.replaces, input) : await sendPlan(ctx, input);
    if (r.stage === "queued" || r.stage === "sending") {
      // The proposal card is its own chat message (mockup store: role "proposal"); the id makes a
      // second press, which returns the same proposal, write no second card.
      await appendServerMessage(ctx.db, ctx.safe.id, { id: `proposal-${r.proposalId}`, parts: [{ type: "data-proposal", data: { proposalId: r.proposalId } }] });
      if (typeof b.draftKey === "string") await markDraftSent(ctx.db, ctx.safe.id, b.draftKey, r.proposalId);
    }
    // Fire and forget: telling the co-signer never fails or slows the send. A "sending" proposal is picked up by the worker.
    if (r.stage === "queued") void notifyCosigners({ db: ctx.db, reader: ctx.services.reader }, r.proposalId);
    if (r.stage === "not_sent") return Response.json({ proposalId: r.proposalId, stage: r.stage, error: r.error }, { status: 502 });
    return Response.json(r);
  } catch (err) {
    if (err instanceof SendBlocked) return Response.json({ error: err.message, line: err.line }, { status: 422 });
    return toResponse(err);
  }
}
