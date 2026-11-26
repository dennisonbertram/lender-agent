import { NextResponse } from "next/server";
import { toResponse } from "@/server/http";
import { loanDetail } from "@/server/loans";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

/** One loan with its health history and open proposals. */
export async function GET(req: Request, { params }: { params: Promise<{ address: string; loanId: string }> }) {
  try {
    const { address, loanId } = await params;
    return NextResponse.json(await loanDetail(await safeContext(req, address), decodeURIComponent(loanId)));
  } catch (err) {
    return toResponse(err);
  }
}
