"use client";
import { PageHeader } from "@/components/common";
import { GuideIntro } from "@/components/guide/Guide";
import { chainName, useAddAgent, useAddNetwork, useAgentStatus, useRemoveAgent } from "@/client/agent";
import { networkRows, servedNetworks } from "@/lib/networks";
import { useLoans, useSaveLevels } from "@/client/loans";
import { useEmailSettings } from "@/client/alerts";
import { useRules } from "@/client/rules";
import { Button } from "@/components/ui/button";
import { SafeIdentity } from "./SafeIdentity";
import { RulePanel } from "./RulePanel";
import { EmailPanel } from "./EmailPanel";
import { AgentPanel } from "./AgentPanel";
import { LevelsPanel } from "./LevelsPanel";
import { NetworksPanel } from "./NetworksPanel";
import { ReserveRow } from "./ReserveRow";
import { useSafeNickname, useShell } from "@/components/shell/ShellContext";
import { NETWORK_OF } from "@/shared/types";
import type { Network } from "@/lib/types";
import { AgentWatchStatus } from "@/components/agent/AgentWatchStatus";
import { SafeNicknameEditor } from "./SafeNicknameEditor";

const chainOf = (id: Network) => servedNetworks().find((n) => n.id === id)!.chainId;

export function SettingsView({ address }: { address: string }) {
  const { safe, walletAddress } = useShell();
  const { safeNickname, setSafeNickname } = useSafeNickname();
  const status = useAgentStatus(address);
  const add = useAddAgent(address);
  const remove = useRemoveAgent(address);
  const network = useAddNetwork(address);
  const data = status.data;
  const loansQuery = useLoans(address);
  const loans = loansQuery.data?.loans ?? [];
  const save = useSaveLevels(address);
  const email = useEmailSettings();
  const rules = useRules(address);
  const paused = !!data && !data.networks.some((n) => n.added);
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Settings" />
      <GuideIntro topicId="settings" />
      <SafeIdentity safe={safe} />
      <SafeNicknameEditor key={`${walletAddress?.toLowerCase() ?? "no-wallet"}:${safe.address.toLowerCase()}`} address={safe.address} safeName={safe.name} nickname={safeNickname(safe.address)} enabled={!!walletAddress} setSafeNickname={setSafeNickname} />
      <div className="rounded-xl border border-edge p-3">
        <p className="mb-1 text-sm font-medium">Loan monitoring</p>
        <AgentWatchStatus />
      </div>
      {data && paused && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warning/10 p-3 text-sm ring-1 ring-warning/50">
          <span>The agent is not watching your loans. Alerts and standing rules are paused.</span>
          <Button size="sm" disabled={add.adding || remove.removing} onClick={() => { remove.reset(); void add.add().catch(() => {}); }}>Add agent</Button>
        </div>
      )}
      {status.isError ? (
        <p role="alert" className="text-sm text-destructive-text">Could not read the agent's status. Try again.</p>
      ) : data ? (
        <AgentPanel
          loans={loans.map((l) => ({ lender: l.lender, debtUsd: l.debt.usd }))}
          agentAddress={data.agentAddress}
          chainId={data.networks.find((n) => n.added)?.chainId}
          activeNetworks={data.networks.filter((n) => n.added).map((n) => chainName(n.chainId))}
          progress={add.progress ?? remove.progress}
          busy={add.adding || remove.removing}
          error={add.error?.message ?? remove.error?.message}
          onAdd={() => { remove.reset(); void add.add().catch(() => {}); }}
          onRemove={() => { add.reset(); return remove.remove(); }}
        />
      ) : null}
      {email.query.isError ? <div role="alert" className="rounded-xl border border-edge p-3 text-sm">Could not read email settings. <Button variant="link" size="inline" onClick={() => void email.query.refetch()}>Try again</Button></div> : email.query.isPending ? <p role="status" className="text-sm text-muted-foreground">Checking email settings…</p> : email.query.data && <EmailPanel value={email.query.data} onSave={(next) => email.save.mutateAsync(next)} />}
      <details className="rounded-xl border border-edge p-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced risk thresholds</summary>
        <div className="pt-3"><LevelsPanel
          paused={paused}
          loans={loans.map((l) => ({ id: l.id, lender: l.lender, asset: l.collateral.length === 1 ? l.collateral[0].asset : "collateral", healthFactor: l.healthFactor, status: l.status, levels: l.levels }))}
          onSave={async (loanId, warn, act) => (await save.mutateAsync({ loanId, warn, act })).message}
        /></div>
      </details>
      {rules.query.data && (
        <RulePanel paused={paused} loans={rules.query.data}
          onSave={async (loanId, option, enabled) => { await rules.save.mutateAsync({ loanId, option, enabled }); }}
          onDelete={async (loanId) => { await rules.remove.mutateAsync(loanId); }} />
      )}
      {data && (
        <NetworksPanel
          safeName={safe.name}
          rows={networkRows(
            { networks: data.networks.map((n) => ({ id: NETWORK_OF[n.chainId], deployed: n.deployed, agent: n.added })) },
            servedNetworks(),
          )}
          progress={add.progress}
          busy={add.adding || network.adding || remove.removing}
          error={add.error?.message ?? network.error?.message}
          onAddAgent={(id) => { network.reset(); void add.add(chainOf(id)).catch(() => {}); }}
          onAddNetwork={(id) => {
            add.reset();
            const chainId = chainOf(id);
            // The Safe is set up there already: the agent signature follows at once (the same delegate message as the agent panel).
            void network.addNetwork(chainId).then((s) => (s.networks.some((n) => n.chainId === chainId && n.deployed) ? add.add(chainId) : undefined)).catch(() => {});
          }}
        />
      )}
      <ReserveRow address={address} />
    </div>
  );
}
