import { HttpError, toResponse } from "@/server/http";
import { reserveNowOption, useReserveNow, type ReserveNowBinding } from "@/server/reserve/executor";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ address: string }> };

/** `?loanId=` the reserve option of an alert: enabled with the dialog title, or disabled with the reason. */
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const loanId = new URL(req.url).searchParams.get("loanId");
    if (!loanId) throw new HttpError(400, "Pick a loan.");
    return Response.json(await reserveNowOption(ctx, loanId));
  } catch (err) {
    return toResponse(err);
  }
}

/** `{ loanId, confirm: true, binding }` after reviewing the exact Reserve quote. */
export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await safeContext(req, (await params).address);
    const b = await req.json().catch(() => ({}));
    if (typeof b.loanId !== "string") throw new HttpError(400, "Pick a loan.");
    if (b.confirm !== true) throw new HttpError(400, "Confirm to use the reserve.");
    if (!b.binding || typeof b.binding !== "object") throw new HttpError(400, "Refresh the reserve quote before using it.");
    const binding = b.binding as Partial<ReserveNowBinding>;
    if (typeof binding.loanId !== "string" || typeof binding.reserveSafe !== "string" || typeof binding.linkFingerprint !== "string"
      || typeof binding.triggerHf !== "number" || !Number.isFinite(binding.triggerHf)
      || typeof binding.policyMaxRefillRaw !== "string" || typeof binding.policyRefillRaw !== "string" || typeof binding.policyPeriodRaw !== "string"
      || typeof binding.allowanceBalanceRaw !== "string" || typeof binding.allowanceTimestampRaw !== "string"
      || typeof binding.reserveBalanceRaw !== "string" || typeof binding.maxAmountRaw !== "string") {
      throw new HttpError(400, "Refresh the reserve quote before using it.");
    }
    return Response.json(await useReserveNow(ctx, b.loanId, { confirm: true, binding: binding as ReserveNowBinding }));
  } catch (err) {
    return toResponse(err);
  }
}
