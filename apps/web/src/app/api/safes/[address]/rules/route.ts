import { NextResponse } from "next/server";
import { toResponse } from "@/server/http";
import { safeContext } from "@/server/request";
import { rulePanel } from "@/server/rules";

export const dynamic = "force-dynamic";

/** Every loan of the Safe with its standing rule and the sentence Settings shows (BP-25). */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    return NextResponse.json(await rulePanel(await safeContext(req, address)));
  } catch (err) {
    return toResponse(err);
  }
}
