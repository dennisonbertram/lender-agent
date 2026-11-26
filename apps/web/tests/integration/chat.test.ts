import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { asc, eq } from "drizzle-orm";
import { GET, POST } from "@/app/api/safes/[address]/chat/route";
import { messages as messagesTable, activity, safeNetworks } from "@/server/db/schema";
import { replyChunks } from "@/server/agent/model";

// The route's real-mode model needs a key; these tests drive it with the scripted model explicitly.
vi.mock("@/server/agent/model", async (orig) => {
  const m = await orig<typeof import("@/server/agent/model")>();
  return { ...m, getChatModel: (opts: Parameters<typeof m.createScriptedModel>[0]) => m.createScriptedModel(opts) };
});
import { appendServerMessage, loadThread } from "@/server/agent/persist";
import { runChat } from "@/server/agent/run";
import { safeContext } from "@/server/request";
import { MOCK_COSIGNER, MOCK_OWNER, MOCK_SAFE, MOCK_STRANGER } from "@/server/mock/seed";
import { createTestWorld, type TestWorld } from "../helpers/world";

const params = { params: Promise.resolve({ address: MOCK_SAFE }) };
const userMsg = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });

/** Read an SSE stream into its JSON chunks. */
async function chunksOf(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text.split("\n\n").map((l) => l.replace(/^data: /, "").trim()).filter((l) => l && l !== "[DONE]").map((l) => JSON.parse(l));
}

describe("chat route", () => {
  let world: TestWorld;
  let safeId: number;
  let cookie: string;
  beforeEach(async () => {
    world = await createTestWorld();
    ({ cookie } = await world.signIn(MOCK_OWNER));
    safeId = await world.trackSafe(MOCK_SAFE, { agentAdded: true });
  });
  afterEach(() => world.reset());

  const post = async (text: string, id = "u1", c = cookie) => {
    const res = await POST(world.req(`/api/safes/${MOCK_SAFE}/chat`, { method: "POST", cookie: c, json: { messages: [userMsg(id, text)] } }), params);
    await res.clone().text(); // the client reads the whole reply
    return res;
  };
  const thread = async (c = cookie) => (await (await GET(world.req(`/api/safes/${MOCK_SAFE}/chat`, { cookie: c }), params)).json()).messages;

  it("a scripted tool call produces the block in the stream and in the stored thread", async () => {
    const res = await post("I need $12k");
    expect(res.status).toBe(200);
    const chunks = await chunksOf(res);
    const out = chunks.find((c) => c.type === "tool-output-available");
    expect(out).toMatchObject({ output: { kind: "plan", cash: 12000 } });
    const stored = await thread();
    expect(stored.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    const tool = stored[1].parts.find((p: { type: string }) => p.type === "tool-planLoan");
    expect(tool).toMatchObject({ state: "output-available", output: { kind: "plan", cash: 12000 } });
    expect(stored[1].parts.find((p: { type: string }) => p.type === "text").text).toBe("Here is a plan. Change anything below.");
  });

  it("\"Make it $3,000 instead\" calls planEdit and posts an edit plan block with only parameters (BP-24)", async () => {
    const res = await post("Make it $3,000 instead");
    const out = (await chunksOf(res)).find((c) => c.type === "tool-output-available");
    expect(out).toMatchObject({ output: { kind: "plan", cash: 3000, edit: true } });
    const stored = await thread();
    expect(stored[1].parts.find((p: { type: string }) => p.type === "tool-planEdit")).toMatchObject({ state: "output-available", output: { kind: "plan", cash: 3000, edit: true } });
  });

  it("reload returns the same thread in order, cards intact, including server-pushed cards", async () => {
    await post("I need $12k", "u1");
    await appendServerMessage(world.db, safeId, { parts: [{ type: "data-proposal", data: { proposalId: "p-1" } }] });
    await post("how does this work?", "u2");
    const first = await thread();
    const second = await thread();
    expect(second).toEqual(first);
    expect(first.map((m: { role: string; parts: { type: string }[] }) => `${m.role}:${m.parts.map((p) => p.type).join(",")}`)).toEqual([
      "user:text", "assistant:text,tool-planLoan", "assistant:data-proposal", "user:text", "assistant:text,tool-explain",
    ]);
    expect(first[2].parts[0].data).toEqual({ proposalId: "p-1" });
    // the second request is answered with the stored history: the model saw all of it
    expect(first).toHaveLength(5);
  });

  it("a tool result that fails the schema is not rendered: error part, no block", async () => {
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => ({
        stream: simulateReadableStream({
          chunks: prompt[prompt.length - 1].role === "tool"
            ? replyChunks({ text: "" })
            : replyChunks({ text: "Here you go.", tool: { name: "explain", input: { topic: "gas" } } }),
        }),
      }),
    });
    const ctx = await safeContext(world.req(`/api/safes/${MOCK_SAFE}/chat`, { cookie }), MOCK_SAFE);
    const res = await runChat({ ctx, messages: [userMsg("u1", "explain")], model });
    const chunks = await chunksOf(res);
    expect(chunks.some((c) => c.type === "tool-output-available")).toBe(false);
    expect(chunks.some((c) => c.type === "tool-input-error" || c.type === "tool-output-error")).toBe(true);
    const stored = await thread();
    const parts = stored[1].parts as { type: string; state?: string; output?: unknown }[];
    expect(parts.some((p) => p.output !== undefined)).toBe(false);
    expect(parts.some((p) => p.type === "data-block")).toBe(false);
  });

  it("the model throwing falls back to routeIntent and still answers with a block", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error("provider down"); } });
    const ctx = await safeContext(world.req(`/api/safes/${MOCK_SAFE}/chat`, { cookie }), MOCK_SAFE);
    const res = await runChat({ ctx, messages: [userMsg("u1", "I need $12k")], model, maxCash: 7500 });
    const chunks = await chunksOf(res);
    expect(chunks.find((c) => c.type === "data-block")).toMatchObject({ data: { block: { kind: "plan", cash: 12000 } } });
    const stored = await thread();
    expect(stored[1].parts.find((p: { type: string }) => p.type === "data-block").data.block).toMatchObject({ kind: "plan", cash: 12000 });
    expect(stored[1].parts.find((p: { type: string }) => p.type === "text").text).toBe("Here is a plan. Change anything below.");
  });

  it("the guard replaces model text that states a figure or claims an action; the block stays", async () => {
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => ({
        stream: simulateReadableStream({
          chunks: prompt[prompt.length - 1].role === "tool"
            ? replyChunks({ text: "" })
            : replyChunks({ text: "You can borrow $5,000 at 4% and I sent it to your Safe.", tool: { name: "planLoan", input: { cash: 5000 } } }),
        }),
      }),
    });
    const ctx = await safeContext(world.req(`/api/safes/${MOCK_SAFE}/chat`, { cookie }), MOCK_SAFE);
    const res = await runChat({ ctx, messages: [userMsg("u1", "borrow")], model });
    const chunks = await chunksOf(res);
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
    expect(text).toBe("I can plan a loan, compare lenders, show what a price drop would do, or explain how this works.");
    expect(chunks.find((c) => c.type === "tool-output-available")).toMatchObject({ output: { kind: "plan", cash: 5000 } });
    expect(JSON.stringify(await thread())).not.toMatch(/\$5,000|I sent it/);
  });

  it("a stored message that fails validation degrades to text and is not deleted", async () => {
    await post("I need $12k");
    // an old plan card whose block no longer validates
    await world.db.insert(messagesTable).values({
      id: "old-1", safeId, role: "assistant", schemaVersion: 0,
      message: { id: "old-1", role: "assistant", parts: [{ type: "text", text: "Here is the old card." }, { type: "tool-planLoan", toolCallId: "c1", state: "output-available", input: { cash: 1 }, output: { kind: "retired-block" } }] },
    });
    const stored = await thread();
    const old = stored.find((m: { id: string }) => m.id === "old-1");
    expect(old.parts).toEqual([{ type: "text", text: "Here is the old card." }]);
    const rows = await world.db.select().from(messagesTable).where(eq(messagesTable.id, "old-1"));
    expect(rows).toHaveLength(1);
    expect((rows[0].message as { parts: unknown[] }).parts).toHaveLength(2);
    expect(stored.find((m: { role: string; parts: { type: string }[] }) => m.parts.some((p) => p.type === "tool-planLoan"))).toBeTruthy();
  });

  it("posting the same message id twice stores it once", async () => {
    await post("hello", "same");
    await post("hello", "same");
    const rows = await world.db.select().from(messagesTable).where(eq(messagesTable.safeId, safeId)).orderBy(asc(messagesTable.seq));
    expect(rows.filter((r) => r.id === "same")).toHaveLength(1);
  });

  it("writes one Activity row for a real read, none for other replies", async () => {
    await post("how am i doing", "u1");
    await post("how does this work", "u2");
    const rows = await world.db.select().from(activity).where(eq(activity.safeId, safeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "Agent", kind: "read" });
  });

  it("is 403 for a stranger, 401 signed out, 403 for chat when the owner owns only some networks", async () => {
    const stranger = await world.signIn(MOCK_STRANGER);
    expect((await post("hi", "x", stranger.cookie)).status).toBe(403);
    expect((await GET(world.req(`/api/safes/${MOCK_SAFE}/chat`, { cookie: stranger.cookie }), params)).status).toBe(403);
    expect((await POST(world.req(`/api/safes/${MOCK_SAFE}/chat`, { method: "POST", json: { messages: [] } }), params)).status).toBe(401);

    // Safe tracked on Base and Arbitrum; the cosigner owns it on Base only.
    world.services.fixture.setOwners(42161, MOCK_SAFE, [MOCK_COSIGNER], 1);
    await world.db.insert(safeNetworks).values({ safeId, chainId: 42161, deployed: true, agentAdded: true });
    const owner = await world.signIn(MOCK_OWNER);
    const res = await GET(world.req(`/api/safes/${MOCK_SAFE}/chat`, { cookie: owner.cookie }), params);
    expect(res.status).toBe(403);
    expect((await post("hi", "y", owner.cookie)).status).toBe(403);
  });

  it("is 409 when the agent is not on this Safe", async () => {
    await world.db.update(safeNetworks).set({ agentAdded: false }).where(eq(safeNetworks.safeId, safeId));
    const res = await post("hi");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The Lender agent is not on this Safe.");
  });

  it("rejects a body that is not a chat request", async () => {
    const res = await POST(world.req(`/api/safes/${MOCK_SAFE}/chat`, { method: "POST", cookie, json: { nope: 1 } }), params);
    expect(res.status).toBe(400);
  });
});
