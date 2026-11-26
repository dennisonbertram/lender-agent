import { NextResponse } from "next/server";
import { HttpError, toResponse } from "@/server/http";
import { saveLevels } from "@/server/levels";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

/** Save one loan's Watch and At-risk levels (BP-19). Body: `{ warn: string, act: string }`. */
export async function PUT(req: Request, { params }: { params: Promise<{ address: string; loanId: string }> }) {
  try {
    const { address, loanId } = await params;
    const ctx = await safeContext(req, address);
    const body = await req.json().catch(() => null);
    if (!body || typeof body.warn !== "string" || typeof body.act !== "string") throw new HttpError(400, "Enter both levels.");
    return NextResponse.json(await saveLevels(ctx, decodeURIComponent(loanId), body.warn, body.act));
  } catch (err) {
    return toResponse(err);
  }
}
