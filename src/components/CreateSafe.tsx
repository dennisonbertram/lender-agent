import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { NETWORKS, TREASURY, USER_FULL, networkName, type Network, type Safe } from "@/data";
import { shortAddress } from "@/lib/address";
import { approvalsHelp, approvalsLabel, approvalsSummary, defaultApprovals, ownerErrors } from "@/lib/owners";
import { createSafe, networkList, networksLabel, safeAddress } from "@/lib/networks";
import { useApp } from "@/store";
import { CanCannot, SelectedMark, StepBar, radioCard, useFocusOnChange } from "@/components/common";
import { PROPOSER_CAN, PROPOSER_CANNOT } from "@/components/ReserveView";
import { Button } from "@/components/ui/button";
import { Field, focusFirstInvalid } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";

const STEPS = ["Name", "Approvals", "Review"];
const ALL_NETWORKS = NETWORKS.map((n) => n.id);

/**
 * The one "Create a Safe" flow, used by onboarding and by Add a Safe: three short steps with defaults (Name, Approvals, Review).
 * A Safe gets one address that is the same on every network. Setup happens by itself the first time a network is used, and is free,
 * so networks stay behind "Choose networks" on the last step.
 */
export function CreateSafe({ onCreated, onCancel, embedded = false, onProgress }: {
  onCreated: (safe: Safe) => void;
  onCancel?: () => void;
  /** The parent draws the step bar and the page heading. */
  embedded?: boolean;
  /** Reports the current step and whether the Safe is being created, so the parent can draw the one step bar. */
  onProgress?: (p: { step: number; busy: boolean }) => void;
}) {
  const { safes } = useApp();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("My Safe");
  const [nameTouched, setNameTouched] = useState(false);
  const [team, setTeam] = useState(false);
  const [cosigners, setCosigners] = useState([""]);
  const [needed, setNeeded] = useState<number | null>(null);
  const [networks, setNetworks] = useState<Network[]>(ALL_NETWORKS);
  const [showNets, setShowNets] = useState(false);
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<"form" | "sign" | "deploy">("form");
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const head = useFocusOnChange<HTMLHeadingElement>(step);

  const owners = team ? [USER_FULL, ...cosigners.map((c) => c.trim())] : [USER_FULL];
  const sigs = team ? Math.min(needed ?? defaultApprovals(owners.length), owners.length) : 1;
  const ownerErrs = ownerErrors(owners);
  const nameErr = name.trim() === "";
  const ownersOk = ownerErrs.every((e) => !e);
  const chosen = ALL_NETWORKS.filter((id) => networks.includes(id));
  // Each created Safe gets its own salt (so its own address and id), whether or not the sample Treasury Safe is in the list.
  const salt = safes.filter((s) => s.id !== TREASURY.id).length + 1;
  const preview = safeAddress({ owners, threshold: sigs, salt });

  useEffect(() => { if (step === 0) nameRef.current?.select(); }, [step]);
  useEffect(() => { onProgress?.({ step, busy: phase !== "form" }); }, [step, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => {
    if (step === 0 && nameErr) { setNameTouched(true); return void requestAnimationFrame(() => focusFirstInvalid(formRef.current)); }
    if (step === 1 && !ownersOk) { setTried(true); return void requestAnimationFrame(() => focusFirstInvalid(formRef.current)); }
    if (step === 2) return chosen.length ? setPhase("sign") : void setTried(true);
    setStep(step + 1);
  };

  useEffect(() => {
    if (phase === "form") return;
    const t = setTimeout(() => {
      if (phase === "sign") return setPhase("deploy");
      onCreated(createSafe({ id: `safe-${salt}-${preview.slice(2, 6)}`, name: name.trim(), owners, threshold: sigs, salt, networks: chosen }));
    }, 1200);
    return () => clearTimeout(t);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = phase !== "form";
  const approvals = approvalsSummary(sigs, owners.length);
  const heading = (t: string) => embedded
    ? <h1 ref={head} tabIndex={-1} className="text-lg font-medium outline-none">{t}</h1>
    : <h2 ref={head} tabIndex={-1} className="text-base font-medium outline-none">{t}</h2>;

  return (
    <form ref={formRef} noValidate className="contents" onSubmit={(e) => { e.preventDefault(); next(); }}>
      {!embedded && <StepBar labels={STEPS} step={step} />}

      {step === 0 && (
        <>
          {heading("Name your Safe")}
          <Field label="Name" tone={(nameTouched || tried) && nameErr ? "error" : "hint"} message={(nameTouched || tried) && nameErr ? "Enter a name." : "A short name so you can tell your Safes apart."}>
            {(p) => <Input {...p} ref={nameRef} maxLength={30} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== "My Safe" && setNameTouched(true)} />}
          </Field>
        </>
      )}

      {step === 1 && (
        <>
          {heading("Who approves transactions?")}
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Who approves transactions</legend>
            {([[false, "Just me", "You approve everything. Simple to start; you can add people later."], [true, "Me and people I trust", "Co-signers approve with you."]] as const).map(([t, title, text]) => (
              <label key={title} className={radioCard(team === t)}>
                <input type="radio" className="sr-only" name="approvers" checked={team === t} onChange={() => setTeam(t)} />
                <span className="flex items-center justify-between text-sm font-medium">{title}<SelectedMark on={team === t} /></span>
                <span className="text-xs text-muted-foreground">{text}</span>
              </label>
            ))}
          {team && (
            <div className="ml-3 flex flex-col gap-1 border-l border-border pl-3">
              {cosigners.map((o, i) => (
                <Field key={i} label={`Co-signer ${i + 1}`} tone={(tried || o !== "") && ownerErrs[i + 1] ? "error" : "hint"} message={tried || o !== "" ? ownerErrs[i + 1] : undefined}>
                  {(p) => (
                    <div className="flex gap-2">
                      <Input {...p} value={o} placeholder="Co-signer address, e.g. 0x4a1c…9e2f" onChange={(e) => setCosigners(cosigners.map((x, j) => (j === i ? e.target.value : x)))} />
                      {cosigners.length > 1 && <Button type="button" variant="ghost" size="icon" aria-label={`Remove co-signer ${i + 1}`} onClick={() => setCosigners(cosigners.filter((_, j) => j !== i))}><X /></Button>}
                    </div>
                  )}
                </Field>
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setCosigners([...cosigners, ""])}><Plus /> Add another</Button>
              <Field label="Approvals needed" className="mt-1" message={approvalsHelp(sigs, owners.length)}>
                {(p) => (
                  <NativeSelect {...p} value={sigs} onChange={(e) => setNeeded(Number(e.target.value))}>
                    {owners.map((_, i) => <NativeSelectOption key={i} value={i + 1}>{approvalsLabel(i + 1, owners.length)}</NativeSelectOption>)}
                  </NativeSelect>
                )}
              </Field>
            </div>
          )}
          </fieldset>
        </>
      )}

      {step === 2 && (
        <>
          {heading("Review")}
          <div className="flex flex-col gap-1 rounded-xl bg-muted p-3 text-sm" aria-label="Summary">
            <span className="font-medium">{name.trim()}</span>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Owners and approvals</span>
              {!busy && <Button type="button" variant="link" size="inline" aria-label="Change owners and approvals" onClick={() => setStep(1)}>Change</Button>}
            </div>
            <ul className="grid grid-cols-[auto_1fr] gap-x-3">
              {owners.map((o, i) => (
                <li key={i} className="col-span-2 grid grid-cols-subgrid">
                  <span className="text-muted-foreground">{i === 0 ? "You" : `Co-signer ${i}`}</span>
                  <span title={o}>{shortAddress(o)}</span>
                </li>
              ))}
            </ul>
            <span>{approvals}</span>
            <span className="text-muted-foreground">{chosen.length === ALL_NETWORKS.length ? `Works on all ${NETWORKS.length} networks (blockchains such as Ethereum and Base), with one address on all of them. Setup is free.` : `Works on ${networkList(chosen)}, with the same address. Setup is free.`}</span>
          </div>
          {!busy && <Button type="button" variant="link" size="inline" className="self-start" aria-expanded={showNets} onClick={() => setShowNets(!showNets)}>Choose networks</Button>}
          {showNets && !busy && (
            <fieldset className="grid grid-cols-2 gap-1.5">
              <legend className="sr-only">Networks</legend>
              {NETWORKS.map((n) => {
                const on = networks.includes(n.id);
                return (
                  <label key={n.id} className={radioCard(on) + " flex-row items-center gap-3 p-2.5"}>
                    <input type="checkbox" className="size-4 accent-foreground" checked={on} onChange={() => setNetworks(on ? networks.filter((x) => x !== n.id) : [...networks, n.id])} />
                    <span className="text-sm">{n.name}</span>
                  </label>
                );
              })}
              {tried && chosen.length === 0 && <p role="alert" className="col-span-2 text-xs text-destructive">Pick at least one network.</p>}
            </fieldset>
          )}
        </>
      )}

      {busy ? (
        <div className="flex flex-col gap-2">
          <p role="status" className="flex items-center gap-2 text-sm"><Spinner /> {phase === "sign" ? `Confirm in your wallet to create ${name.trim()}. This sets up the Safe; it does not move money.` : `Creating ${name.trim()}…`}</p>
          {phase === "sign" && <Button size="lg" type="button" variant="ghost" onClick={() => setPhase("form")}>Cancel</Button>}
        </div>
      ) : (
        <div className="flex gap-2">
          {step > 0 ? <Button size="lg" type="button" variant="ghost" onClick={() => setStep(step - 1)}>Back</Button> : onCancel && <Button size="lg" type="button" variant="ghost" onClick={onCancel}>Back</Button>}
          <Button size="lg" type="submit" className="flex-1">{step === 2 ? "Create Safe" : "Next"}</Button>
        </div>
      )}
    </form>
  );
}

/** The agent step: one button adds the agent on every network. Your wallet asks for one signature per network, counted below the button. Calls `onSigned` when all are in. */
export function AgentSignatures({ safeName, address, networks, onSigned, onSkip }: { safeName: string; address?: string; networks: Network[]; onSigned: () => void; onSkip?: () => void }) {
  const [signed, setSigned] = useState(0);
  const [signing, setSigning] = useState(false);
  const many = networks.length > 1;
  useEffect(() => {
    if (!signing) return;
    const t = setTimeout(() => {
      if (signed + 1 >= networks.length) { setSigning(false); onSigned(); } else setSigned(signed + 1);
    }, many ? 600 : 1200);
    return () => clearTimeout(t);
  }, [signing, signed]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <p className="text-xs text-muted-foreground">{safeName}{address && ` · ${shortAddress(address)}`}. Safe calls this role a proposer. It is added on {networksLabel(networks)}.{many && " Your wallet asks you to confirm once per network."}</p>
      <CanCannot can={PROPOSER_CAN} cannot={PROPOSER_CANNOT} />
      <div className="flex flex-col gap-2">
        {signing && <p role="status" className="text-sm">Confirm in your wallet{many && `: ${networkName(networks[signed])}, ${signed + 1} of ${networks.length}.`}</p>}
        <Button size="lg" disabled={signing} onClick={() => setSigning(true)}>
          {signing ? <><Spinner /> Waiting for your wallet</> : "Add Lender agent"}
        </Button>
        {signing ? <Button size="lg" variant="ghost" onClick={() => { setSigning(false); setSigned(0); }}>Cancel</Button> : onSkip && <Button size="lg" variant="ghost" onClick={onSkip}>Not now</Button>}
      </div>
    </>
  );
}
