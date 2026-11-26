import { useState } from "react";
import { AGENT_ADDRESS, NETWORKS, loanHF, networkName, usd, type SafeNetwork } from "@/data";
import { networksLabel } from "@/lib/networks";
import { useApp, useStatus } from "@/store";
import { Panel, PageHeader, AddAgentButton, useSigning, statusLabel } from "@/components/common";
import { Spinner } from "@/components/ui/spinner";
import { levelErrors, levelsOf, parseLevels } from "@/lib/loan-math";
import { levelsSavedText, standingRuleNote } from "@/lib/settings-copy";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function Settings() {
  const { safe, loans, thresholds, setThresholds, rules, setRules, proposerActive, removeProposer, theme, setTheme, reset, loadSampleLoans, sampleLoaded } = useApp();
  const status = useStatus();
  const belowVenues = loans.filter((l) => ["risk", "liquidatable"].includes(status(l))).map((l) => l.venue);
  const [confirm, setConfirm] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [draft, setDraft] = useState<Record<string, { warn: string; act: string }>>({});
  type LevelKey = "warn" | "act";
  const [msg, setMsg] = useState<Record<string, { tone: "error" | "success"; text: string; fields: LevelKey[] }>>({});
  const clearMsg = (id: string) => setMsg(({ [id]: _, ...rest }) => rest);
  const [removing, startRemove] = useSigning(() => { removeProposer(); setConfirm(false); }, safe.id);

  const edit = (id: string, key: "warn" | "act", v: string) => {
    const cur = draft[id] ?? { warn: String(levelsOf(thresholds, id).warn), act: String(levelsOf(thresholds, id).act) };
    setDraft((d) => ({ ...d, [id]: { ...cur, [key]: v } }));
    clearMsg(id);
  };
  const blur = (id: string) => {
    const d = draft[id];
    if (!d) return;
    const errs = levelErrors(d.warn, d.act);
    const fields = (["warn", "act"] as const).filter((k) => errs[k]);
    if (fields.length) {
      // The invalid value stays visible, so the row says what is wrong and that it was not saved.
      setMsg((m) => ({ ...m, [id]: { tone: "error", text: `${errs[fields[0]]} Not saved.`, fields } }));
      return;
    }
    setDraft(({ [id]: _, ...rest }) => rest);
    const loan = loans.find((l) => l.id === id)!;
    const before = levelsOf(thresholds, id);
    const after = parseLevels(d.warn, d.act)!;
    if (after.warn === before.warn && after.act === before.act) return clearMsg(id);
    setThresholds((t) => ({ ...t, [id]: after }));
    setMsg((m) => ({ ...m, [id]: { tone: "success", text: levelsSavedText(loan.venue, loanHF(loan), before, after), fields: [] } }));
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Settings" />

      <Panel title="Alert levels">
        <p className="text-sm text-muted-foreground">
          Health factor shows how safe a loan is. Higher is safer. Below 1.0 the lender can sell your collateral (liquidation). Below the Watch level, a loan shows Watch. Below the At-risk level, it shows At risk and the agent suggests a fix. Both levels are between 1.0 and 5.0, and the At-risk level is lower.
        </p>
        {loans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No loans in this Safe yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-3 text-xs text-muted-foreground">
              <span>Loan</span><span>Watch level</span><span>At-risk level</span>
            </div>
            {loans.map((l) => {
              const t = levelsOf(thresholds, l.id);
              const d = draft[l.id];
              const m = msg[l.id];
              return (
                <div key={l.id} className="flex flex-col gap-1">
                  <div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-3 text-sm" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) blur(l.id); }}>
                    <span className="min-w-0">
                      <span className="block truncate">{l.venue} · {l.collAsset}</span>
                      <span className="block text-xs text-muted-foreground">{Number.isFinite(loanHF(l)) ? `Health ${loanHF(l).toFixed(2)} · ${statusLabel[status(l)]}` : "No debt"}</span>
                    </span>
                    <Input aria-label={`${l.venue} watch level`} aria-invalid={m?.fields.includes("warn")} aria-describedby={`levels-${l.id}`} type="text" inputMode="decimal" value={d?.warn ?? t.warn} onChange={(e) => edit(l.id, "warn", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") blur(l.id); }} />
                    <Input aria-label={`${l.venue} at-risk level`} aria-invalid={m?.fields.includes("act")} aria-describedby={`levels-${l.id}`} type="text" inputMode="decimal" value={d?.act ?? t.act} onChange={(e) => edit(l.id, "act", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") blur(l.id); }} />
                  </div>
                  <FieldMessage id={`levels-${l.id}`} tone={m?.tone}>{m?.text}</FieldMessage>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Standing rules">
        <ul className="flex flex-col gap-2">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3 text-sm">
              <span className="min-w-0">
                {r.text}
                <span id={`rule-${r.id}-note`} className="block text-xs text-muted-foreground">{standingRuleNote(r.on, proposerActive, belowVenues)}</span>
              </span>
              <Switch checked={r.on} onCheckedChange={(on) => setRules((x) => x.map((y) => (y.id === r.id ? { ...y, on } : y)))} aria-label={r.text} aria-describedby={`rule-${r.id}-note`} />
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Lender agent">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            <div>Lender agent <span className="text-muted-foreground">· {AGENT_ADDRESS}</span></div>
            <div className="text-xs text-muted-foreground">
              {proposerActive ? `Can suggest transactions on ${networksLabel(safe.networks.filter((n) => n.agent).map((n) => n.id))} (Safe calls this a proposer). Cannot sign or move money.` : "Not added to this Safe."}
            </div>
          </div>
          {proposerActive ? (
            <Button variant="destructive" onClick={() => setConfirm(true)}>Remove agent</Button>
          ) : (
            <AddAgentButton />
          )}
        </div>
      </Panel>

      <Panel title="Networks">
        <p className="text-sm text-muted-foreground">{safe.name} has the same address on every network. It is set up on a network the first time you use it there. The agent needs one signature on each network where it should suggest transactions.</p>
        <ul className="flex flex-col gap-2">
          {safe.networks.map((n) => <NetworkRow key={n.id} n={n} />)}
        </ul>
        <AddNetwork />
      </Panel>

      <Panel title="App">
        <label className="flex items-center justify-between gap-3 text-sm">
          Dark theme
          <Switch checked={theme === "dark"} onCheckedChange={(on) => setTheme(on ? "dark" : "light")} />
        </label>
      </Panel>

      <Panel title="Demo">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">{sampleLoaded ? "Sample loans are loaded." : "Add three sample loans, an alert and past activity."}</span>
          <Button variant="outline" disabled={sampleLoaded} onClick={loadSampleLoans}>Load sample loans</Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Start again from onboarding.</span>
          <Button variant="outline" onClick={() => setConfirmReset(true)}>Reset demo</Button>
        </div>
      </Panel>

      <AlertDialog open={confirm} onOpenChange={(o) => { if (!removing) setConfirm(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the Lender agent from this Safe?</AlertDialogTitle>
            <AlertDialogDescription>It can no longer suggest transactions or send alerts for this Safe. Anything already waiting stays in Safe until you reject it. You can add it back any time.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={removing} onClick={(e) => { e.preventDefault(); startRemove(); }}>
              {removing ? <><Spinner /> Waiting for your signature</> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the demo?</AlertDialogTitle>
            <AlertDialogDescription>This clears every change and goes back to the first screen.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={reset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NetworkRow({ n }: { n: SafeNetwork }) {
  const { safe, setAgentOn } = useApp();
  const [signing, start] = useSigning(() => setAgentOn(n.id, !n.agent), safe.id + n.id);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-muted p-3 text-sm">
      <div className="min-w-0">
        <div className="font-medium">{networkName(n.id)}</div>
        <div className="text-xs text-muted-foreground">{n.deployed ? "Set up" : "Ready, set up automatically on first use (free)"} · Agent {n.agent ? "on" : "off"}</div>
      </div>
      <Button variant={n.agent ? "outline" : "default"} size="sm" disabled={signing} onClick={start} aria-label={`${n.agent ? "Remove agent from" : "Add agent to"} ${networkName(n.id)}`}>
        {signing ? <><Spinner /> Waiting for your signature</> : n.agent ? "Remove agent" : "Add agent"}
      </Button>
    </li>
  );
}

function AddNetwork() {
  const { safe, addSafeNetwork } = useApp();
  const free = NETWORKS.filter((n) => !safe.networks.some((x) => x.id === n.id));
  const [pick, setPick] = useState(free[0]?.id);
  const choice = free.find((n) => n.id === pick) ?? free[0];
  const [signing, start] = useSigning(() => { if (choice) addSafeNetwork(choice.id, true); }, safe.id);
  if (!choice) return <p className="text-sm text-muted-foreground">Every network is added.</p>;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Add a network
        <NativeSelect value={choice.id} disabled={signing} onChange={(e) => setPick(e.target.value as typeof choice.id)}>
          {free.map((n) => <NativeSelectOption key={n.id} value={n.id}>{n.name} · free to set up</NativeSelectOption>)}
        </NativeSelect>
      </label>
      <Button disabled={signing} onClick={start}>{signing ? <><Spinner /> Waiting for your signature</> : "Add network"}</Button>
    </div>
  );
}
