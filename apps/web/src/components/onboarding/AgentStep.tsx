import { CanCannot, NetworkChip, StepBar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AddressText } from "@/components/ui/address";
import type { SigningProgress } from "@/client/agent";
import { onboardingBar } from "@/lib/step-bar";

export const AGENT_CAN = ["See your balances", "Suggest transactions for you to sign"];
export const AGENT_CANNOT = ["Sign or approve anything", "Move money on its own"];

export type AgentStepProps = {
  safeName?: string;
  safeAddress: string;
  /** Chain used for explorer and Safe app links (the first deployed network). */
  chainId?: number;
  /** The Lender agent's address, from the agent status. */
  agentAddress?: string;
  /** Names of the deployed networks the agent will be added on. */
  networks: string[];
  progress: SigningProgress | null;
  busy: boolean;
  /** Set once the server's read-back showed the agent. */
  done: boolean;
  error?: string | null;
  onAdd: () => void;
  onSkip?: () => void;
  /** Shown in the done state, where the action buttons were. */
  onOpenChat?: () => void;
  /** The Safe was just created in the app: the step bar is Name, Approvals, Review, Agent (OC-05). */
  createPath?: boolean;
  /** Names of networks the Safe is set up on that the app does not serve; shown when no served network is set up. */
  otherNetworks?: string[];
  /** Adds Base through the existing networks flow. */
  onAddBase?: () => void;
};

/** The agent step (BP-05, BP-06). No field for a key or a seed phrase, on purpose. */
export function AgentStep({ safeName, safeAddress, chainId, agentAddress, networks, progress, busy, done, error, onAdd, onSkip, onOpenChat, createPath, otherNetworks = [], onAddBase }: AgentStepProps) {
  const many = networks.length > 1;
  const bar = onboardingBar({ screen: "agent", path: createPath ? "create" : "found", createStep: 0 });
  return (
    <div className="flex flex-col gap-4">
      {!done && <a href="/onboarding" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">Back to your Safes</a>}
      {bar && <StepBar {...bar} complete={done} />}
      <h1 className="text-lg font-medium outline-none">{done ? "Lender agent can now suggest transactions" : "Let Lender agent suggest transactions"}</h1>
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{safeName || "Safe"}</span>
        <AddressText address={safeAddress} chainId={chainId} showSafeApp />
        {networks.length > 0 && <span className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">On {networks.map((network, i) => <span key={`${network}-${i}`} className="inline-flex items-center gap-1">{i > 0 && "and"}<NetworkChip id={network} className="px-1.5 py-0" /></span>)}.</span>}
        <span className="text-xs text-muted-foreground">Safe calls this role a proposer.</span>
      </div>
      {!done && agentAddress && networks.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 p-3 text-sm">
          <span className="font-medium">What you will sign</span>
          <span className="flex flex-wrap items-center gap-x-1">You will add the Lender agent <AddressText address={agentAddress} chainId={chainId} /> as a proposer on this Safe.</span>
          <span>It can suggest transactions; it cannot sign or move money.</span>
          <span className="text-xs text-muted-foreground">
            You sign one message in your wallet{many ? ` per network (${networks.length})` : ""}. It is free: no transaction is sent and no other owner has to approve. The agent can suggest transactions as soon as it confirms.
          </span>
        </div>
      )}
      <CanCannot can={AGENT_CAN} cannot={AGENT_CANNOT} />
      <p className="text-xs text-muted-foreground">It approves a permission, not a payment. You can remove it anytime in Settings.</p>
      {done && onOpenChat && <Button size="lg" onClick={onOpenChat}>Open chat</Button>}
      {!done && networks.length === 0 && (
        <div className="flex flex-col gap-2">
          {otherNetworks.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1 text-sm">Your Safe is set up on {otherNetworks.map((network, i) => <span key={`${network}-${i}`} className="inline-flex items-center gap-1">{i > 0 && "and"}<NetworkChip id={network} className="px-1.5 py-0" /></span>)}. Loans and the agent work on Base and Arbitrum; add one of those networks to use them.</p>
          ) : (
            <p className="text-sm">This Safe is not set up on a network we support yet, so the agent cannot be added.</p>
          )}
          {error && <p role="alert" className="text-sm text-destructive-text">{error}</p>}
          {onAddBase && <Button size="lg" disabled={busy} onClick={onAddBase}>{busy ? <><Spinner /> Adding Base</> : "Add Base"}</Button>}
          <Button size="lg" variant="outline" render={<a href="/onboarding" />}>Back to your Safes</Button>
        </div>
      )}
      {!done && networks.length > 0 && (
        <div className="flex flex-col gap-2">
          {busy && progress && (
            <p role="status" className="flex flex-wrap items-center gap-1 text-sm">Confirm in your wallet: <NetworkChip id={progress.network} className="px-1.5 py-0" />, {progress.n} of {progress.total}.</p>
          )}
          {error && <p role="alert" className="text-sm text-destructive-text">{error} Nothing was changed on that network. You can try again.</p>}
          <Button size="lg" disabled={busy} onClick={onAdd}>
            {busy ? <><Spinner /> Waiting for your wallet</> : error ? "Try again" : "Add Lender agent"}
          </Button>
          {!busy && onSkip && <Button size="lg" variant="ghost" onClick={onSkip}>Skip, add later in Settings</Button>}
        </div>
      )}
    </div>
  );
}
