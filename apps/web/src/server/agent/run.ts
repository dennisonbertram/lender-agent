// One chat turn: stream the model's reply (text and tool blocks), guard the text, store the thread.
// If the model call fails, `routeIntent` answers with a block instead (BP-08, architecture section 6).
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, isStepCount, streamText, validateUIMessages, type LanguageModel, type TextStreamPart } from "ai";
import { randomUUID } from "node:crypto";
import { recordActivity } from "@/server/activity";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import type { UIBlock } from "@/lib/blocks";
import type { Urgent } from "@/lib/blocks";
import type { ChatFacts } from "./model";
import { routeIntent, type IntentCtx, type LoanStanding } from "@/lib/intents";
import { dropFalseRetraction, isPowerRequest, ONLY_SUGGEST_TEXT, SAFE_SENTENCE, textProblem } from "./honesty";
import { appendMessages, dataSchemas, forModel, verifiedFacts, lastAgentText, loadThread, type ChatMessage } from "./persist";
import { SYSTEM_PROMPT } from "./prompt";
import { looksLikeSecret, REDACTED_MESSAGE } from "./secrets";
import { chatTools, chatToolsFor, READ_TOOLS, type ChatTools, type PlanCheck } from "./tools";

type Chunk = TextStreamPart<ChatTools>;

/** The fallback sentence for the card the turn showed, so it never reads as a non sequitur beside it. */
const CARD_SENTENCE: Record<string, string> = {
  whatIf: "Here's what that fall would do to the loan.",
  showStatus: "Here's where your loan stands.",
  planLoan: "Here's a plan for that amount.",
  planEdit: "Here's a plan for that amount.",
  compareLenders: "Here are the lenders side by side.",
  showHoldings: "Here's what your Safe holds.",
};

/** Buffer each text part, check it, and replace it with the fixed safe sentence when it states a figure or claims an action. Blocks are untouched. */
export function guardText(log: (reason: string, text: string) => void = (reason, text) => console.warn(`[chat] replaced model text (${reason}): ${text}`), priorAgentText = "", hasLoan = false) {
  return () => {
    const held = new Map<string, string>();
    let sentence = SAFE_SENTENCE;
    return new TransformStream<Chunk, Chunk>({
      transform(chunk, controller) {
        const c = chunk as { type: string; id?: string; text?: string; toolName?: string };
        if (c.type === "tool-result" && c.toolName && CARD_SENTENCE[c.toolName]) sentence = CARD_SENTENCE[c.toolName];
        if (c.type === "text-start") { held.set(c.id!, ""); return; }
        if (c.type === "text-delta" && held.has(c.id!)) { held.set(c.id!, held.get(c.id!)! + (c.text ?? "")); return; }
        if (c.type === "text-end" && held.has(c.id!)) {
          const text = dropFalseRetraction(held.get(c.id!)!, priorAgentText, hasLoan);
          held.delete(c.id!);
          const problem = textProblem(text);
          if (problem) log(problem, text);
          controller.enqueue({ type: "text-start", id: c.id! } as Chunk);
          if (problem || text) controller.enqueue({ type: "text-delta", id: c.id!, text: problem ? sentence : text } as Chunk);
          controller.enqueue(chunk);
          return;
        }
        controller.enqueue(chunk);
      },
    });
  };
}

const lastText = (m: ChatMessage): string => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();

/** The reply when the model is unavailable: routeIntent's text and block (or the fixed "only suggest" text). */
export function fallbackReply(userText: string, maxCash: number, urgent?: Urgent, facts: ChatFacts = {}): { text: string; block?: UIBlock } {
  if (isPowerRequest(userText)) return { text: ONLY_SUGGEST_TEXT };
  const ctx: IntentCtx = { hasLoans: false, balances: { ETH: 0, wstETH: 0, WBTC: 0, USDC: 0, DAI: 0 }, maxCash: () => maxCash, urgent, hasLoan: facts.hasLoan, openProposal: facts.openProposal, standing: facts.standing };
  const r = routeIntent(userText, ctx) ?? routeIntent("hello", ctx)!;
  return { text: r.text ?? SAFE_SENTENCE, block: r.block };
}

export type RunChatInput = { ctx: SafeContext; messages: unknown; model: LanguageModel; maxCash?: number; /** A loan is at risk: the fallback offers no Borrow chip (VC-03). */ urgent?: Urgent; /** The Safe's open loans as plain facts, so the model knows they exist. */ loansNote?: string; /** The Safe has an open loan: the model may never deny it. */ hasLoan?: boolean; /** A loan proposal is waiting for signatures. */ openProposal?: boolean; /** Where the open loans stand. */ standing?: LoanStanding; /** Refuses a plan the Safe cannot back, before its card is drawn. */ planCheck?: PlanCheck };

export async function runChat({ ctx, messages, model, maxCash = 0, urgent, planCheck, loansNote, hasLoan = false, openProposal = false, standing }: RunChatInput): Promise<Response> {
  let incoming: ChatMessage[];
  try {
    incoming = await validateUIMessages<ChatMessage>({ messages, tools: chatTools as never, dataSchemas });
  } catch {
    throw new HttpError(400, "Bad request");
  }
  const latest = incoming[incoming.length - 1];
  if (!latest || latest.role !== "user" || !lastText(latest)) throw new HttpError(400, "Bad request");
  // G2: a pasted key or recovery phrase is neither stored nor sent to the model; the user's text is replaced.
  const secret = looksLikeSecret(lastText(latest));
  const userText = secret ? REDACTED_MESSAGE : lastText(latest);

  // The stored thread is the history; the client only supplies the new user message.
  const thread = await loadThread(ctx.db, ctx.safe.id);
  const user: ChatMessage = { id: latest.id, role: "user", parts: [{ type: "text", text: userText }] };
  const history = thread.some((m) => m.id === user.id) ? thread : [...thread, user];
  const priorAgentText = lastAgentText(thread);
  await appendMessages(ctx.db, ctx.safe.id, [user]);

  // Resolved when the reply is stored, so the response does not end before a reload can read it.
  let stored!: () => void;
  const storedP = new Promise<void>((r) => { stored = r; });
  const stream = createUIMessageStream<ChatMessage>({
    originalMessages: history,
    generateId: () => `a-${randomUUID()}`,
    execute: async ({ writer }) => {
      if (secret) {
        const id = `sec-${randomUUID()}`;
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: ONLY_SUGGEST_TEXT });
        writer.write({ type: "text-end", id });
        return;
      }
      const tools = chatToolsFor(planCheck);
      let failed = false;
      let fellBack = false;
      const writeFallback = () => {
        if (fellBack) return;
        fellBack = true;
        const r = fallbackReply(userText, maxCash, urgent, { hasLoan, openProposal, standing });
        const id = `fb-${randomUUID()}`;
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: r.text });
        writer.write({ type: "text-end", id });
        if (r.block) writer.write({ type: "data-block", data: { block: r.block } });
      };
      try {
        const result = streamText({
          model,
          system: `${SYSTEM_PROMPT}${loansNote ? `\n${loansNote}` : ""}${verifiedFacts(history)}`,
          messages: await convertToModelMessages(forModel(history), { tools }),
          tools,
          stopWhen: isStepCount(4),
          experimental_transform: guardText(undefined, priorAgentText, hasLoan),
          onError: () => { failed = true; },
        });
        for await (const chunk of result.toUIMessageStream({ originalMessages: history, onError: () => "model error" })) {
          if (chunk.type === "error") { failed = true; continue; }
          if (failed && (chunk.type === "finish-step" || chunk.type === "finish")) writeFallback();
          writer.write(chunk);
        }
      } catch {
        failed = true;
      }
      if (failed) writeFallback();
    },
    onEnd: async ({ responseMessage }) => {
      try {
        await appendMessages(ctx.db, ctx.safe.id, [{ ...responseMessage, parts: responseMessage.parts.filter((p) => p.type !== "step-start") }]);
        if (secret) await logRefusal(ctx, responseMessage);
        else await logReads(ctx, responseMessage);
      } finally {
        stored();
      }
    },
    onError: () => "Something went wrong",
  });
  const held = stream.pipeThrough(new TransformStream({ flush: () => Promise.race([storedP, new Promise((r) => setTimeout(r, 3000))]).then(() => undefined) }));
  return createUIMessageStreamResponse({ stream: held, consumeSseStream: ({ stream }) => { void stream.pipeTo(new WritableStream()).catch(() => undefined); } });
}

/** One Activity row per reply, only when the agent really read the Safe's data (G3). */
async function logReads(ctx: SafeContext, reply: ChatMessage): Promise<void> {
  const read = reply.parts.some((p) => {
    if (p.type === "data-block") return p.data.block.kind === "status" || p.data.block.kind === "holdings";
    return p.type.startsWith("tool-") && READ_TOOLS.has(p.type.slice(5)) && (p as { state?: string }).state === "output-available";
  });
  if (!read) return;
  await recordActivity(ctx.db, {
    safeId: ctx.safe.id,
    chainId: ctx.networks[0]?.chainId as 8453 | undefined,
    actor: "Agent",
    kind: "read",
    text: "Read balances and loans to answer in chat",
    eventKey: `chat-read:${reply.id}`,
  });
}

/** One Activity row when the agent refused a message that looked like a secret; it never holds the text itself (G2, G3). */
async function logRefusal(ctx: SafeContext, reply: ChatMessage): Promise<void> {
  await recordActivity(ctx.db, {
    safeId: ctx.safe.id,
    chainId: ctx.networks[0]?.chainId as 8453 | undefined,
    actor: "Agent",
    kind: "status",
    text: "Removed a chat message that looked like a secret key",
    eventKey: `chat-secret:${reply.id}`,
  });
}
