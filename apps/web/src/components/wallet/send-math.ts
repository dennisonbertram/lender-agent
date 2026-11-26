import { formatUnits, parseUnits } from "viem";
import { ETH_GAS_RESERVE, type SendAsset } from "./tokens";

/** The most that can be sent: the balance, minus the gas reserve for ETH. */
export const maxSendable = (a: SendAsset, balance: bigint): bigint => {
  const m = a.address ? balance : balance - ETH_GAS_RESERVE;
  return m > 0n ? m : 0n;
};

export const formatAmount = (value: bigint, decimals: number): string => {
  const s = formatUnits(value, decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, 6).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
};

/** Parses the typed amount. `error` is plain text for the owner; `value` is set only when sendable. */
export function checkAmount(text: string, a: SendAsset, balance: bigint): { value?: bigint; error?: string } {
  const t = text.trim();
  if (!t) return {};
  if (!/^\d*\.?\d*$/.test(t) || t === ".") return { error: "Enter a number, like 0.1." };
  let value: bigint;
  try { value = parseUnits(t, a.decimals); } catch { return { error: "Enter a number, like 0.1." }; }
  if (value <= 0n) return { error: "Enter an amount above 0." };
  const max = maxSendable(a, balance);
  if (value > max) {
    return { error: !a.address && value <= balance ? "That would leave too little ETH for the network fee." : `You only have ${formatAmount(balance, a.decimals)} ${a.symbol}.` };
  }
  return { value };
}

export const isRejection = (e: unknown): boolean => {
  const x = e as { name?: string; code?: number; message?: string; cause?: unknown } | null;
  if (!x) return false;
  return x.name === "UserRejectedRequestError" || x.code === 4001 || /user (rejected|denied|cancel)/i.test(x.message ?? "") || (x.cause ? isRejection(x.cause) : false);
};
