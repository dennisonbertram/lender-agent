import { hfAfterDrop } from "@/lib/loan-math";

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
