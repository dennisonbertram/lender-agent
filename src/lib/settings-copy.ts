import { healthStatus, statusLabel, type Levels } from "./loan-math";

/** The line shown after alert levels are saved: what the loan shows now, so a relabel is never silent. */
export function levelsSavedText(venue: string, hf: number, before: Levels, after: Levels): string {
  if (!Number.isFinite(hf)) return `Saved. ${venue} has no debt, so it stays Healthy.`;
  const was = healthStatus(hf, before.warn, before.act);
  const now = healthStatus(hf, after.warn, after.act);
  const h = `(health ${hf.toFixed(2)})`;
  return was === now
    ? `Saved. ${venue} still shows ${statusLabel[now]} ${h}.`
    : `Saved. ${venue} now shows ${statusLabel[now]}, not ${statusLabel[was]} ${h}.`;
}

/** Says whether the standing rule is on and what it covers. */
export function standingRuleNote(on: boolean, agentActive: boolean, belowVenues: string[]): string {
  if (!agentActive) return "The agent is not added to this Safe, so it cannot draft anything. Add it under Lender agent.";
  if (!on) return "Off. When a loan drops below its At-risk level, the agent alerts you and suggests a fix.";
  const base = "On. When a loan drops below its At-risk level, the agent drafts a repayment from this Safe's stablecoins. You still sign in Safe.";
  if (!belowVenues.length) return base;
  const names = belowVenues.length === 1 ? belowVenues[0] : `${belowVenues.slice(0, -1).join(", ")} and ${belowVenues[belowVenues.length - 1]}`;
  return `${base} ${names} ${belowVenues.length === 1 ? "is" : "are"} already below it, so the rule starts with the next drop.`;
}
