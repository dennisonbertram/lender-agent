// The cause line of an alert, from the loan's stored snapshots only (G1: never from the model).
export type SnapPoint = { at: Date; price: number | null; debt: number; /** Borrow rate per year (0..1) stored with the snapshot; null when unknown. */ rate?: number | null };

const WINDOW_MS = 24 * 3_600_000;
/** A price fall smaller than this is noise, not a cause. */
const MIN_FALL = 0.02;
/** A stored borrow rate that rose by at least this much (0.1 percentage point a year) is "the rate rose". */
const MIN_RATE_RISE = 0.001;

const duration = (ms: number): string => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)}h`);

/** "ETH fell 6% in 4h." or "The rate rose."; null when the snapshots show neither. `points` include the one at the crossing, oldest first. */
export function alertCause(asset: string, points: SnapPoint[], now: Date): string | null {
  const recent = points.filter((p) => now.getTime() - p.at.getTime() <= WINDOW_MS);
  if (recent.length < 2) return null;
  const last = recent[recent.length - 1];
  const priced = recent.filter((p) => p.price !== null && Number.isFinite(p.price) && (p.price as number) > 0);
  if (last.price && priced.length) {
    // The highest price in the window, first when tied: how far it fell, and since when.
    const high = priced.reduce((a, p) => ((p.price as number) > (a.price as number) ? p : a));
    const fall = 1 - last.price / (high.price as number);
    if (fall >= MIN_FALL) return `${asset} fell ${Math.round(fall * 100)}% in ${duration(last.at.getTime() - high.at.getTime())}.`;
  }
  const first = recent[0];
  // Only the stored rate says the rate rose: growing debt alone may be a new borrow or ordinary interest.
  if (first.rate != null && last.rate != null && last.rate - first.rate >= MIN_RATE_RISE) return "The rate rose.";
  return null;
}
