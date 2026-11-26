"use client";
import { useState } from "react";
import { Panel } from "@/components/common";
import { FieldMessage } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PausedTag } from "./PausedTag";
import { levelErrors, statusLabel, type HealthStatus, type Levels } from "@/lib/loan-math";

export type LevelsLoan = { id: string; lender: string; asset: string; healthFactor: number | null; status: HealthStatus; levels: Levels };
type Key = "warn" | "act";
type Msg = { tone: "error" | "success"; text: string; fields: Key[] };

/** Settings: Watch and At-risk levels per loan (r16, r24). Saves on blur or Enter; nothing is saved while a value is invalid. */
export function LevelsPanel({ loans, onSave, paused }: { loans: LevelsLoan[]; onSave: (loanId: string, warn: string, act: string) => Promise<string>; paused?: boolean }) {
  const [draft, setDraft] = useState<Record<string, Record<Key, string>>>({});
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const clear = (id: string) => setMsg(({ [id]: _, ...rest }) => rest);

  const edit = (l: LevelsLoan, key: Key, v: string) => {
    setDraft((d) => ({ ...d, [l.id]: { ...{ warn: String(l.levels.warn), act: String(l.levels.act) }, ...d[l.id], [key]: v } }));
    clear(l.id);
  };
  const commit = async (l: LevelsLoan) => {
    const d = draft[l.id];
    if (!d) return;
    const errs = levelErrors(d.warn, d.act);
    const fields = (["warn", "act"] as const).filter((k) => errs[k]);
    if (fields.length) {
      // The invalid value stays visible, so the row says what is wrong and that it was not saved.
      setMsg((m) => ({ ...m, [l.id]: { tone: "error", text: `${errs[fields[0]]} Not saved.`, fields } }));
      return;
    }
    setDraft(({ [l.id]: _, ...rest }) => rest);
    if (Number(d.warn) === l.levels.warn && Number(d.act) === l.levels.act) return clear(l.id);
    try {
      const text = await onSave(l.id, d.warn, d.act);
      setMsg((m) => ({ ...m, [l.id]: { tone: "success", text, fields: [] } }));
    } catch (e) {
      setDraft((x) => ({ ...x, [l.id]: d }));
      setMsg((m) => ({ ...m, [l.id]: { tone: "error", text: `${e instanceof Error ? e.message : "Could not save."} Not saved.`, fields: [] } }));
    }
  };

  return (
    <Panel title="Alert levels" action={paused ? <PausedTag /> : undefined}>
      <p className="text-sm text-muted-foreground">
        Health shows how safe a loan is: higher is safer, and below 1.0 the lender can sell your collateral. Below Watch you get an early heads-up; below At risk the agent suggests a fix. Use numbers from 1.0 to 5.0, with At risk lower than Watch.
      </p>
      {loans.length === 0 ? (
        <p className="text-sm text-muted-foreground">No loans in this Safe yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-3 text-xs text-muted-foreground">
            <span>Loan</span><span>Watch level</span><span>At-risk level</span>
          </div>
          {loans.map((l) => {
            const d = draft[l.id];
            const m = msg[l.id];
            const field = (key: Key, label: string) => (
              <Input
                aria-label={`${l.lender} ${label}`} aria-invalid={m?.fields.includes(key)} aria-describedby={`levels-${l.id}`}
                type="text" inputMode="decimal" value={d?.[key] ?? l.levels[key]}
                onChange={(e) => edit(l, key, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void commit(l); }}
              />
            );
            return (
              <div key={l.id} className="flex flex-col gap-1">
                <div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-3 text-sm" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) void commit(l); }}>
                  <span className="min-w-0">
                    <span className="block truncate">{l.lender} · {l.asset}</span>
                    <span className="block text-xs text-muted-foreground">{l.healthFactor === null ? "No debt" : `Health ${l.healthFactor.toFixed(2)} · ${statusLabel[l.status]}`}</span>
                  </span>
                  {field("warn", "watch level")}
                  {field("act", "at-risk level")}
                </div>
                <FieldMessage id={`levels-${l.id}`} tone={m?.tone}>{m?.text}</FieldMessage>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
