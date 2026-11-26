import { toResponse } from "@/server/http";
import { createHandler } from "@/server/safe-create/api";
import { getServices } from "@/server/services";

export const dynamic = "force-dynamic";

/** Create the Safe record from the creator's signed setup. Deploys nothing. */
export async function POST(req: Request) {
  try {
    return Response.json(await createHandler(req, getServices()), { status: 201 });
  } catch (err) {
    return toResponse(err);
  }
}
