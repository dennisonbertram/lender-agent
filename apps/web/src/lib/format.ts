import type { Network, NetworkConfig } from "./types";

const fixed = (n: number, d: number) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * A token amount with `d` decimals. Below 1 (and not zero) it shows up to 4 significant digits without trailing zeros
 * (0.005, 0.0149, 0.1234), so a small deposit is never rounded into a different number. `d = 0` stays whole.
 */
export const fmt = (n: number, d = 0) => {
  if (d > 0 && n !== 0 && Math.abs(n) < 1) return n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 20 });
  return fixed(n, d);
};

/** Dollars keep their 0 or 2 decimals; the small-amount rule above is for token amounts only. */
export const usd = (n: number, d = 0) => `$${fixed(n, d)}`;

/** Whole dollars show no decimals, cents show two: the display rule for a USDC amount the owner typed. */
export const centDigits = (n: number): 0 | 2 => (Number.isInteger(n) ? 0 : 2);

export function networkName(id: Network, networks: readonly NetworkConfig[]): string {
  const network = networks.find((item) => item.id === id);
  if (!network) throw new Error(`Missing network configuration for ${id}`);
  return network.name;
}
