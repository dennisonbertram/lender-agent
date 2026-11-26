// `MOCK=1` only: reset the mock world for the next E2E test. 404 in every other mode.
import { toResponse } from "@/server/http";
import { resetMockWorld } from "@/server/mock/reset";

export async function POST(): Promise<Response> {
  try {
    await resetMockWorld();
    return Response.json({ ok: true });
  } catch (err) {
    return toResponse(err);
  }
}
