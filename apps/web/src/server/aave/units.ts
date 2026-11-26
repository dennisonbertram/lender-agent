// Number → integer token units at the builder boundary. The domain library plans in plain numbers;
// calldata needs integers, rounded in the user's favour: borrow and withdraw round down (never
// more than asked), repay and supply-needed round up (never short).
import { formatUnits } from "viem";

export type Rounding = "down" | "up";

/** The shortest decimal string of `n`, never in exponent form (so 0.1 is "0.1", not 0.1000000000000000055). */
function plain(n: number): string {
  const s = String(n);
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return s;
  const digits = m[1]! + (m[2] ?? "");
  const point = m[1]!.length + Number(m[3]); // position of the decimal point within `digits`
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function toUnits(amount: number, decimals: number, rounding: Rounding): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`invalid amount: ${amount}`);
  const [whole, frac = ""] = plain(amount).split(".");
  const kept = frac.slice(0, decimals).padEnd(decimals, "0");
  const dropped = frac.slice(decimals);
  let raw = BigInt(whole! + kept);
  if (rounding === "up" && /[1-9]/.test(dropped)) raw += 1n;
  return raw;
}

export const fromUnits = (raw: bigint, decimals: number): number => Number(formatUnits(raw, decimals));

/** Borrow and withdraw: round down. */
export const unitsDown = (amount: number, decimals: number) => toUnits(amount, decimals, "down");
/** Repay and supply-needed: round up. */
export const unitsUp = (amount: number, decimals: number) => toUnits(amount, decimals, "up");
