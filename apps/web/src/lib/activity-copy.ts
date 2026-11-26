import { fmt, usd } from "@/lib/format";
import type { ReservePolicy } from "./loan-math";
import type { ActivityEvent } from "./types";

const two = (n: number) => String(n).padStart(2, "0");
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function timeLabel(e: Pick<ActivityEvent, "at">, now: number): string {
  const elapsed = now - e.at;
  const min = Math.floor(elapsed / 60_000);
  if (elapsed >= 0 && min < 60) return min < 1 ? "Just now" : `${min} min ago`;
  const d = new Date(e.at);
  const today = new Date(now);
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (sameDay(d, today)) return `Today ${clock}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${clock}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${clock}`;
}

/** Rows are stored in the second person ("You added …"). For a viewer who is not the actor, drop the "You". */
export function neutralText(text: string): string {
  const m = text.match(/^You ([a-z]+)(.*)$/s);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)}${m[2]}` : text;
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
