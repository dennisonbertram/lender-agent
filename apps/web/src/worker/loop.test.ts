import { desc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createFixtureReader } from "@/server/chain/fixture";
import { schema } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";
import type { Job } from "./jobs";
import { monitorJob } from "./jobs";
import { runDueJobs } from "./loop";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const quiet = () => {};

async function setup() {
  return { db: await createTestDb(), reader: createFixtureReader() };
}

describe("runDueJobs", () => {
  it("two workers, one due job: it runs once", async () => {
    const { db, reader } = await setup();
    let runs = 0;
    const job: Job = { name: "j", intervalMs: 60_000, run: async () => { runs++; await new Promise((r) => setTimeout(r, 20)); } };
    await Promise.all(["A", "B"].map((w) => runDueJobs({ db, reader, workerId: w, now: t0, jobs: [job], log: quiet })));
    expect(runs).toBe(1);
    expect(await db.select().from(schema.workerTicks)).toHaveLength(1);
  });

  it("respects the schedule", async () => {
    const { db, reader } = await setup();
    let runs = 0;
    const job: Job = { name: "j", intervalMs: 60_000, run: async () => { runs++; } };
    const run = (now: Date) => runDueJobs({ db, reader, workerId: "A", now, jobs: [job], log: quiet });
    await run(t0);
    await run(at(59_000));
    expect(runs).toBe(1);
    await run(at(60_000));
    expect(runs).toBe(2);
  });

  it("a throwing job records a failed tick and does not stop the next job or tick", async () => {
    const { db, reader } = await setup();
    const logged: string[] = [];
    let ok = 0;
    const bad: Job = { name: "bad", intervalMs: 1000, run: async () => { throw new Error("rpc down"); } };
    const good: Job = { name: "good", intervalMs: 1000, run: async () => { ok++; } };
    const first = await runDueJobs({ db, reader, workerId: "A", now: t0, jobs: [bad, good], log: (m) => logged.push(m) });
    expect(first.map((r) => r.status)).toEqual(["failed", "ok"]);
    await runDueJobs({ db, reader, workerId: "A", now: at(2000), jobs: [bad, good], log: quiet });
    expect(ok).toBe(2);
    const ticks = await db.select().from(schema.workerTicks).orderBy(desc(schema.workerTicks.id));
    expect(ticks.filter((t) => t.job === "bad" && !t.ok && t.error === "rpc down")).toHaveLength(2);
    expect(logged.some((m) => m.includes("bad"))).toBe(true);
  });

  it("monitor stores a snapshot for each agent-enabled Safe with a position", async () => {
    const { db, reader } = await setup();
    const safe = "0x00000000000000000000000000000000000000aa" as const;
    const [row] = await db.insert(schema.safes).values({ address: safe, name: "S" }).returning();
    await db.insert(schema.safeNetworks).values({ safeId: row!.id, chainId: 8453, agentAdded: true });
    reader.setPosition(8453, safe, {
      chainId: 8453, safe, lender: "aave-v3", id: `8453:${safe}:aave-v3`,
      collateral: [{ asset: "WETH", token: "0x4200000000000000000000000000000000000006", amount: 1, usd: 3000 }],
      debt: [{ asset: "USDC", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 1000, usd: 1000 }],
      healthFactor: 2.5, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 1n,
    });
    const res = await runDueJobs({ db, reader, workerId: "A", now: t0, jobs: [monitorJob], log: quiet });
    expect(res[0]!.status).toBe("ok");
    const snaps = await db.select().from(schema.snapshots);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ health: "2.5", debt: "1000", collateral: "3000", chainId: 8453 });
  });
});
