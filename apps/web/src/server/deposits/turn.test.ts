import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { schema, type Db } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";
import { loadThread } from "@/server/agent/persist";
import { replyChunks } from "@/server/agent/model";
import { MOCK_EMPTY_SAFE, MOCK_OWNER } from "@/server/mock/seed";
import { pollDeposits } from "./poll";

let db: Db;
let reader: FixtureReader;
let safeId: number;
let calls: string[];
let now = new Date("2026-01-01T00:00:00Z");
const model = (text = "Here is what the Safe holds now.") => new MockLanguageModelV4({
  modelId: "t",
  doStream: async ({ prompt }) => {
    calls.push(JSON.stringify(prompt));
    const last = prompt[prompt.length - 1];
    return { stream: simulateReadableStream({ chunks: replyChunks(last?.role === "tool" ? { text: "" } : { text, tool: { name: "showHoldings", input: {} } }, `c${calls.length}`) }) };
  },
});
const failing = () => new MockLanguageModelV4({ modelId: "bad", doStream: async () => { throw new Error("boom"); } });
let chatModel: () => ReturnType<typeof model>;
const run = (at = now) => pollDeposits({ db, reader, now: at, log: () => {}, chatModel });
const turns = async () => (await loadThread(db, safeId)).filter((m) => m.id.startsWith("deposit-turn-"));

beforeEach(async () => {
  calls = [];
  now = new Date("2026-01-01T00:00:00Z");
  chatModel = () => model();
  db = await createTestDb();
  reader = createFixtureReader();
  reader.setOwners(8453, MOCK_EMPTY_SAFE, [MOCK_OWNER], 1);
  reader.setBalances(8453, MOCK_EMPTY_SAFE, {});
  const [s] = await db.insert(schema.safes).values({ address: MOCK_EMPTY_SAFE.toLowerCase(), name: "Main Safe" }).returning();
  safeId = s.id;
  await db.insert(schema.safeNetworks).values({ safeId, chainId: 8453, deployed: true });
  await run(); // baseline
});

describe("agent turn after a deposit", () => {
  it("one turn with a stable id and a tool card, none on the second run; the event is not stored as a user bubble", async () => {
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 0.005 });
    await run();
    await run();
    const [dep] = await db.select().from(schema.deposits);
    const t = await turns();
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe(`deposit-turn-${dep.id}`);
    expect(t[0].role).toBe("assistant");
    expect(t[0].parts.some((p) => p.type === "tool-showHoldings")).toBe(true);
    expect(calls).toHaveLength(2); // the tool call, then the end of the turn
    expect(calls[0]).toContain("Event: a deposit of 0.005 ETH on Base");
    const thread = await loadThread(db, safeId);
    expect(thread.filter((m) => m.role === "user")).toHaveLength(0);
    expect(thread[0].id).toBe(`deposit-${dep.id}`);
    expect(thread[0].parts[0]).toMatchObject({ text: expect.stringContaining("I see 0.005 ETH") });
  });

  it("two deposits inside two minutes make one turn; a deposit after the gap makes the next", async () => {
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 });
    await run();
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 2 });
    await run(new Date(now.getTime() + 60_000));
    expect(await turns()).toHaveLength(1);
    const first = calls.length;
    await run(new Date(now.getTime() + 150_000)); // the gap has passed; the second deposit is told now
    expect(await turns()).toHaveLength(2);
    expect(calls.length).toBeGreaterThan(first);
  });

  it("deposits found in one run share one turn that names them all", async () => {
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1, wstETH: 1 });
    await run();
    expect(await db.select().from(schema.deposits)).toHaveLength(2);
    expect(await turns()).toHaveLength(1);
    expect(calls[0]).toMatch(/deposits of .*ETH.*wstETH/);
  });

  it("a model failure leaves the fixed line only and the job succeeds", async () => {
    chatModel = failing as never;
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    await expect(run()).resolves.toBeUndefined();
    expect(await turns()).toHaveLength(0);
    expect((await loadThread(db, safeId))).toHaveLength(1);
    const [dep] = await db.select().from(schema.deposits);
    expect(dep.announcedAt).not.toBeNull();
  });

  it("no model (a key is missing) keeps the fixed line only", async () => {
    chatModel = () => { throw new Error("no key"); };
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    await expect(run()).resolves.toBeUndefined();
    expect(await turns()).toHaveLength(0);
  });

  it("figures in the model's text are replaced (G1)", async () => {
    chatModel = () => model("You can borrow $4,000 now.");
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 5 });
    await run();
    const [t] = await turns();
    const text = t.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    expect(text).not.toMatch(/\d/);
  });

  it("the gap runs from when the last turn ran, not from its deposit's announcement (0s / 60s / 180s / 190s)", async () => {
    const at = (sec: number) => new Date(now.getTime() + sec * 1000);
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 });
    await run(at(0)); // deposit A: told at once
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 2 });
    await run(at(60)); // deposit B inside the gap: deferred
    expect(await turns()).toHaveLength(1);
    await run(at(180)); // B's turn runs now (announced at 60 s)
    expect(await turns()).toHaveLength(2);
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 3 });
    await run(at(190)); // deposit C 10 s after the last turn: still deferred
    expect(await turns()).toHaveLength(2);
    await run(at(310));
    expect(await turns()).toHaveLength(3);
  });

  it("past the turn time budget the turn is deferred, not dropped", async () => {
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 });
    await pollDeposits({ db, reader, now, log: () => {}, chatModel, turnBudgetMs: 0 });
    expect(await turns()).toHaveLength(0);
    expect(await db.select().from(schema.deposits)).toHaveLength(1);
    await run(new Date(now.getTime() + 60_000));
    expect(await turns()).toHaveLength(1);
  });

  it("does not read creation networks that have no reader", async () => {
    await db.update(schema.safeNetworks).set({ chainId: 10 }).where(eq(schema.safeNetworks.safeId, safeId)); // recorded on [10, 8453]
    await db.insert(schema.safeNetworks).values({ safeId, chainId: 8453, deployed: true }).onConflictDoNothing();
    const seen: number[] = [];
    const orig = reader.readBalances.bind(reader);
    reader.readBalances = (async (c: number, a: never) => { seen.push(c); return orig(c as never, a); }) as never;
    await run();
    expect(seen).toEqual([8453]);
  });
});
