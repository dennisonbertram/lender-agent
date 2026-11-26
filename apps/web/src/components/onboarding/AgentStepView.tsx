"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/client/auth/useSession";
import { chainName, useAddAgent, useAddNetwork, useAgentStatus } from "@/client/agent";
import { ApiError, useAddSafe, useSafes } from "@/client/safes";
import { safeNetworkName } from "@/lib/safe-create";
import { AddressText } from "@/components/ui/address";
import { StateMessage } from "@/components/ui/state-message";
import { AgentStep } from "./AgentStep";
import { OnboardingCard } from "./OnboardingCard";
import { useSafeNicknameNames } from "./useSafeNicknameNames";

/** Wires the agent step to the server: signatures, read-back, then on to the chat. */
export function AgentStepView({ safeAddress, createPath }: { safeAddress: string; createPath?: boolean }) {
  const router = useRouter();
  const status = useAgentStatus(safeAddress);
  const { session } = useSession();
  const add = useAddAgent(safeAddress);
  const addNet = useAddNetwork(safeAddress);
  const safes = useSafes();
  const nicknameNames = useSafeNicknameNames(session?.address, [safeAddress]);
  const addSafe = useAddSafe();
  const addStarted = useRef(false);
  const redirected = useRef(false);
  const deployed = status.data?.networks.filter((n) => n.deployed) ?? [];
  const eligibleIds = new Set(status.data?.eligibleChainIds ?? []);
  const eligible = deployed.filter((network) => eligibleIds.has(network.chainId));
  const missing = eligible.filter((network) => !network.added);
  const canChat = status.data?.canChat ?? false;
  const done = eligible.length > 0 && !add.adding && missing.length === 0;
  const safeName = nicknameNames[safeAddress.toLowerCase()] ?? safes.data?.find((s) => s.address.toLowerCase() === safeAddress.toLowerCase())?.name ?? undefined;

  // Already on: skip a step with nothing left to do. Only from a read made after this page mounted, never from the cache
  // (Remove agent, then "Add agent to this Safe", lands here with a stale "on").
  const goChat = done && canChat && status.isFetchedAfterMount && !addStarted.current;
  useEffect(() => {
    if (goChat && !redirected.current) {
      redirected.current = true;
      router.replace(`/s/${safeAddress}/chat`);
    }
  }, [goChat, router, safeAddress]);

  if (status.error) {
    const notOwner = status.error instanceof ApiError && status.error.status === 403;
    const notInList = status.error instanceof ApiError && status.error.status === 404;
    return (
      <OnboardingCard>
        <StateMessage
          kind="error"
          reassure={false}
          className="max-w-none ring-0"
          title={notOwner ? "You are not an owner of this Safe" : notInList ? "This Safe is not in your list yet" : "We could not load this Safe"}
          reason={notOwner ? "Sign in with a wallet that owns this Safe, or pick another one." : notInList ? "Add it to your list first, then add the agent." : "Check the address, or pick another Safe."}
          action={notInList
            ? { label: "Add it", onClick: () => addSafe.mutate({ address: safeAddress }, { onSuccess: () => { void status.refetch(); } }) }
            : { label: "Back to your Safes", href: "/onboarding" }}
          secondary={notInList ? { label: "Back to your Safes", href: "/onboarding" } : undefined}
        />
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">Safe address from the link: <AddressText address={safeAddress} /></p>
        {addSafe.error && <p role="alert" className="text-xs text-destructive">{addSafe.error.message}</p>}
      </OnboardingCard>
    );
  }
  if (status.isPending) {
    return <OnboardingCard><StateMessage kind="loading" label="Loading this Safe…" /></OnboardingCard>;
  }
  return (
    <OnboardingCard>
      <AgentStep
        safeName={safeName}
        safeAddress={safeAddress}
        chainId={eligible[0]?.chainId ?? deployed[0]?.chainId}
        agentAddress={status.data?.agentAddress}
        createPath={createPath}
        networks={missing.map((n) => chainName(n.chainId))}
        progress={add.progress}
        busy={add.adding || addNet.adding}
        done={done}
        canChat={canChat}
        ownsEligibleNetwork={eligible.length > 0}
        error={add.error?.message ?? addNet.error?.message}
        otherNetworks={(status.data?.otherChainIds ?? []).map(safeNetworkName)}
        onAddBase={() => { void addNet.addNetwork(8453).catch(() => {}); }}
        onAdd={() => {
          addStarted.current = true;
          void add.add().then((s) => { if (s.active && s.canChat) router.push(`/s/${safeAddress}/chat`); }).catch(() => {});
        }}
        onSkip={() => router.push(`/s/${safeAddress}`)}
        onBackToSafes={() => router.push("/onboarding")}
        onOpenChat={() => { if (canChat) router.push(`/s/${safeAddress}/chat`); }}
      />
    </OnboardingCard>
  );
}
