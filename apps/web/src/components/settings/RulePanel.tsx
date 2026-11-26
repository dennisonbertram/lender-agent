"use client";
// Settings: the standing rule per loan (BP-25, r16). Pick the fix the agent drafts when the loan crosses
// its At-risk level; the note under each loan says what the rule does now. The agent only proposes.
import { useState } from "react";
import { Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { PausedTag } from "./PausedTag";
import type { RuleOption, RulePanelLoan } from "@/server/rules";

const CHOICES: { value: RuleOption; label: string }[] = [
  { value: "coll", label: "Add collateral" },
  { value: "repay", label: "Repay with stablecoin" },
  { value: "both", label: "Half of each" },
];

export type RulePanelProps = {
  loans: RulePanelLoan[];
  onSave: (loanId: string, option: RuleOption, enabled: boolean) => Promise<void>;
  onDelete: (loanId: string) => Promise<void>;
  /** The agent is not on this Safe: rules are kept but do nothing. */
  paused?: boolean;
};

export function RulePanel({ loans, onSave, onDelete, paused }: RulePanelProps) {
  const [error, setError] = useState<Record<string, string>>({});
  const run = async (id: string, fn: () => Promise<void>) => {
    setError(({ [id]: _, ...rest }) => rest);
    try { await fn(); } catch (e) { setError((m) => ({ ...m, [id]: `${e instanceof Error ? e.message : "Could not save."} Not saved.` })); }
  };
  return (
    <Panel title="Standing rules" action={paused ? <PausedTag /> : undefined}>
      <p className="text-sm text-muted-foreground">
        Pick the fix you want when a loan falls below its At-risk level. The agent drafts it in the alert. Nothing is sent to your Safe until you press Send to Safe, and you still sign in Safe.
      </p>
      {loans.length === 0 ? (
        <p className="text-sm text-muted-foreground">No loans in this Safe yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {loans.map((l) => (
            <li key={l.loanId} className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0 truncate">{l.lender} · {l.asset}</span>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`${l.lender} rule`} className="h-8 rounded-md border bg-background px-2 text-sm" value={l.rule?.option ?? ""}
                    onChange={(e) => void run(l.loanId, () => onSave(l.loanId, e.target.value as RuleOption, true))}
                  >
                    <option value="" disabled>No rule</option>
                    {CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  {l.rule && (
                    <>
                      <Switch checked={l.rule.enabled} onCheckedChange={(on) => void run(l.loanId, () => onSave(l.loanId, l.rule!.option, on))} aria-label={`${l.lender} rule on`} aria-describedby={`rule-${l.loanId}-note`} />
                      <Button size="xs" variant="ghost" onClick={() => void run(l.loanId, () => onDelete(l.loanId))}>Delete rule</Button>
                    </>
                  )}
                </div>
              </div>
              <span id={`rule-${l.loanId}-note`} className="text-xs text-muted-foreground">{l.note}</span>
              <FieldMessage id={`rule-${l.loanId}-error`} tone="error">{error[l.loanId]}</FieldMessage>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
