import { useRef, useState } from "react";
import { ZERO_BALANCES, type Safe } from "@/data";
import { validateAddress } from "@/lib/address";
import { setAllAgents } from "@/lib/networks";
import { cn } from "@/lib/utils";
import { useApp } from "@/store";
import { AgentSignatures, CreateSafe } from "@/components/CreateSafe";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, focusFirstInvalid } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function AddSafeDialog() {
  const { addSafeOpen, setAddSafeOpen } = useApp();
  return (
    <Dialog open={addSafeOpen} onOpenChange={setAddSafeOpen}>
      <DialogContent className="sm:max-w-md">
        <Body close={() => setAddSafeOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function Body({ close }: { close: () => void }) {
  const { safes, addSafe } = useApp();
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [draft, setDraft] = useState<Safe | null>(null);
  const [progress, setProgress] = useState({ step: 0, busy: false });
  const [tried, setTried] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const addressErr = validateAddress(address, safes.map((s) => s.address));

  const submit = () => {
    setTried(true);
    if (name.trim() === "" || addressErr) return void requestAnimationFrame(() => focusFirstInvalid(formRef.current));
    // Sample data: an existing Safe is found on Ethereum with some funds.
    setDraft({
      id: `safe-${safes.length}-${address.trim().slice(2, 6)}`, name: name.trim(), address: address.trim(), threshold: "2 of 3", agent: false,
      networks: [{ id: "ethereum", deployed: true, agent: false }], balances: { ethereum: { ...ZERO_BALANCES, ETH: 3, USDC: 2000 } },
    });
  };

  if (draft) {
    return (
      <>
        <DialogHeader><DialogTitle>Let Lender agent suggest transactions</DialogTitle></DialogHeader>
        <AgentSignatures
          safeName={draft.name} address={draft.address} networks={draft.networks.map((n) => n.id)}
          onSigned={() => { addSafe(setAllAgents(draft, true)); close(); }}
          onSkip={() => { addSafe(draft); close(); }}
        />
        <span className="text-xs text-muted-foreground">You can add or remove it anytime in Settings.</span>
      </>
    );
  }

  return (
    <>
      <DialogHeader><DialogTitle>Add a Safe</DialogTitle></DialogHeader>
      {!(mode === "create" && (progress.step > 0 || progress.busy)) && <div className="flex gap-1 rounded-full bg-muted p-1 text-sm">
        {([["existing", "Existing Safe"], ["create", "Create a new Safe"]] as const).map(([m, label]) => (
          <button key={m} type="button" onClick={() => { setMode(m); setTried(false); }} className={cn("flex-1 rounded-full px-3 py-1.5", mode === m ? "bg-background font-medium" : "text-muted-foreground")}>{label}</button>
        ))}
      </div>}
      {mode === "create" ? (
        <CreateSafe onCreated={setDraft} onProgress={setProgress} onCancel={() => { setMode("existing"); setProgress({ step: 0, busy: false }); }} />
      ) : (
        <form ref={formRef} noValidate className="contents" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field label="Name" tone={tried && name.trim() === "" ? "error" : "hint"} message={tried && name.trim() === "" ? "Enter a name." : undefined}>
            {(p) => <Input {...p} maxLength={30} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ops Safe" />}
          </Field>
          <Field label="Safe address" tone={(tried || address) && addressErr ? "error" : "hint"} message={tried || address ? addressErr ?? undefined : "Copy it from your Safe app, under the Safe's name."}>
            {(p) => <Input {...p} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 0x4a1c…9e2f" />}
          </Field>
          <Button size="lg" type="submit">Continue</Button>
        </form>
      )}
    </>
  );
}
