import { toResponse } from "@/server/http";
import { previewHandler } from "@/server/safe-create/api";
import { getServices } from "@/server/services";

export const dynamic = "force-dynamic";

/** Review step of Create a Safe: the address and the setup-cost line. Writes nothing. */
export async function POST(req: Request) {
  try {
    return Response.json(await previewHandler(req, getServices()));
  } catch (err) {
    return toResponse(err);
  }
}
