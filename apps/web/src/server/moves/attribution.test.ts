import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { schema, type Db } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";
import { pollDeposits } from "@/server/deposits/poll";
import { loadThread } from "@/server/agent/persist";
import { MOCK_EMPTY_SAFE, MOCK_OWNER } from "@/server/mock/seed";
import { fakeAggregator, fakeDestination, statusOf } from "./testing";
import { moveExpiry } from "./expiry";
import { quoteToJson, NATIVE } from "./types";

// The deposit job watches Base: a move from Ethereum to Base brings ETH to a network it polls.
let db: Db;
let reader: FixtureReader;
let safeId: number;
const T = new Date("2026-01-01T00:00:00Z");
let now = T;
const aggregator = fakeAggregator({ now: () => T.getTime() });
const destination = fakeDestination();
const SOURCE = ("0x" + "11".repeat(32)) as `0x${string}`;
const DEST = ("0x" + "22".repeat(32)) as `0x${string}`;
const poll = () => pollDeposits({ db, reader, now, log: () => {}, moveProof: { aggregator, destination } });
/** The bridge reports this move done and its destination transaction pays the Safe `raw`. */
const prove = (raw: bigint) => {
  aggregator.statuses.set(SOURCE.toLowerCase(), { ...statusOf("done"), receiving: { ...statusOf("done").receiving!, chainId: 8453, txHash: DEST, amount: raw } });
  destination.payments.set(DEST.toLowerCase(), raw);
};
const announced = async () => (await loadThread(db, safeId)).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).filter((t) => /deposit|I see|received/i.test(t));
const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

async function addMove(status: string, patch: Partial<typeof schema.moves.$inferInsert> = {}) {
  patch = { sourceTxHash: SOURCE, sentAt: T, ...patch };
  const q = (await fakeAggregator({ now: () => T.getTime() }).quote({ fromChain: 1, toChain: 8453, fromToken: NATIVE, toToken: NATIVE, fromAmount: eth(2), address: MOCK_EMPTY_SAFE }))!;
  const [row] = await db.insert(schema.moves).values({
    id: crypto.randomUUID(), safeId, fromChain: 1, toChain: 8453, asset: "ETH", status, quote: quoteToJson(q), spec: {}, quotedAt: T, expiresAt: moveExpiry(T.getTime(), "relay"), ...patch,
  }).returning();
  return { row: row!, q };
}

beforeEach(async () => {
  aggregator.statuses.clear();
  destination.payments.clear();
  now = T;
  db = await createTestDb();
  reader = createFixtureReader();
  reader.setOwners(8453, MOCK_EMPTY_SAFE, [MOCK_OWNER], 1);
  reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 });
  const [s] = await db.insert(schema.safes).values({ address: MOCK_EMPTY_SAFE.toLowerCase(), name: "Main Safe", createdAt: new Date("2025-01-01T00:00:00Z") }).returning();
  safeId = s.id;
  await db.insert(schema.safeNetworks).values({ safeId, chainId: 8453, deployed: true });
  await poll(); // baseline: 1 ETH
  now = new Date(T.getTime() + 60_000);
});

describe("deposit job and moves", () => {
  it("does not announce a move's arrival as a deposit", async () => {
    const { q } = await addMove("bridging");
    prove(q.toAmount);
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 + Number(q.toAmount) / 1e18 });
    await poll();
    expect(await db.select().from(schema.deposits)).toHaveLength(0);
    expect(await announced()).toEqual([]);
  });

  it("an unrelated deposit of the same asset still is one, whatever the move brings", async () => {
    const { q } = await addMove("bridging");
    prove(q.toAmount);
    const bridged = Number(q.toAmount) / 1e18;
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 + bridged + 3 });
    await poll();
    const deps = await db.select().from(schema.deposits);
    expect(deps).toHaveLength(1);
    expect(Number(deps[0].amount)).toBeCloseTo(3, 6);
  });

  it("without a move, the same rise is a deposit", async () => {
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 3 });
    await poll();
    expect(await db.select().from(schema.deposits)).toHaveLength(1);
  });

  it("counts what the move already explained once: a later rise is not hidden", async () => {
    const { row, q } = await addMove("bridging");
    prove(q.toAmount);
    const bridged = Number(q.toAmount) / 1e18;
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 + bridged });
    await poll();
    await db.update(schema.moves).set({ status: "arrived", receivedRaw: q.toAmount.toString(), arrivedAt: now }).where(eq(schema.moves.id, row.id));
    now = new Date(now.getTime() + 60_000);
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 + bridged + 2 });
    await poll();
    const deps = await db.select().from(schema.deposits);
    expect(deps).toHaveLength(1);
    expect(Number(deps[0].amount)).toBeCloseTo(2, 6);
  });

  it("does not announce a refund as a deposit on the source network", async () => {
    const { q } = await addMove("refunded", { fromChain: 8453, toChain: 1, arrivedAt: now });
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 + Number(q.fromAmount) / 1e18 });
    await poll();
    expect(await db.select().from(schema.deposits)).toHaveLength(0);
  });

  it("an unrelated deposit while the move is still pending is announced and consumes nothing of the move; the real arrival after it is hidden", async () => {
    const { row, q } = await addMove("bridging");
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 + 3 }); // someone else's 3 ETH; the bridge has not delivered yet
    await poll();
    let deps = await db.select().from(schema.deposits);
    expect(deps).toHaveLength(1);
    expect(Number(deps[0].amount)).toBeCloseTo(3, 6);
    expect((await db.select().from(schema.moves).where(eq(schema.moves.id, row.id)))[0]!.attributedRaw).toBe("0");
    now = new Date(now.getTime() + 60_000);
    prove(q.toAmount);
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 4 + Number(q.toAmount) / 1e18 });
    await poll();
    deps = await db.select().from(schema.deposits);
    expect(deps).toHaveLength(1); // the arrival is not a second deposit
  });

  it("the arrival first, then an unrelated deposit: only the second is announced", async () => {
    const { q } = await addMove("bridging");
    prove(q.toAmount);
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 + Number(q.toAmount) / 1e18 });
    await poll();
    expect(await db.select().from(schema.deposits)).toHaveLength(0);
    now = new Date(now.getTime() + 60_000);
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1 + Number(q.toAmount) / 1e18 + 3 });
    await poll();
    const deps = await db.select().from(schema.deposits);
    expect(deps).toHaveLength(1);
    expect(Number(deps[0].amount)).toBeCloseTo(3, 6);
  });

  it("another asset's rise is untouched", async () => {
    await addMove("bridging");
    reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 1, wstETH: 2 });
    await poll();
    expect((await db.select().from(schema.deposits)).map((d) => d.asset)).toEqual(["wstETH"]);
  });
});
