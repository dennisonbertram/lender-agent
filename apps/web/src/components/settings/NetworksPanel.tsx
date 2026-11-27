"use client";
import { useState } from "react";
import { NetworkChip, Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import type { SigningProgress } from "@/client/agent";
import type { NetworkRow } from "@/lib/networks";
import type { Network } from "@/lib/types";

export type NetworksPanelProps = {
  safeName: string;
  /** One row per network the app serves; the ones with setup "not-added" go in the Add network list. */
  rows: NetworkRow[];
  progress: SigningProgress | null;
  busy: boolean;
  error?: string | null;
  /** One wallet signature on this network, using the same delegate message as the agent panel. */
  onAddAgent: (network: Network) => void;
  onAddNetwork: (network: Network) => void;
};

/** The Settings Networks panel (BP-35, mockup r24): set up or ready on first use, agent on or off, and Add network. */
export function NetworksPanel({ safeName, rows, progress, busy, error, onAddAgent, onAddNetwork }: NetworksPanelProps) {
  const added = rows.filter((r) => r.setup !== "not-added");
  const free = rows.filter((r) => r.setup === "not-added");
  const [pick, setPick] = useState<Network | undefined>();
  const choice = free.find((r) => r.id === pick) ?? free[0];
  return (
    <Panel guideTarget="settings-networks" title="Networks">
      <p className="text-sm text-muted-foreground">{safeName} has the same address on every network. It is set up on a network the first time you use it there. The agent needs one signature on each network where it should suggest transactions.</p>
      <ul className="flex flex-col gap-2">
        {added.map((r) => (
          <li key={r.id} aria-label={r.name} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-muted p-3 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium"><NetworkChip id={r.id} className="px-1.5 py-0" /></div>
              <div className="text-xs text-muted-foreground">{r.line}</div>
              {r.setup === "ready" && !r.agent && <div className="text-xs text-muted-foreground">Switch the agent on when you first use this network.</div>}
            </div>
            {r.setup === "deployed" && !r.agent && (
              <Button size="sm" disabled={busy} onClick={() => onAddAgent(r.id)} aria-label={`Add agent to ${r.name}`}>
                {busy && progress?.network === r.name ? <><Spinner /> Waiting for your signature</> : "Add agent"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {busy && progress && <p role="status" className="text-sm">Confirm in your wallet: {progress.network}, {progress.n} of {progress.total}.</p>}
      {error && <p role="alert" className="text-sm text-destructive-text">{error} You can try again.</p>}
      {choice ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Add a network
            <NativeSelect value={choice.id} disabled={busy} onChange={(e) => setPick(e.target.value as Network)}>
              {free.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.name}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          <Button disabled={busy} onClick={() => onAddNetwork(choice.id)}>Add network</Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Every network is added.</p>
      )}
    </Panel>
  );
}
