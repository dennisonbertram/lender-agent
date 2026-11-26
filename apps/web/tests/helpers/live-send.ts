import { planDrafts } from "@/server/db/schema";
import type { Db } from "@/server/db/client";
import { sendToSafe, type SendInput } from "@/server/proposals/send";
import type { SafeContext } from "@/server/request";

/** Makes `draftKey` the Safe's live plan draft (what the card the user pressed is), then sends it. Send refuses any other key. */
export async function sendLive(ctx: SafeContext, input: SendInput) {
  const draft = { text: "$2,000", hfIdx: 1 as const, months: 12 as const, cash: input.cash, msgId: "m1", draftKey: input.draftKey, seen: ["m1"] };
  await (ctx.db as Db).insert(planDrafts).values({ safeId: ctx.safe.id, draft }).onConflictDoUpdate({ target: planDrafts.safeId, set: { draft } });
  return sendToSafe(ctx, input);
}
