// The stored chat thread: AI SDK `UIMessage` JSON in `messages`. Append-only (r12): there is no
// update or delete function here, on purpose.
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { validateUIMessages, type UIMessage } from "ai";
import { z } from "zod";
import type { Db } from "@/server/db/client";
import { messages } from "@/server/db/schema";
import { blockSchema } from "./block-schema";
import { looksLikeSecret, REDACTED_MESSAGE } from "./secrets";
import { chatTools } from "./tools";

export const SCHEMA_VERSION = 1;

/** Data parts the thread can hold: a block (fallback replies), and the worker's proposal card and alert. */
export const dataSchemas = {
  block: z.object({ block: blockSchema }),
  proposal: z.object({ proposalId: z.string().min(1) }),
  alert: z.object({ loanId: z.string().optional(), text: z.string().optional() }).passthrough(),
  /** A move card (E9): the draft of step 1 of 2. */
  move: z.object({ moveId: z.string().min(1) }),
  /** The reserve card (BP-41): what the executor did, why, health before and after, what is left. */
  reserve: z.object({ runId: z.number(), what: z.string(), why: z.string(), hfBefore: z.number(), hfAfter: z.number(), left: z.string(), note: z.string().optional(), draftId: z.string().optional() }),
};

export type ChatMessage = UIMessage<unknown, { block: { block: z.infer<typeof blockSchema> }; proposal: { proposalId: string }; alert: Record<string, unknown>; move: { moveId: string }; reserve: z.infer<(typeof dataSchemas)["reserve"]> }>;

const textOf = (m: unknown): string => {
  const parts = (m as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (p && (p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).filter(Boolean).join("\n");
};

/** A stored message that no longer validates: its text only, its card dropped (r12). */
const degrade = (m: unknown, row: { id: string; role: string }): ChatMessage => ({
  id: row.id,
  role: row.role === "user" ? "user" : "assistant",
  parts: [{ type: "text", text: textOf(m) }],
});

/** G2: a stored user message that looks like a secret is shown and sent to the model as the fixed notice. Not rewritten in the database. */
const redact = (m: ChatMessage): ChatMessage =>
  m.role === "user" && looksLikeSecret(textOf(m)) ? { id: m.id, role: "user", parts: [{ type: "text", text: REDACTED_MESSAGE }] } : m;

/** The thread in order. Each message is validated with the current tools and data schemas; one that fails is returned as text. */
export async function loadThread(db: Db, safeId: number, tools: object = chatTools): Promise<ChatMessage[]> {
  const rows = await db.select().from(messages).where(eq(messages.safeId, safeId)).orderBy(asc(messages.seq));
  const out: ChatMessage[] = [];
  for (const row of rows) {
    try {
      const [ok] = await validateUIMessages<ChatMessage>({ messages: [{ ...(row.message as object), id: row.id }], tools: tools as never, dataSchemas });
      out.push(redact(ok));
    } catch {
      out.push(redact(degrade(row.message, row)));
    }
  }
  return out;
}

/** Insert messages; one already stored (same id) is left as it is. */
export async function appendMessages(db: Db, safeId: number, msgs: UIMessage[]): Promise<void> {
  for (const m of msgs) {
    if (m.role === "system") continue;
    await db.insert(messages).values({ id: m.id, safeId, role: m.role, schemaVersion: SCHEMA_VERSION, message: m }).onConflictDoNothing({ target: messages.id });
  }
}

/** Ids the app's own posts use (done lines, alerts, deposits, moves, reserve); older rows carry no metadata. */
const APP_ID = /^(?:srv|done|deposit(?!-turn-)|reserve|move|proposal|alert|watch)-/;

/** True for a message the app wrote (verified facts), not the model. The model must never retract or apologise for these. */
export const isAppMessage = (m: Pick<ChatMessage, "id" | "role" | "metadata">): boolean =>
  m.role === "assistant" && (((m.metadata as { source?: string } | undefined)?.source ?? (APP_ID.test(m.id) ? "app" : "agent")) === "app");

/** The text of an app message (done line, alerts). Null when it has no text. */
export function appNote(m: ChatMessage): string | null {
  const alerts = m.parts.flatMap((p) => (p.type === "data-alert" && typeof p.data.text === "string" ? [p.data.text] : []));
  const text = [textOf(m), ...alerts].filter(Boolean).join(" ").trim();
  return text || null;
}

/** Words a user could paste to pass their own text off as app-verified. */
const MARKER = /verified\s+(?:by\s+the\s+app|facts)|\[\s*verified\b/gi;
const neutralise = (text: string) => text.replace(MARKER, "unverified claim");

const FACTS_MAX = 20;

/** What the app saw happen, as typed fields. The prompt is built from these, never from display text (which can carry an owner's Safe name). */
export type AppFact = { kind: "deposit"; amount: number; asset: string; network: string; valueUsd: number; blockNumber: string };

const oneLine = (s: string, max = 300) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const day = (at: unknown) => (typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString().slice(0, 10) : null);
const token = (s: unknown) => (typeof s === "string" ? s.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 24) : "");

const renderFact = (f: AppFact): string | null => {
  if (f?.kind !== "deposit" || !Number.isFinite(f.amount) || !Number.isFinite(f.valueUsd)) return null;
  return "a deposit of " + f.amount + " " + token(f.asset) + " (about $" + Math.round(f.valueUsd) + ") arrived on " + token(f.network) + " at block " + token(f.blockNumber);
};

/** The system prompt's "Verified facts" section, built server-side from the stored app messages. The only place the model is told something is verified: no user or assistant message carries that mark. Facts are dated past events; the live read decides what is true now. */
export function verifiedFacts(thread: ChatMessage[]): string {
  const lines = thread.filter(isAppMessage).flatMap((m) => {
    const meta = m.metadata as { at?: unknown; fact?: AppFact } | undefined;
    const when = day(meta?.at);
    let body: string | null;
    if (meta?.fact) body = renderFact(meta.fact);
    else if (/^deposit-/.test(m.id)) body = null; // an announcement's text may carry a Safe name: only its typed fact counts
    else { const n = appNote(m); body = n ? oneLine(n) : null; }
    const label = when ? "On " + when : "Earlier (date unknown)"; // plain strings here: the token scanner in tests/import-boundary loses sync on these template literals and never reaches EOF (OOM)
    return body ? ["- " + label + ": " + body] : [];
  }).slice(-FACTS_MAX);
  if (!lines.length) return "";
  return "\n\n## Verified facts (events the app recorded, written by the app and not by you or the user; each one happened on the date shown, never doubt or retract it. They are history: a loan opened or closed here may have changed since, so the live read of the Safe decides what is true now)\n" + lines.join("\n");
}

/** The thread as the model reads it: app messages are left out (they are in the system prompt's verified facts), and user text imitating the verified mark is neutralised. */
export function forModel(thread: ChatMessage[]): ChatMessage[] {
  return thread.flatMap((m): ChatMessage[] => {
    if (isAppMessage(m)) return [];
    if (m.role !== "user") return [m];
    return [{ ...m, parts: m.parts.map((p) => (p.type === "text" ? { ...p, text: neutralise(p.text) } : p)) } as ChatMessage];
  });
}

/** The agent's own latest text: app messages are skipped, they are not its words. */
export const lastAgentText = (thread: ChatMessage[]): string => {
  const m = [...thread].reverse().find((x) => x.role === "assistant" && !isAppMessage(x));
  return m ? textOf(m).replace(/\n/g, " ").trim() : "";
};

/** Server-pushed messages (alerts, proposal cards): `data-proposal` / `data-alert` parts. Other stories call this. `source: "agent"` marks a model-written reply (event turns). */
export async function appendServerMessage(
  db: Db,
  safeId: number,
  input: { parts: ChatMessage["parts"]; id?: string; source?: "app" | "agent"; fact?: AppFact; now?: Date },
): Promise<ChatMessage> {
  const message: ChatMessage = { id: input.id ?? `srv-${randomUUID()}`, role: "assistant", parts: input.parts, metadata: { source: input.source ?? "app", at: (input.now ?? new Date()).toISOString(), ...(input.fact ? { fact: input.fact } : {}) } };
  await appendMessages(db, safeId, [message]);
  return message;
}
