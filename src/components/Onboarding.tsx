import { useState } from "react";
import { Check, Wallet } from "lucide-react";
import { USER, type Safe } from "@/data";
import { shortAddress } from "@/lib/address";
import { networksLabel, setAllAgents } from "@/lib/networks";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { NetworkChip, StepBar, useFocusOnChange } from "@/components/common";
import { onboardingBar } from "@/lib/step-bar";
import { AgentSignatures, CreateSafe } from "@/components/CreateSafe";

export function Onboarding() {
  const { finishOnboarding, loadSampleLoans, safes, switchSafe, go, wallet, connectWallet, addAgentOn, addSafe, postBlock } = useApp();
  const [step, setStep] = useState(0);
  /** Returning user: show the Create flow instead of the list of found Safes. */
  const [creating, setCreating] = useState(false);
  /** The Safe the agent is being added to: a found one, or the one just created. */
  const [target, setTarget] = useState<Safe | null>(null);
  const [created, setCreated] = useState(false);
  const [progress, setProgress] = useState({ step: 0, busy: false });
  const head = useFocusOnChange<HTMLHeadingElement>(`${step}-${creating}`);
  const isNew = wallet === "new";

  const connect = (kind: "returning" | "new") => {
    connectWallet(kind);
    setCreating(false);
    setStep(1);
  };

  const finish = (reserve: boolean) => {
    switchSafe(target?.id ?? safes[0].id);
    finishOnboarding();
    if (reserve) go({ name: "reserve" });
  };

  const sample = () => {
    switchSafe(safes[0].id);
    loadSampleLoans();
  };

  const bar = onboardingBar({
    screen: (["connect", "safe", "agent", "done"] as const)[step],
    path: isNew || creating || (step > 1 && created) ? "create" : "found",
    createStep: progress.step,
  });
  const nets = target?.networks.map((n) => n.id) ?? [];
  const funded = !!target && Object.keys(target.balances).length > 0;
  return (
    <div className="flex min-h-full items-start justify-center p-4 pt-[8vh]">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        {bar && <StepBar {...bar} />}

        {step === 0 && (
          <>
            <h1 ref={head} tabIndex={-1} className="text-lg font-medium outline-none">Borrow cash against your crypto</h1>
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              <li>Tell Lender agent how much cash you need.</li>
              <li>It finds loan offers and prepares each step. It cannot move money.</li>
              <li>You approve every step in your Safe, a crypto wallet that only moves money when its owners approve.</li>
            </ol>
            <Button size="lg" onClick={() => connect("new")}>Set up a new Safe</Button>
            <Button size="lg" variant="outline" onClick={() => connect("returning")}><Wallet /> I already have a Safe</Button>
            <p className="text-xs text-muted-foreground">Demo only. A sample wallet is connected; no real money is used.</p>
          </>
        )}

        {step === 1 && (
          <>
            {isNew || creating ? (
              <CreateSafe
                embedded
                onProgress={setProgress}
                onCreated={(s) => { setTarget(s); setCreated(true); setStep(2); }}
                onCancel={isNew ? () => setStep(0) : () => setCreating(false)}
              />
            ) : (
              <>
                <h1 ref={head} tabIndex={-1} className="text-lg font-medium outline-none">Your Safe</h1>
                <p className="text-xs text-muted-foreground">We found these Safes owned by your wallet. A Safe is a shared wallet: the owners approve each transaction.</p>
                <ul className="flex flex-col gap-2">
                  {safes.map((s) => (
                    <li key={s.id}>
                      <button
                        onClick={() => { setTarget(s); setCreated(false); setStep(2); }}
                        className="flex w-full flex-col gap-1.5 rounded-xl p-3 text-left ring-1 ring-foreground/10 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <span className="text-sm"><span className="font-medium">{s.name}</span> <span className="text-muted-foreground">{shortAddress(s.address)}</span></span>
                        <span className="text-xs text-muted-foreground">{s.threshold} owners must approve each transaction</span>
                        <span className="flex flex-wrap gap-1">{s.networks.map((n) => <NetworkChip key={n.id} id={n.id} />)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <Button size="lg" variant="outline" onClick={() => setCreating(true)}>Create a new Safe</Button>
              </>
            )}
            {!(( isNew || creating) && progress.busy) && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="size-3 text-success" /> Wallet connected {USER.address}</p>}
          </>
        )}

        {step === 2 && target && (
          <>
            <h1 ref={head} tabIndex={-1} className="text-lg font-medium outline-none">Let Lender agent suggest transactions</h1>
            <p className="text-xs text-muted-foreground">It approves a permission, not a payment. You can remove it anytime in Settings.</p>
            <AgentSignatures
              safeName={target.name} address={target.address} networks={nets}
              onSigned={() => {
                if (created) addSafe(setAllAgents(target, true), true);
                else addAgentOn(target.id, nets);
                setStep(3);
              }}
            />
            <span className="text-xs text-muted-foreground">Demo: no wallet is used. Each confirmation completes on its own.</span>
            {!created && <Button size="lg" variant="ghost" onClick={() => setStep(1)}>Back</Button>}
          </>
        )}

        {step === 3 && target && (
          <>
            <span className="flex size-10 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-5" /></span>
            <h1 ref={head} tabIndex={-1} className="text-lg font-medium outline-none">Lender agent can now suggest transactions</h1>
            <p className="text-xs text-muted-foreground">It suggests transactions in {target.name} on {networksLabel(nets)}. You sign every one.</p>
            {created && !funded && <p className="text-sm">Next: add crypto so the agent has something to borrow against.</p>}
            {!created && <p className="text-xs text-muted-foreground">Optional: a Reserve Safe lets the agent protect a loan in an emergency, within limits you set.</p>}
            {created && !funded ? (
              <>
                <Button size="lg" onClick={() => { finish(false); postBlock({ kind: "addfunds" }); }}>Add funds</Button>
                <Button size="lg" variant="ghost" onClick={() => finish(false)}>Talk to the agent</Button>
              </>
            ) : <Button size="lg" onClick={() => finish(false)}>Talk to the agent</Button>}
            {!created && <Button size="lg" variant="outline" onClick={() => finish(true)}>Set up Reserve Safe</Button>}
            {!created && <Button size="lg" variant="ghost" onClick={sample}>Or explore with sample loans</Button>}
          </>
        )}
      </div>
    </div>
  );
}
