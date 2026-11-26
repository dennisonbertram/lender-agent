import { hfAfterDrop } from "@/lib/loan-math";

type Trend = { start: number; wave: number };

/**
 * 31 sample points, day -30..0. Days -30..-1 run from trend.start to `base` (health at base prices),
 * so a Simulate changes only day 0, which is the live value `now`. Empty without a trend or a finite value.
 */
export function hfHistory(trend: Trend | undefined, base: number, now: number): { day: number; hf: number }[] {
  if (!trend || !Number.isFinite(base) || !Number.isFinite(now)) return [];
  return Array.from({ length: 31 }, (_, i) => {
    const k = i / 30;
    const v = i === 30 ? now : trend.start + (base - trend.start) * k + trend.wave * Math.sin(i * 0.9) * (1 - k * 0.5);
    return { day: i - 30, hf: Number(v.toFixed(3)) };
  });
}

/**
 * Health factor against collateral price, falling from `price`. The range scales with risk (1.5x the
 * fall that reaches liquidation, within 10%..95%). The line stops (null) below the liquidation price.
 * Null when hf <= 1 or there is no debt.
 */
export function priceDropSeries(price: number, hf: number) {
  if (!Number.isFinite(hf) || hf <= 1) return null;
  const low = price * (1 - Math.min(0.95, Math.max(0.1, 1.5 * (1 - 1 / hf))));
  const liq = price / hf;
  const prices = Array.from({ length: 13 }, (_, i) => price - ((price - low) * i) / 12);
  const points = [...prices, liq]
    .sort((a, b) => b - a)
    .map((p) => ({ price: p, hf: p >= liq - 1e-9 ? Number(hfAfterDrop(hf, 1 - p / price).toFixed(3)) : null }));
  return { points, liq, low };
}

/** Screen-reader summary of the 30-day health factor chart. */
export const historyLabel = (hf: number, minHf: number, t: { warn: number; act: number }) =>
  `Health factor ${hf.toFixed(2)} now, lowest ${minHf.toFixed(2)} in 30 days. Warning at ${t.warn}, action at ${t.act}, liquidated below 1.0.`;
