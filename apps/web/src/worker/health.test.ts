import { describe, expect, it } from "vitest";
import { schema } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";
import { checkWorkerHealth } from "./health";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const LIMIT = 15 * 60_000;
const tick = (db: Awaited<ReturnType<typeof createTestDb>>, when: Date, ok = true) =>
  db.insert(schema.workerTicks).values({ job: "monitor", workerId: "A", startedAt: when, finishedAt: when, ok });

describe("checkWorkerHealth", () => {
  it("is watching with a recent successful monitor tick and raises nothing", async () => {
    const db = await createTestDb();
    await tick(db, t0);
    const h = await checkWorkerHealth(db, { now: at(60_000), limitMs: LIMIT });
    expect(h).toEqual({ watching: true, lastOkAt: t0 });
    expect(await db.select().from(schema.operatorAlerts)).toHaveLength(0);
  });

  it("stalled: raises one open alert (not a duplicate), then resolves when ticks resume", async () => {
    const db = await createTestDb();
    await tick(db, t0);
    await tick(db, at(1000), false); // failed ticks do not count
    const late = at(LIMIT + 1000);
    expect((await checkWorkerHealth(db, { now: late, limitMs: LIMIT })).watching).toBe(false);
    expect((await checkWorkerHealth(db, { now: at(LIMIT + 5000), limitMs: LIMIT })).watching).toBe(false);
    let alerts = await db.select().from(schema.operatorAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "worker_stalled", resolvedAt: null });

    await tick(db, at(LIMIT + 10_000));
    const h = await checkWorkerHealth(db, { now: at(LIMIT + 11_000), limitMs: LIMIT });
    expect(h.watching).toBe(true);
    alerts = await db.select().from(schema.operatorAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resolvedAt).not.toBeNull();
  });

  it("never ran: not watching", async () => {
    const db = await createTestDb();
    expect(await checkWorkerHealth(db, { now: t0, limitMs: LIMIT })).toEqual({ watching: false, lastOkAt: null });
  });
});
