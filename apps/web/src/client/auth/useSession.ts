"use client";
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useAccount, useChainId, useDisconnect, useSignMessage } from "wagmi";
import { buildSignInMessage } from "@/server/auth/siwe-message";

const KEY = ["session"] as const;

async function fetchSession(): Promise<{ address: string } | null> {
  const res = await fetch("/api/auth/session");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error("Could not read the session");
  return res.json();
}

export function useSession() {
  const qc = useQueryClient();
  const { address } = useAccount();
  const walletChain = useChainId();
  // Sign in on a network the server accepts; the wallet may sit on any of the Safe-creation networks.
  const chainId = walletChain === 84532 ? 84532 : 8453;
  const { signMessageAsync } = useSignMessage();

  const session = useQuery({ queryKey: KEY, queryFn: fetchSession });

  const signInMutation = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Connect a wallet first");
      const { nonce } = await (await fetch("/api/auth/nonce")).json();
      const message = buildSignInMessage({ domain: window.location.host, uri: window.location.origin, chainId, address, nonce });
      const signature = await signMessageAsync({ message });
      const res = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Sign-in failed");
      return res.json() as Promise<{ address: string }>;
    },
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });

  const signOutMutation = useMutation({
    mutationFn: () => fetch("/api/auth/logout", { method: "POST" }),
    onSuccess: () => qc.setQueryData(KEY, null),
  });

  return {
    session: session.data ?? null,
    loading: session.isLoading,
    hasFreshSession: session.isSuccess && session.isFetchedAfterMount,
    signIn: useCallback(() => signInMutation.mutateAsync(), [signInMutation]),
    signingIn: signInMutation.isPending,
    signInError: signInMutation.error as Error | null,
    signOut: useCallback(() => signOutMutation.mutateAsync(), [signOutMutation]),
  };
}

/** Sign out everywhere: server session, wallet connection, cached data, then back to the sign-in page. */
export function useSignOut() {
  const qc = useQueryClient();
  const { disconnect } = useDisconnect();
  const router = useRouter();
  return useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    disconnect();
    qc.clear();
    router.replace("/");
  }, [qc, disconnect, router]);
}
