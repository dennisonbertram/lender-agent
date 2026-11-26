import { NextResponse } from "next/server";
import { toResponse } from "@/server/http";
import { loansFor } from "@/server/loans";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

/** The Safe's loans and balances on the networks the signed-in wallet owns, read from chain now. */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    return NextResponse.json(await loansFor(await safeContext(req, address)));
  } catch (err) {
    return toResponse(err);
  }
}
