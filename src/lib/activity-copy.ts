import { fmt, usd } from "@/data";
import type { ReservePolicy } from "./loan-math";

const two = (n: number) => String(n).padStart(2, "0");

/** Seed rows keep their fixed text; new rows are relative for the first hour, then a clock time. */
export function timeLabel(e: { time?: string; at?: number }, now: number): string {
  if (e.at === undefined) return e.time ?? "";
  const min = Math.floor((now - e.at) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const d = new Date(e.at);
  return `Today ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function reserveUsedCopy(a: { usd: number; venue: string; supply: number; collAsset: string; repay: number; debtAsset: string; hfBefore: number; hfAfter: number }): { text: string; detail: string } {
  const parts = [a.supply > 0 && `Supplied ${fmt(a.supply, 2)} ${a.collAsset}`, a.repay > 0 && `${a.supply > 0 ? "repaid" : "Repaid"} ${fmt(a.repay)} ${a.debtAsset}`].filter(Boolean);
  return {
    text: `Used ${usd(a.usd)} from Reserve Safe on your ${a.venue} loan. Done without your signature.`,
    detail: `${parts.join(", ")} · health ${a.hfBefore.toFixed(2)} → ${a.hfAfter.toFixed(2)}`,
  };
}

/** Which level a health drop newly crossed. No row when the loan was already below it. */
export function crossedLevel(before: number, after: number, act: number, emergency: number): "emergency" | "action" | null {
  if (before >= emergency && after < emergency) return "emergency";
  if (before >= act && after < act) return "action";
  return null;
}

export function policyLogText(prev: ReservePolicy, next: ReservePolicy): string {
  const changed = [next.dailyCapUsd !== prev.dailyCapUsd && `limit to ${usd(next.dailyCapUsd)}`, next.emergencyHF !== prev.emergencyHF && `trigger to health ${next.emergencyHF.toFixed(2)}`].filter(Boolean);
  const sentences = [changed.length > 0 && `Changed reserve ${changed.join(" and ")}`, next.armed !== prev.armed && `Turned reserve ${next.armed ? "on" : "off"}`].filter(Boolean);
  return `${sentences.join(". ")}. Signed in Reserve Safe`;
}

/** What a proposal moves, for the log's detail line. Approval ("Allow …") steps are left out. */
export function proposalDetail(steps: string[]): string {
  return steps.filter((s) => !s.startsWith("Allow ")).join(" · ");
}

export const STILL_QUEUED = "Still in your Safe queue. Reject it in Safe too.";
