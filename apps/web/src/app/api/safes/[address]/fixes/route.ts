import { draftFix, fixPanel, waitingFixes } from "@/server/fixes";
import { HttpError, toResponse } from "@/server/http";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ address: string }> };

/** `?loanId=` the fix card's data for one loan; without it the fixes waiting in the Safe queue (overview lines). */
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const loanId = new URL(req.url).searchParams.get("loanId");
    return Response.json(loanId ? await fixPanel(ctx, loanId) : { waiting: await waitingFixes(ctx) });
  } catch (err) {
    return toResponse(err);
  }
}

/** Choose a fix: `{ loanId, option: "coll" | "repay" | "both" }`. Makes a draft only; nothing is sent (r30). */
export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const b = await req.json().catch(() => ({}));
    if (typeof b.loanId !== "string" || !["coll", "repay", "both"].includes(b.option)) throw new HttpError(400, "Pick one of the options.");
    return Response.json({ draft: await draftFix(ctx, { loanId: b.loanId, option: b.option }) });
  } catch (err) {
    return toResponse(err);
  }
}
