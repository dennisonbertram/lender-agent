// The Roles v2 allowance is lazy (M0-6): the stored balance does not change when the period passes, the
// refill is applied on the next use. The read-out computes it from timestamp, period, refill, maxRefill and balance.
export type RawAllowance = { refill: bigint; maxRefill: bigint; period: bigint; balance: bigint; timestamp: bigint };

export type AllowanceNow = {
  /** Raw units the executor may still request now. */
  left: bigint;
  /** The cap (maxRefill). */
  limit: bigint;
  /** Seconds until the next refill, or null when nothing is waiting to refill. */
  resetsInSec: number | null;
};

/** What `_accruedAllowance` of Roles v2 would give at block time `nowSec`. */
export function allowanceNow(a: RawAllowance, nowSec: number): AllowanceNow {
  const now = BigInt(nowSec);
  let balance = a.balance;
  let timestamp = a.timestamp;
  if (a.period > 0n && now >= timestamp + a.period) {
    const intervals = (now - timestamp) / a.period;
    if (balance < a.maxRefill) {
      balance += a.refill * intervals;
      if (balance > a.maxRefill) balance = a.maxRefill;
    }
    timestamp += intervals * a.period;
  }
  const waiting = a.period > 0n && balance < a.maxRefill && a.refill > 0n;
  return { left: balance, limit: a.maxRefill, resetsInSec: waiting ? Number(timestamp + a.period - now) : null };
}
