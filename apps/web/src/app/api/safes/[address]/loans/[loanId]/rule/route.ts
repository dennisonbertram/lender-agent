import { NextResponse } from "next/server";
import { HttpError, toResponse } from "@/server/http";
import { safeContext } from "@/server/request";
import { deleteRule, saveRule, type RuleOption } from "@/server/rules";

export const dynamic = "force-dynamic";
type P = { params: Promise<{ address: string; loanId: string }> };

/** Set or change the loan's standing rule (BP-25). Body: `{ option: "coll" | "repay" | "both", enabled: boolean }`. */
export async function PUT(req: Request, { params }: P) {
  try {
    const { address, loanId } = await params;
    const ctx = await safeContext(req, address);
    const body = await req.json().catch(() => null) as { option?: RuleOption; enabled?: boolean } | null;
    if (!body || typeof body.option !== "string" || typeof body.enabled !== "boolean") throw new HttpError(400, "Choose what the rule should draft.");
    return NextResponse.json({ rule: await saveRule(ctx, decodeURIComponent(loanId), { option: body.option, enabled: body.enabled }) });
  } catch (err) {
    return toResponse(err);
  }
}

export async function DELETE(req: Request, { params }: P) {
  try {
    const { address, loanId } = await params;
    await deleteRule(await safeContext(req, address), decodeURIComponent(loanId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toResponse(err);
  }
}
