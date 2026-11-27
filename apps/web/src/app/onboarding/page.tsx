"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAddress } from "viem";
import { useSession, useSignOut } from "@/client/auth/useSession";
import { useAddSafe, useOwnedSafes, useSafes } from "@/client/safes";
import { useCreateSafeApi } from "@/client/create-safe";
import { Spinner } from "@/components/ui/spinner";
import { StepBar } from "@/components/common";
import { GuideIntro } from "@/components/guide/Guide";
import { CreateSafe } from "@/components/onboarding/CreateSafe";
import { OnboardingCard } from "@/components/onboarding/OnboardingCard";
import { SafeStep } from "@/components/onboarding/SafeStep";
import { shortAddress } from "@/lib/address";
import { onboardingBar } from "@/lib/step-bar";
import { buildSafePickerRows } from "@/lib/safe-picker";
import { useSafeNicknameNames } from "@/components/onboarding/useSafeNicknameNames";

function Onboarding() {
  const { session, loading } = useSession();
  const signOut = useSignOut();
  const router = useRouter();
  const owned = useOwnedSafes(session?.address);
  const mine = useSafes(session?.address);
  const add = useAddSafe();
  const createApi = useCreateSafeApi();
  const [creating, setCreating] = useState(false);
  const [createStep, setCreateStep] = useState(0);
  const [resume, setResume] = useState<{ address: string; name?: string; chainIds: number[] } | null>(null);
  const nicknameNames = useSafeNicknameNames(session?.address, [...(mine.data ?? []).map((s) => s.address), ...(owned.data ?? []).map((s) => s.address)]);
  useEffect(() => {
    if (!loading && !session) router.replace("/");
  }, [loading, session, router]);

  const bar = onboardingBar({ screen: "safe", path: creating ? "create" : "found", createStep });
  // The session check and the picker share the wide shell and header, so first paint already
  // has the final layout instead of a narrow card that later jumps wider.
  const pickerHeader = bar ? <div className="min-w-0 max-w-md flex-1"><StepBar {...bar} variant="picker" /></div> : undefined;
  if (loading || !session) {
    return (
      <OnboardingCard wide header={pickerHeader} guide={false}>
        <p role="status" className="flex items-center gap-2 text-sm"><Spinner /> Checking your session…</p>
      </OnboardingCard>
    );
  }
  const mineList = mine.data ?? [];
  const accountMismatch = [owned.error, mine.error].some((error) => [401, 403, 409].includes((error as { status?: number } | null)?.status ?? 0));
  const names = new Map(mineList.map((s) => [s.address.toLowerCase(), s.name]));
  const displayName = (address: string, fallback?: string) => nicknameNames[address.toLowerCase()] ?? fallback;
  const go = (address: string, agent: boolean) => router.push(agent ? `/s/${address}/chat` : `/onboarding/agent?safe=${address}`);
  const save = (v: { address: string; name?: string }) => add.mutate(v, { onSuccess: (r) => go(r.address, r.agent) });
  // A Safe already in the list is not saved again: go on to its agent step.
  const pick = (address: string) => (names.has(address.toLowerCase()) ? go(address, false) : save({ address }));
  // The Safes saved earlier that the wallet lookup did not also find — plus every unfinished in-app setup, which shows as
  // a resumable record (not a plain card) even when the lookup also found it on a finished network.
  const pickerRows = buildSafePickerRows(
    (owned.data ?? []).map((s) => ({ ...s, name: displayName(s.address, names.get(s.address.toLowerCase())) })),
    mineList.map((s) => ({ ...s, name: displayName(s.address, s.name) })),
  );
  const openResume = (address: string) => {
    const k = mineList.find((s) => s.address.toLowerCase() === address.toLowerCase());
    setResume({ address, name: k?.name, chainIds: k?.createdChainIds ?? k?.recordedChainIds ?? k?.networks ?? [] });
    setCreating(true);
  };
  const leaveCreate = () => { setCreating(false); setResume(null); void mine.refetch(); };

  if (creating) {
    return (
      <OnboardingCard>
        {bar && <StepBar {...bar} />}
        <GuideIntro topicId="create-safe" />
        <CreateSafe
          embedded
          wallet={session.address}
          api={createApi}
          resume={resume ?? undefined}
          resumeDisplayName={resume ? displayName(resume.address, resume.name) : undefined}
          onProgress={(p) => setCreateStep(p.step)}
          onCancel={leaveCreate}
          onCreated={(safe) => router.push(`/onboarding/agent?safe=${safe.address}&path=create`)}
        />
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard wide header={pickerHeader}>
      <SafeStep
        wallet={session.address}
        onCreate={() => { setResume(null); setCreating(true); }}
        onUseAnotherWallet={() => void signOut()}
        found={pickerRows.found}
        known={pickerRows.known}
        loading={owned.isLoading || owned.isFetching}
        lookupPending={owned.pending && !owned.error}
        discoveryIncomplete={owned.incomplete}
        lookupFailed={!!owned.error && !owned.isFetching}
        savedLoading={mine.isLoading || mine.isFetching || mine.isPending}
        savedLookupFailed={!!mine.error && !mine.isFetching}
        savedFresh={mine.data !== undefined && !mine.error}
        accountMismatch={accountMismatch}
        freshnessByChainId={owned.freshnessByChainId}
        staleAddresses={owned.staleAddresses}
        pendingAddresses={owned.pendingAddresses}
        ownershipPendingByChainId={owned.ownershipPendingByChainId}
        ownershipStaleByChainId={owned.ownershipStaleByChainId}
        balancePendingAddresses={owned.balancePendingAddresses}
        balanceStaleByChainId={owned.balanceStaleByChainId}
        createDisabled={mine.isLoading || mine.isFetching || mine.isPending || !!mine.error || (owned.incomplete && !owned.error) || accountMismatch}
        existing={mineList.map((s) => s.address)}
        busy={add.isPending || mine.isLoading}
        error={add.error?.message ?? null}
        onPick={pick}
        onAdd={save}
        onRetry={() => { void owned.refetch(); void mine.refetch(); }}
        onResume={openResume}
      />
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        Signed in as {shortAddress(getAddress(session.address))} ·{" "}
        <button type="button" className="underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => void signOut()}>
          Use another wallet
        </button>
      </p>
    </OnboardingCard>
  );
}

export default function OnboardingPage() {
  return <Onboarding />;
}
