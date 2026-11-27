"use client";
// A stranger's view of a plan: no plan data, a way to connect an owner's wallet (sign-flow spec "wrong wallet").
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useDisconnect } from "wagmi";
import { useSignOut } from "@/client/auth/useSession";
import { PageHeader } from "@/components/common";
import { GuideButton } from "@/components/guide/Guide";
import { ActionBar } from "@/components/ui/action-bar";
import { Button } from "@/components/ui/button";

export function WrongWallet({ returnTo }: { returnTo?: string }) {
  const signOut = useSignOut();
  const qc = useQueryClient();
  const { disconnect } = useDisconnect();
  const router = useRouter();
  // Switch wallet: end this session and the wallet connection, then land on the connect chooser that returns here.
  const switchWallet = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    disconnect();
    qc.clear();
    router.replace(returnTo ? `/?next=${encodeURIComponent(returnTo)}` : "/");
  }, [disconnect, qc, router, returnTo]);
  return (
    <div data-state="wrong_wallet" className="mx-auto flex w-full max-w-[640px] flex-col">
      <div className="p-4"><PageHeader title="This needs a different wallet" sub="You're connected with a wallet that isn't an owner of this Safe. This plan needs approval from an owner." right={<GuideButton />} /></div>
      <ActionBar
        headline="This needs a different wallet"
        primary={<Button size="xl" onClick={() => void switchWallet()}>Switch wallet</Button>}
        secondary={[<button key="o" type="button" className="inline-flex min-h-11 items-center underline underline-offset-2" onClick={() => void signOut()}>Sign out</button>]}
      />
    </div>
  );
}
