import { EXPLAIN_TOPICS, explainFor, type ExplainTopic } from "@/server/blocks/explain";
import { HttpError, toResponse } from "@/server/http";
import { safeContext } from "@/server/request";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const topic = new URL(req.url).searchParams.get("topic") as ExplainTopic;
    if (!EXPLAIN_TOPICS.includes(topic)) throw new HttpError(400, "Unknown topic");
    return Response.json(await explainFor(await safeContext(req, address), topic));
  } catch (err) {
    return toResponse(err);
  }
}
