import { getDb } from "@/server/db/client";
import { issueNonce } from "@/server/auth/siwe";
import { toResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ nonce: await issueNonce(await getDb()) });
  } catch (err) {
    return toResponse(err);
  }
}
