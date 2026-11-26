// Monitoring M5: the relayer balance is low, so new users' setup would fail. One open operator alert at a time.
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@/server/db/client";
import type { Job } from "@/worker/jobs";
import { relayerFromEnv, type Relayer } from "./relayer";
import { DEFAULT_BUDGET, SAFE_NETWORKS } from "@/lib/safe-create";

export const RELAYER_BALANCE_LOW = "relayer_balance_low";
/** Alert when the relayer holds less than this on a sponsored network (wei). About 0.003 ETH is many deployments on an L2. */
export const MIN_RELAYER_BALANCE_WEI = 3_000_000_000_000_000n;

/** Raise one open alert per low network, resolve those that recovered. Returns the low network ids. */
export async function checkRelayerBalance(db: Db, relayer: Relayer, p: { chainIds: number[]; minWei: bigint; now?: Date }): Promise<number[]> {
  if (relayer.address === null) return []; // not configured: setup falls back to the user paying, nothing to top up
  const low: number[] = [];
  for (const chainId of p.chainIds) {
    const kind = `${RELAYER_BALANCE_LOW}:${chainId}`;
    const balance = await relayer.balance(chainId);
    if (balance < p.minWei) {
      low.push(chainId);
      const name = SAFE_NETWORKS.find((n) => n.chainId === chainId)?.name ?? String(chainId);
      await db.execute(sql`
        INSERT INTO operator_alerts (kind, text)
        SELECT ${kind}, ${`Relayer balance on ${name} is ${balance} wei, under the ${p.minWei} wei limit. New Safes cannot be set up there.`}
        WHERE NOT EXISTS (SELECT 1 FROM operator_alerts WHERE kind = ${kind} AND resolved_at IS NULL)`);
    } else {
      await db.update(schema.operatorAlerts).set({ resolvedAt: p.now ?? new Date() }).where(and(eq(schema.operatorAlerts.kind, kind), isNull(schema.operatorAlerts.resolvedAt)));
    }
  }
  return low;
}

/** Worker job: check the sponsored networks every 10 minutes. */
export const relayerBalanceJob: Job = {
  name: "relayer-balance",
  intervalMs: Number(process.env.RELAYER_BALANCE_INTERVAL_MS) || 10 * 60_000,
  async run({ db, now }) {
    await checkRelayerBalance(db, relayerFromEnv(), { chainIds: DEFAULT_BUDGET.chains, minWei: MIN_RELAYER_BALANCE_WEI, now });
  },
};
