"use client";
import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { SelectedMark, StepBar, radioCard, useFocusOnChange } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, focusFirstInvalid } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { NetworkMark } from "@/components/ui/network-mark";
import { shortAddress } from "@/lib/address";
import { clearCreateProgress, clearPaymentAttempt, loadCreateProgress, markPaymentUnknown, recordPaidHash, saveCreateProgress } from "@/lib/create-progress";
import { approvalsHelp, approvalsLabel, approvalsSummary, defaultApprovals, ownerErrors } from "@/lib/owners";
import { DEFAULT_CREATE_CHAIN_IDS, ENABLED_CHAIN_IDS, MAX_OWNERS, NOT_SERVED_LINE, SAFE_NETWORKS, SERVED_CHAIN_IDS, safeNetworkName, setupFeeEstimate } from "@/lib/safe-create";
import { CREATE_ONBOARDING_STEPS } from "@/lib/step-bar";

const STEPS = CREATE_ONBOARDING_STEPS.slice(0, 3);

export type Draft = { name: string; cosigners: string[]; threshold: number; networks: number[] };
export type NetworkFee = { chainId: number; sponsored: boolean; cost: string };
/** `chainId`, `sponsored` and `cost` are the first network's; `networks` has one fee line per chosen network. */
export type Preview = { address: string; index: number; message: string; sponsored: boolean; cost: string; chainId: number; networks?: NetworkFee[] };
export type NetStatus = "waiting" | "setup" | "paying" | "done" | "failed";
const STATUS_TEXT: Record<NetStatus, string> = { waiting: "Waiting", setup: "Setting up", paying: "Paying", done: "Done", failed: "Failed" };
/** Base first (the default and the one the agent starts on), then the rest in list order. */
const ordered = (ids: number[]) => [...SAFE_NETWORKS.map((n) => n.chainId)].sort((a, b) => Number(b === 8453) - Number(a === 8453)).filter((id) => ids.includes(id));
export type SetupOutcome =
  | { status: "ready"; indexed: boolean }
  | { status: "pending" }
  | { status: "reverted" }
  | { status: "not_deployed" }
  | { status: "user_pays"; cost: string; tx: { to: `0x${string}`; data: `0x${string}` } };

/** What the flow needs from the server and the wallet. The real one is `useCreateSafeApi`. */
export type CreateSafeApi = {
  preview(d: Draft): Promise<Preview>;
  /** Asks the wallet to sign the setup, then saves the Safe. */
  create(d: Draft, pv: Preview): Promise<{ address: string }>;
  setup(address: string, chainId: number, txHash?: string): Promise<SetupOutcome>;
  /** Checks live chain code and repairs deployment metadata without starting a deployment. */
  reconcile(address: string, chainId: number): Promise<SetupOutcome>;
  /** The user's wallet sends the deployment when the user pays the fee. Resolves with the hash. */
  payFee(tx: { to: `0x${string}`; data: `0x${string}` }, chainId: number, onSent: ((hash: string) => void) | undefined, owner: string): Promise<string>;
  indexed(address: string, chainId: number): Promise<boolean>;
};

type Phase = "form" | "sign" | "setup" | "pay" | "indexing" | "pending";

/**
 * The one "Create a Safe" flow (plans/auto-setup section 1): Name, Approvals, Review. One address for every network.
 * Setup on the first network is paid by us only while the sponsorship budget lasts; otherwise Review and the setup step state the fee.
 * `resume` continues a Safe that was already created but never finished deploying: it re-checks what was paid instead of paying again.
 */
export function CreateSafe({ wallet, api, onCreated, onCancel, embedded = false, onProgress, pollMs = 1500, indexWaitMs = 60_000, resume }: {
  wallet: string;
  api: CreateSafeApi;
  onCreated: (safe: { address: string; name: string; chainIds: number[] }) => void;
  onCancel?: () => void;
  /** The parent draws the step bar and the page heading. */
  embedded?: boolean;
  onProgress?: (p: { step: number; busy: boolean }) => void;
  pollMs?: number;
  /** How long to wait for the Transaction Service to list the new Safe before offering Check again / Leave and finish later. */
  indexWaitMs?: number;
  /** A saved Safe whose setup stopped partway. */
  resume?: { address: string; name?: string; chainIds: number[] };
}) {
  const [resumeInfo] = useState(resume ?? null);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("My Safe");
  const [nameTouched, setNameTouched] = useState(false);
  const [team, setTeam] = useState(false);
  const [cosigners, setCosigners] = useState([""]);
  const [needed, setNeeded] = useState<number | null>(null);
  const [networks, setNetworks] = useState<number[]>(DEFAULT_CREATE_CHAIN_IDS);
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  /** Per network: its status, the fee the user pays (when we do not), and the hash of their own deployment, kept so a retry confirms it instead of paying again. */
  const [nets, setNets] = useState<Record<number, NetStatus>>({});
  const [fees, setFees] = useState<Record<number, { cost: string; tx: { to: `0x${string}`; data: `0x${string}` } }>>({});
  const [hashes, setHashes] = useState<Record<number, string>>({});
  const [paymentIntents, setPaymentIntents] = useState<Record<number, "unknown">>({});
  const paymentIntentRef = useRef<Record<number, "unknown">>({});
  const hashRef = useRef<Record<number, string>>({});
  /** The network the flow is stopped on: waiting for the user to pay, or failed. */
  const [active, setActive] = useState<number | null>(null);
  /** One setup run at a time: a repeat submit while a wallet transaction is in flight must not send another. */
  const inflight = useRef(false);
  const [running, setRunning] = useState(false);
  /** The user left (or the component unmounted): no more automatic work, and never `onCreated`. A hash already sent stays recorded. */
  const stopped = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const head = useFocusOnChange<HTMLHeadingElement>(step);

  const owners = team ? [wallet, ...cosigners.map((c) => c.trim())] : [wallet];
  const sigs = team ? Math.min(needed ?? defaultApprovals(owners.length), owners.length) : 1;
  const ownerErrs = ownerErrors(owners);
  const nameErr = name.trim() === "";
  const ownersOk = ownerErrs.every((e) => !e);
  const chosen = ordered(networks);
  const usable = (resumeInfo ? ordered(resumeInfo.chainIds) : chosen).filter((id) => ENABLED_CHAIN_IDS.includes(id));
  const draft: Draft = { name: name.trim(), cosigners: team ? cosigners.map((c) => c.trim()) : [], threshold: sigs, networks: usable };
  /** The name on the record and in every status line: the draft's, or the saved Safe's while resuming. */
  const displayName = resumeInfo?.name?.trim() || name.trim();

  useEffect(() => { if (step === 0) nameRef.current?.select(); }, [step]);
  useEffect(() => { onProgress?.({ step: resumeInfo ? 2 : step, busy: phase !== "form" }); }, [step, phase, resumeInfo]); // eslint-disable-line react-hooks/exhaustive-deps
  // Strict Mode replays effects as setup -> cleanup -> setup. Reset here so the live replay can run.
  useEffect(() => { stopped.current = false; return () => { stopped.current = true; }; }, []);

  /** Runs one setup run at a time; `running` mirrors it for the buttons. */
  const go = async (fn: () => Promise<void>) => {
    if (inflight.current) return;
    inflight.current = true;
    setRunning(true);
    try { await fn(); } finally { inflight.current = false; setRunning(false); }
  };
  const leave = () => { stopped.current = true; onCancel?.(); };

  // Review shows the address and the honest setup-cost line, from the server.
  const draftKey = JSON.stringify(draft);
  useEffect(() => { setCreated(null); setNets({}); setFees({}); setHashes({}); hashRef.current = {}; setActive(null); }, [draftKey]); // an edited draft is a different Safe
  useEffect(() => {
    if (step !== 2 || usable.length === 0) return;
    let live = true;
    setPreview(null);
    api.preview(draft).then((p) => live && setPreview(p)).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [step, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => {
    if (step === 0 && nameErr) { setNameTouched(true); return void requestAnimationFrame(() => focusFirstInvalid(formRef.current)); }
    if (step === 1 && !ownersOk) { setTried(true); return void requestAnimationFrame(() => focusFirstInvalid(formRef.current)); }
    if (step === 2) return usable.length && preview ? void go(run) : void setTried(true);
    setStep(step + 1);
  };

  const setNet = (id: number, st: NetStatus) => setNets((n) => ({ ...n, [id]: st }));

  const finish = async (address: string) => {
    setPhase("indexing");
    // Every selected chain served by the app must be indexed before continuing to agent setup.
    const watched = usable.filter((id) => SERVED_CHAIN_IDS.includes(id));
    const deadline = Date.now() + indexWaitMs;
    for (;;) {
      if (stopped.current) return;
      const results = await Promise.all(watched.map(async (id) => ({ id, indexed: await api.indexed(address, id) })));
      const missing = results.find((r) => !r.indexed);
      if (!missing) break;
      if (Date.now() >= deadline) {
        // The bounded wait ends with the setup record and payment evidence intact for a later check.
        setActive(missing.id);
        setPhase("pending");
        return;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (stopped.current) return;
    clearCreateProgress(wallet, address);
    onCreated({ address, name: displayName, chainIds: usable });
  };

  /**
   * Set the Safe up on each chosen network in turn. A network the user pays for stops the loop until they press the button
   * (`payNow` is that network); a failure stops it too. Every step is idempotent, so retrying is safe.
   */
  const proceed = async (address: string, payNow?: number) => {
    setError(null);
    for (const id of usable) {
      if (stopped.current) return;
      if (nets[id] === "done") continue;
      try {
        let hash = hashRef.current[id];
        if (!hash && paymentIntentRef.current[id] === "unknown") {
          // After a reload while the wallet prompt was open, check for deployment but never ask the wallet again.
          setPhase("setup");
          setNet(id, "paying");
          const reconciled = await api.reconcile(address, id);
          if (stopped.current) return;
          if (reconciled.status === "ready") { setNet(id, "done"); continue; }
          setActive(id);
          setError(reconciled.status === "not_deployed"
            ? "We could not confirm that your payment deployed the Safe. Check your wallet activity before taking any further action. Do not pay again until you confirm the first payment did not go through."
            : "We could not confirm whether your wallet sent the payment. Check your wallet activity before taking any further action.");
          setPhase("pay");
          return;
        }
        if (!hash) {
          // The user pressed Pay: use the transaction we already have for this network instead of asking the server again.
          let tx = payNow === id ? fees[id]?.tx : undefined;
          if (!tx) {
            setPhase("setup");
            setNet(id, "setup");
            const r = await api.setup(address, id);
            if (stopped.current) return;
            if (r.status === "pending") throw new Error("Setup is still running. Try again in a moment.");
            if (r.status === "user_pays") {
              setFees((f) => ({ ...f, [id]: { cost: r.cost, tx: r.tx } }));
              if (payNow !== id) { setNet(id, "paying"); setActive(id); setPhase("pay"); return; }
              tx = r.tx;
            }
          }
          if (tx) {
            setNet(id, "paying");
            setPhase("pay");
            markPaymentUnknown(wallet, address, id);
            paymentIntentRef.current = { ...paymentIntentRef.current, [id]: "unknown" };
            setPaymentIntents(paymentIntentRef.current);
            hash = await api.payFee(tx, id, (h) => { hashRef.current[id] = h; setHashes((x) => ({ ...x, [id]: h })); recordPaidHash(wallet, address, id, h); }, wallet);
            // The transaction the wallet sent is kept even if the user already left: a later resume re-checks it.
            hashRef.current[id] = hash;
            setHashes((x) => ({ ...x, [id]: hash! }));
            recordPaidHash(wallet, address, id, hash);
            if (stopped.current) return;
          }
        }
        if (hash) {
          setPhase("setup");
          setNet(id, "setup");
          const r = await api.setup(address, id, hash);
          if (stopped.current) return;
          if (r.status === "reverted") {
            hashRef.current[id] = "";
            setHashes((x) => { const copy = { ...x }; delete copy[id]; return copy; });
            clearPaymentAttempt(wallet, address, id);
            const intents = { ...paymentIntentRef.current }; delete intents[id]; paymentIntentRef.current = intents; setPaymentIntents(intents);
            setNet(id, "failed");
            setActive(id);
            setError(`Your payment on ${safeNetworkName(id)} reverted. The Safe was not deployed; review the fee before trying again.`);
            setPhase("pay");
            return;
          }
          if (r.status !== "ready") throw new Error(`We do not see your Safe on ${safeNetworkName(id)} yet. Try again in a moment.`);
        }
        setNet(id, "done");
      } catch (e) {
        if (stopped.current) return;
        const message = e instanceof Error ? e.message : "Something went wrong. Try again.";
        if (/user rejected|user denied|connected wallet changed|payment reverted|payment was cancelled|different transaction replaced/i.test(message)) {
          clearPaymentAttempt(wallet, address, id);
          const intents = { ...paymentIntentRef.current }; delete intents[id]; paymentIntentRef.current = intents; setPaymentIntents(intents);
          if (/payment reverted|payment was cancelled|different transaction replaced/i.test(message)) { hashRef.current = { ...hashRef.current }; delete hashRef.current[id]; setHashes(hashRef.current); }
        }
        setNet(id, "failed");
        setActive(id);
        setError(message);
        setPhase("pay");
        return;
      }
    }
    if (stopped.current) return;
    try {
      await finish(address);
    } catch (e) {
      if (stopped.current) return;
      // The networks are set up; only the wait for the index failed. Retrying comes back here.
      setActive(usable[usable.length - 1]!);
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setPhase("pay");
    }
  };

  /** Sign, save, then set up network by network. After a failed setup the Safe is already saved: retry from setup. */
  const run = async () => {
    if (!preview) return;
    setError(null);
    try {
      let address = created;
      if (!address) {
        setPhase("sign");
        address = (await api.create(draft, preview)).address;
        setCreated(address);
        // The Safe exists on the server from here on; keep enough to resume it after a reload.
        saveCreateProgress(wallet, { address, name: draft.name, chainIds: usable, hashes: {}, paymentIntents: {} });
      }
      await proceed(address);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setPhase("form");
    }
  };
  /** Continue a Safe that was created earlier: no new signature, and a stored payment hash is re-checked not repaid. */
  const startResume = () => {
    if (!resumeInfo) return;
    setError(null);
    const saved = loadCreateProgress(wallet, resumeInfo.address);
    hashRef.current = { ...(saved?.hashes ?? {}) };
    setHashes(hashRef.current);
    paymentIntentRef.current = { ...(saved?.paymentIntents ?? {}) };
    setPaymentIntents(paymentIntentRef.current);
    saveCreateProgress(wallet, { address: resumeInfo.address, name: displayName, chainIds: usable, hashes: hashRef.current, paymentIntents: { ...(saved?.paymentIntents ?? {}) } });
    setCreated(resumeInfo.address);
    void go(() => proceed(resumeInfo.address));
  };
  /** The button while stopped on a network or on the indexing wait: pay (or check the payment), or retry. */
  const retry = (pay = false) => {
    if (!created || active === null) return;
    void go(() => proceed(created, pay ? active : undefined));
  };

  const busy = phase !== "form";
  const approvals = approvalsSummary(sigs, owners.length);
  const heading = (t: string) => embedded
    ? <h1 ref={head} tabIndex={-1} className="text-lg font-medium outline-none">{t}</h1>
    : <h2 ref={head} tabIndex={-1} className="text-base font-medium outline-none">{t}</h2>;

  return (
    <form ref={formRef} noValidate className="contents" onSubmit={(e) => { e.preventDefault(); if (phase === "pay" || phase === "pending") retry(); else if (phase === "form") next(); }}>
      {!embedded && <StepBar labels={STEPS} step={step} />}

      {resumeInfo && phase === "form" && (
        <>
          {heading(`Finish setting up ${displayName}`)}
          <p className="text-sm">Your Safe was created but its setup stopped partway. Continue where it stopped — what is already paid is checked, not paid again.</p>
          <p className="text-xs text-muted-foreground" title={resumeInfo.address}>{displayName} · {shortAddress(resumeInfo.address)}</p>
        </>
      )}

      {!resumeInfo && step === 0 && (
        <>
          {heading("Name your Safe")}
          <Field label="Name" tone={(nameTouched || tried) && nameErr ? "error" : "hint"} message={(nameTouched || tried) && nameErr ? "Enter a name." : "A short name so you can tell your Safes apart."}>
            {(p) => <Input {...p} ref={nameRef} maxLength={30} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== "My Safe" && setNameTouched(true)} />}
          </Field>
        </>
      )}

      {!resumeInfo && step === 1 && (
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
                <Button type="button" variant="outline" size="sm" className="self-start" disabled={owners.length >= MAX_OWNERS} onClick={() => setCosigners([...cosigners, ""])}><Plus /> Add another</Button>
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

      {!resumeInfo && step === 2 && phase !== "pending" && (
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
            <span className="text-muted-foreground">
              Your Safe's address: <span data-testid="safe-address" title={preview?.address}>{preview ? shortAddress(preview.address) : "working it out…"}</span>.{" "}
              {chosen.length === 1 ? `It starts on ${safeNetworkName(chosen[0]!)}; the same address works on other networks.` : "It is the same on every network you pick."}
            </span>
            {!busy && (usable.length > 1 && preview ? (
              <ul data-testid="setup-cost" className="flex flex-col text-muted-foreground" aria-label="Setup fee per network">
                {usable.map((id) => {
                  const f = preview.networks?.find((x) => x.chainId === id);
                  return <li key={id} data-testid={`fee-${id}`}>{safeNetworkName(id)}: {f?.sponsored ? "free, we pay the setup fee" : `${setupFeeEstimate(id)}, you pay it from your wallet`}</li>;
                })}
              </ul>
            ) : (
              <span data-testid="setup-cost" className="text-muted-foreground">{preview ? preview.cost : "Checking the setup fee…"}</span>
            ))}
            {!busy && usable.some((id) => !SERVED_CHAIN_IDS.includes(id)) && <span data-testid="not-served" className="text-muted-foreground">{NOT_SERVED_LINE}</span>}
          </div>
          {!busy && (
            <fieldset className="flex flex-wrap gap-1.5">
              <legend className="mb-1 text-sm text-muted-foreground">Networks</legend>
              {SAFE_NETWORKS.map((n) => {
                const on = networks.includes(n.chainId);
                const enabled = ENABLED_CHAIN_IDS.includes(n.chainId);
                return (
                  <label key={n.chainId} className={radioCard(on, !enabled) + " flex-row items-center gap-2 px-2.5 py-1.5"}>
                    <input type="checkbox" className="size-4 accent-foreground" checked={on} disabled={!enabled} onChange={() => setNetworks(on ? networks.filter((x) => x !== n.chainId) : [...networks, n.chainId])} />
                    <span className="flex items-start gap-1.5"><NetworkMark id={n.chainId} className="mt-0.5" /><span className="text-sm">{n.name}{!enabled && <span className="block text-xs text-muted-foreground">Not available yet</span>}</span></span>
                  </label>
                );
              })}
            </fieldset>
          )}
          {tried && usable.length === 0 && <p role="alert" className="text-xs text-destructive">Pick at least one network that is available.</p>}
        </>
      )}

      {error && <p role="alert" className="text-sm text-destructive-text">{error}</p>}

      {busy && created && usable.length > 1 && (
        <ul aria-label="Setup progress" className="flex flex-col gap-1 text-sm">
          {usable.map((id) => (
            <li key={id} data-testid={`net-${id}`} className="flex justify-between">
              <span className="inline-flex items-center gap-1.5"><NetworkMark id={id} />{safeNetworkName(id)}</span>
              <span className={nets[id] === "failed" ? "text-destructive-text" : "text-muted-foreground"}>{STATUS_TEXT[nets[id] ?? "waiting"]}</span>
            </li>
          ))}
        </ul>
      )}

      {phase === "pending" ? (
        <div className="flex flex-col gap-2">
          {heading("Not listed yet")}
          <p role="status" className="text-sm">Safe has not listed your new Safe yet — it is still catching up. What you set up is saved; nothing is paid again.</p>
          <p className="text-xs text-muted-foreground" title={created ?? undefined}>{displayName} · {created ? shortAddress(created) : ""}</p>
          <Button size="lg" type="submit" disabled={running}>Check again</Button>
          {onCancel && <Button type="button" variant="ghost" onClick={leave}>Leave and finish later</Button>}
        </div>
      ) : phase === "pay" && active !== null ? (
        <div className="flex flex-col gap-2">
          {fees[active] && <p role="status" className="text-sm">{fees[active].cost}</p>}
          {paymentIntents[active] === "unknown" && !hashes[active] && !error && <p role="status" className="text-sm">We do not know whether the wallet sent this payment. Check wallet activity before confirming that no payment was sent.</p>}
          <Button size="lg" type={hashes[active] || paymentIntents[active] === "unknown" ? "submit" : "button"} disabled={running} onClick={hashes[active] || paymentIntents[active] === "unknown" ? undefined : () => retry(!!fees[active])}>{
            hashes[active] || paymentIntents[active] === "unknown" ? "Check my payment"
              : fees[active] ? `Pay the setup fee${usable.length > 1 ? ` on ${safeNetworkName(active)}` : ""}`
              : "Try again"}</Button>
          {paymentIntents[active] === "unknown" && !hashes[active] && <Button type="button" variant="outline" disabled={running} onClick={() => { clearPaymentAttempt(wallet, created!, active); const intents = { ...paymentIntentRef.current }; delete intents[active]; paymentIntentRef.current = intents; setPaymentIntents(intents); setError("Payment attempt cleared. Check the setup fee and choose Pay only if your wallet confirms no payment was sent."); }}>I confirmed no payment was sent</Button>}
          {onCancel && <Button type="button" variant="ghost" onClick={leave}>Leave and finish later</Button>}
        </div>
      ) : busy ? (
        <div className="flex flex-col gap-2">
          <p role="status" className="flex items-center gap-2 text-sm"><Spinner /> {
            phase === "sign" ? `Confirm in your wallet to create ${displayName}. This sets up the Safe; it does not move money.`
              : phase === "setup" ? `Setting up ${displayName}…`
              : "Waiting for Safe to recognise your new Safe…"}
          </p>
          {created && onCancel && <Button type="button" variant="ghost" onClick={leave}>Leave and finish later</Button>}
        </div>
      ) : resumeInfo ? (
        <div className="flex gap-2">
          {onCancel && <Button size="lg" type="button" variant="ghost" onClick={leave}>Back</Button>}
          <Button size="lg" type="button" className="flex-1" disabled={running} onClick={startResume}>Finish setting up</Button>
        </div>
      ) : (
        <div className="flex gap-2">
          {step > 0 ? <Button size="lg" type="button" variant="ghost" onClick={() => setStep(step - 1)}>Back</Button> : onCancel && <Button size="lg" type="button" variant="ghost" onClick={leave}>Back</Button>}
          <Button size="lg" type="submit" className="flex-1" disabled={step === 2 && !preview && usable.length > 0}>{step === 2 ? "Create Safe" : "Next"}</Button>
        </div>
      )}
    </form>
  );
}
