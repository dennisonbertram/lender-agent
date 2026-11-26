// A server-side agent turn with no user bubble (a deposit arrived). Same model, system prompt, tools and text
// guard as runChat; the event is a synthetic user message that is sent to the model but never stored.
import { convertToModelMessages, isStepCount, readUIMessageStream, streamText, type LanguageModel } from "ai";
import type { Db } from "@/server/db/client";
import { guardText } from "./run";
import { appendServerMessage, forModel, verifiedFacts, lastAgentText, loadThread, type ChatMessage } from "./persist";
import { SYSTEM_PROMPT } from "./prompt";
import { chatTools } from "./tools";

export const EVENT_TURN_TIMEOUT_MS = 45_000;

export type EventTurnInput = { db: Db; safeId: number; model: LanguageModel; /** The synthetic event text the model sees as the latest message. */ event: string; /** Stable id of the stored reply, so a retry never doubles it. */ id: string; timeoutMs?: number };

/** Run one turn and store the assistant reply under `id`. Returns the stored message, or null when the model said nothing. Throws when the model fails or times out. */
export async function runEventTurn({ db, safeId, model, event, id, timeoutMs = EVENT_TURN_TIMEOUT_MS }: EventTurnInput): Promise<ChatMessage | null> {
  const thread = await loadThread(db, safeId);
  const priorText = lastAgentText(thread);
  const history: ChatMessage[] = [...thread, { id: `event-${id}`, role: "user", parts: [{ type: "text", text: event }] }];
  let failure: unknown;
  const result = streamText({
    model,
    system: `${SYSTEM_PROMPT}${verifiedFacts(history)}`,
    messages: await convertToModelMessages(forModel(history), { tools: chatTools }),
    tools: chatTools,
    stopWhen: isStepCount(4),
    abortSignal: AbortSignal.timeout(timeoutMs),
    experimental_transform: guardText(undefined, priorText),
    onError: ({ error }) => { failure = error ?? new Error("model error"); },
  });
  let reply: ChatMessage | undefined;
  for await (const m of readUIMessageStream<ChatMessage>({ stream: result.toUIMessageStream({ onError: () => "model error" }), onError: (e) => { failure ??= e; } })) reply = m;
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  const parts = (reply?.parts ?? []).filter((p) => p.type !== "step-start" && !(p.type === "text" && !p.text.trim()));
  if (parts.length === 0) return null;
  return appendServerMessage(db, safeId, { id, parts, source: "agent" });
}
