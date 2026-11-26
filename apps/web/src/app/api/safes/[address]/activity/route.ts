import { NextResponse } from "next/server";
import { activityFor } from "@/server/activity-view";
import { toResponse } from "@/server/http";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

/** The activity the signed-in owner may see, newest first. */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const ctx = await safeContext(req, address);
    return NextResponse.json({ activity: await activityFor(ctx) });
  } catch (err) {
    return toResponse(err);
  }
}
