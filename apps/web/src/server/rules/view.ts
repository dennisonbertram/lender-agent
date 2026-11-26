import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { ruleRuns } from "@/server/db/schema";

/** What the standing rule did at one alert, for the alert card; null when it did not run. */
export async function ruleOfAlert(db: Db, alertId: number): Promise<{ outcome: "drafted" | "nothing"; line: string } | null> {
  const [r] = await db.select().from(ruleRuns).where(eq(ruleRuns.alertId, alertId));
  return r && r.outcome !== "running" ? { outcome: r.outcome as "drafted" | "nothing", line: r.line } : null;
}
