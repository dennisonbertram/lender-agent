"use client";
import { useAddAgent, useAgentStatus } from "@/client/agent";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AddressText } from "@/components/ui/address";

/** The "Add the agent" button and its progress and error text, shared by the chat notice and the plan card. */
export function AddAgentAction({ safeAddress, onAdded, only }: { safeAddress: string; onAdded?: () => void; only?: number }) {
  const add = useAddAgent(safeAddress);
  return (
    <div className="flex flex-col gap-2">
      {add.adding && add.progress && <p role="status" className="text-xs">Confirm in your wallet: {add.progress.network}, {add.progress.n} of {add.progress.total}.</p>}
      {add.error && <p role="alert" className="text-xs text-destructive-text">{add.error.message} Nothing was changed on that network. You can try again.</p>}
      <div>
        <Button size="sm" disabled={add.adding} onClick={() => { void add.add(only as never).then((s) => { if (s.active) onAdded?.(); }).catch(() => {}); }}>
          {add.adding ? <><Spinner /> Waiting for your wallet</> : add.error ? "Try again" : "Add the agent (one free signature)"}
        </Button>
      </div>
    </div>
  );
}

/** Replaces the chat composer when the agent is not a proposer on this Safe: adds it right here (flow-02). */
export function AgentOffNotice({ safeAddress, onAdded }: { safeAddress: string; onAdded?: () => void }) {
  const status = useAgentStatus(safeAddress);
  const chainId = status.data?.networks.find((n) => n.deployed)?.chainId;
  const agentAddress = status.data?.agentAddress;
  return (
    <div data-slot="agent-off" className="flex shrink-0 flex-col gap-2 border-t border-border p-3">
      <p className="text-sm text-muted-foreground">Add the Lender agent to suggest plans. It can suggest transactions; it cannot sign or move money.</p>
      {agentAddress && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">What you will sign</summary>
          <p className="mt-1 flex flex-wrap items-center gap-x-1">You add the Lender agent <AddressText address={agentAddress} chainId={chainId} /> as a proposer on this Safe. It is free: no transaction is sent and no other owner has to approve.</p>
        </details>
      )}
      <AddAgentAction safeAddress={safeAddress} onAdded={onAdded} />
      <a href={`/onboarding/agent?safe=${safeAddress}`} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">More about the agent</a>
    </div>
  );
}
