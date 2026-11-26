// The words of the standing rule (BP-25), after the mockup's `standingRuleNote` (r16): four states, and the
// rule's effect named the same way in Settings and on the alert.
export type RuleOption = "coll" | "repay" | "both";
export const RULE_OPTIONS: readonly RuleOption[] = ["coll", "repay", "both"];

/** Short name of the pre-chosen fix, for Activity and the Settings choice. */
export const ruleOptionName = (o: RuleOption): string => (o === "coll" ? "add collateral" : o === "repay" ? "repay with stablecoin" : "half collateral, half repay");

const drafts = (o: RuleOption): string =>
  o === "coll" ? "adding collateral from this Safe" : o === "repay" ? "a repayment from this Safe's stablecoins" : "half collateral and half repayment from this Safe";

export function ruleNote(p: { lender: string; option: RuleOption; agentActive: boolean; enabled: boolean; belowNow: boolean }): string {
  if (!p.agentActive) return "The agent is not added to this Safe, so it cannot draft anything. Add it under Lender agent.";
  if (!p.enabled) return `Off. When ${p.lender} drops below its At-risk level, the agent alerts you and suggests a fix.`;
  const base = `On. When ${p.lender} drops below its At-risk level, the agent drafts ${drafts(p.option)} to reach your Watch level and puts it in the alert. Nothing is sent to your Safe until you press Send to Safe, and you still sign in Safe. If this Safe cannot fund it, the rule does nothing and the alert says why.`;
  return p.belowNow ? `${base} ${p.lender} is already below it, so the rule starts with the next drop.` : base;
}

/** The alert's line when the rule drafted the fix: it waits for the owner's Send to Safe. */
export const ruleDraftedLine = (title: string): string =>
  `Your standing rule drafted this fix: ${title.toLowerCase()}. Nothing is sent to your Safe until you press Send to Safe.`;

/** The alert's line when the rule could not act. */
export const ruleNothingLine = (reason: string): string => `Your standing rule did nothing: ${reason.replace(/\.$/, "")}. Nothing was drafted.`;
