import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { checkWorkerHealth, workerStallLimitMs } from "@/worker/health";

export const dynamic = "force-dynamic";

/** `{ watching, lastOkAt }` for the chat header (r14). */
export async function GET() {
  const { watching, lastOkAt } = await checkWorkerHealth(await getDb(), { now: new Date(), limitMs: workerStallLimitMs() });
  return NextResponse.json({ watching, lastOkAt: lastOkAt?.toISOString() ?? null });
}
