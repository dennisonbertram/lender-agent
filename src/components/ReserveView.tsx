import { useState } from "react";
import { PenLine, PiggyBank, TriangleAlert } from "lucide-react";
import { PRICES, RESERVE, RESERVE_BALANCES, TREASURY, fmt, usd, type Asset, type Stable } from "@/data";
import { timeLabel } from "@/lib/activity-copy";
import { capResetLabel, reserveStatus } from "@/lib/reserve";
import { parseNumber } from "@/lib/loan-math";
import { policyErrors, reservePolicyCopy } from "@/lib/reserve-policy";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { ActionFooter, Panel, PageHeader, CanCannot } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export const PROPOSER_CAN = ["See your balances", "Suggest transactions for you to sign"];
export const PROPOSER_CANNOT = ["Sign or approve anything", "Move money on its own"];

const bannerStyle = { success: "bg-success/10 ring-1 ring-success/30", warning: "bg-warning/10 ring-1 ring-warning/30", muted: "bg-muted text-muted-foreground" } as const;

export function ReserveView() {
  const { reserveLinked, linkReserve, reserveBal, policy, applyPolicy, activity, safe } = useApp();
  const [armed, setArmed] = useState(policy.armed);
  const [hf, setHf] = useState(String(policy.emergencyHF));
  const [cap, setCap] = useState(usd(policy.dailyCapUsd));

  const policyCopy = reservePolicyCopy(policy, TREASURY.name);
  const sampleAssets = (Object.keys(RESERVE_BALANCES) as (Asset | Stable)[]).filter((a) => RESERVE_BALANCES[a] > 0);
  const sample = sampleAssets.map((a) => `${fmt(RESERVE_BALANCES[a])} ${a}`).join(", ");
  const sampleTotal = sampleAssets.reduce((t, a) => t + RESERVE_BALANCES[a] * PRICES[a], 0);

  if (!reserveLinked) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <PageHeader title="Reserve" sub="Optional. The one place the agent acts without your signature." />
        <Panel title="Reserve Safe">
          <p className="text-sm text-muted-foreground">A small second Safe holds money the agent can use, without asking you, to stop a loan being liquidated. You choose how much it can use per day.</p>
          <CanCannot {...policyCopy} />
          <p className="text-xs text-muted-foreground">The reserve works on Ethereum only, for {TREASURY.name} loans on Ethereum.</p>
          <p className="text-xs text-muted-foreground">Example reserve: {sample} ({usd(sampleTotal)}).</p>
          {safe.id === TREASURY.id ? (
            <>
              <Button className="self-start" onClick={linkReserve}>Link Reserve Safe</Button>
              <p className="text-xs text-muted-foreground">You approve these limits with one signature in the Reserve Safe.</p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">The reserve is available for {TREASURY.name} only.</p>
          )}
        </Panel>
      </div>
    );
  }

  const assets = (Object.keys(reserveBal) as (Asset | Stable)[]).filter((a) => reserveBal[a] > 0);
  const total = assets.reduce((t, a) => t + reserveBal[a] * PRICES[a], 0);
  const dirty = armed !== policy.armed || parseNumber(hf) !== policy.emergencyHF || parseNumber(cap) !== policy.dailyCapUsd;
  const errs = policyErrors(hf, cap, total);
  const copy = reservePolicyCopy({ emergencyHF: errs.hf ? policy.emergencyHF : parseNumber(hf)!, dailyCapUsd: errs.cap ? policy.dailyCapUsd : parseNumber(cap)! }, TREASURY.name);
  const valid = !errs.hf && !errs.cap;
  const onlyArmed = armed !== policy.armed && parseNumber(hf) === policy.emergencyHF && parseNumber(cap) === policy.dailyCapUsd;
  const signLabel = onlyArmed ? (armed ? "Sign to turn on" : "Sign to turn off") : "Sign policy change";
  const resetLabel = capResetLabel(policy.usedSince, Date.now());
  const history = activity.filter((e) => e.kind === "reserve");
  const st = reserveStatus(policy, Date.now());
  const stuck = st.kind === "limitReached";
  const pct = Math.min(100, (policy.usedUsd24h / policy.dailyCapUsd) * 100);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Reserve" sub={`${RESERVE.name} · ${RESERVE.address} · ${RESERVE.threshold} owner must sign · Ethereum only`} />

      <div className={cn("flex items-start gap-2 rounded-xl p-3 text-sm", bannerStyle[st.tone])}>
        {st.tone === "warning" ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /> : <PiggyBank className={cn("mt-0.5 size-4 shrink-0", st.tone === "success" && "text-success")} />}
        <span>{st.banner}</span>
      </div>

      <Panel title="Policy">
        <CanCannot {...copy} />
        <form
          noValidate className="contents"
          onSubmit={(e) => { e.preventDefault(); if (dirty && valid) applyPolicy({ armed, emergencyHF: parseNumber(hf)!, dailyCapUsd: parseNumber(cap)! }); }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3 text-sm sm:flex-col sm:items-start">
              <span>Agent can use reserve</span>
              <Switch checked={armed} onCheckedChange={setArmed} />
            </label>
            <Field label="Agent uses the reserve when health drops below" tone={errs.hf ? "error" : "hint"} message={errs.hf ?? "1.00 is liquidation. Use 1.02 to 2.00."}>
              {(p) => <Input {...p} type="text" inputMode="decimal" value={hf} onChange={(e) => setHf(e.target.value)} />}
            </Field>
            <Field
              label="Daily limit"
              tone={errs.cap ? "error" : "hint"}
              message={errs.cap ?? `The Reserve Safe holds ${usd(total)}.`}
            >
              {(p) => <Input {...p} type="text" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => { const n = parseNumber(cap); if (n !== null) setCap(usd(n)); }} />}
            </Field>
          </div>
          {dirty && (
            <ActionFooter
              label={
                <span className="flex items-start gap-2 text-sm">
                  <PenLine className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">Needs a Reserve Safe signature</span>
                </span>
              }
            >
              <Button type="button" variant="ghost" onClick={() => { setArmed(policy.armed); setHf(String(policy.emergencyHF)); setCap(usd(policy.dailyCapUsd)); }}>Discard</Button>
              <Button type="submit" disabled={!valid}>{signLabel}</Button>
            </ActionFooter>
          )}
        </form>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Balances" action={<span className="text-sm">{usd(total)}</span>}>
          <ul className="flex flex-col gap-2">
            {assets.map((a) => (
              <li key={a} className="flex items-center justify-between rounded-lg bg-muted p-3 text-sm">
                <span>{fmt(reserveBal[a], a === "ETH" ? 2 : 0)} {a}</span>
                <span className="text-muted-foreground">{usd(reserveBal[a] * PRICES[a])}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Daily limit">
          <div className="flex justify-between text-sm"><span>{usd(policy.usedUsd24h)} of {usd(policy.dailyCapUsd)} used today</span><span className="text-muted-foreground">{usd(Math.max(0, policy.dailyCapUsd - policy.usedUsd24h))} left</span></div>
          <div className="h-2 rounded-full bg-muted ring-1 ring-inset ring-edge"><div className={cn("h-2 rounded-full", stuck ? "bg-warning" : "bg-foreground")} style={{ width: `${pct}%` }} /></div>
          {resetLabel && <span className="text-xs text-muted-foreground">{resetLabel}</span>}
        </Panel>
      </div>

      <Panel title="Reserve history">
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reserve actions yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 rounded-lg bg-muted p-3 text-sm">
                <span>{e.text}</span>
                <span className="text-xs text-muted-foreground">{e.actor} · {timeLabel(e, Date.now())}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
