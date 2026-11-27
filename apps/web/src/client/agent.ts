"use client";
// Hooks for the agent's proposer role: read status, add (one wallet signature per deployed
// network), remove (one per network where it is on). The server confirms by reading the live
// delegate list back; the UI shows success only from that answer.
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSignTypedData } from "wagmi";
import { ApiError } from "@/client/http";
import { safeSummaryKey } from "@/client/safes";
import type { AgentStatus } from "@/server/agent-role";
import { CHAIN_NAME, type ChainId } from "@/shared/types";

export type { AgentStatus };
export const CHAIN_NAMES: Record<number, string> = CHAIN_NAME;
export const chainName = (id: number) => CHAIN_NAMES[id] ?? `Network ${id}`;
export type SigningProgress = { chainId: ChainId; network: string; n: number; total: number };

const statusKey = (address: string) => ["agent", address.toLowerCase()] as const;

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "Something went wrong. Try again.");
  return data as T;
}

export function useAgentStatus(address: string) {
  return useQuery({ queryKey: statusKey(address), queryFn: () => call<AgentStatus>(`/api/safes/${address}/agent`, "GET"), refetchOnMount: "always" });
}

type WireTypedData = {
  chainId: ChainId;
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: { delegateAddress: `0x${string}`; totp: string };
};

function useSignDelegate(address: string) {
  const { signTypedDataAsync } = useSignTypedData();
  return useCallback(async (chainId: ChainId) => {
    const td = await call<WireTypedData>(`/api/safes/${address}/agent/typed-data`, "POST", { chainId });
    return signTypedDataAsync({
      domain: td.domain,
      types: td.types,
      primaryType: "Delegate",
      message: { delegateAddress: td.message.delegateAddress, totp: BigInt(td.message.totp) },
    } as never);
  }, [address, signTypedDataAsync]);
}

/** Add the agent on each deployed network that does not have it. A cancelled prompt throws and changes nothing further; retry continues. */
export function useAddAgent(address: string) {
  const qc = useQueryClient();
  const sign = useSignDelegate(address);
  const [progress, setProgress] = useState<SigningProgress | null>(null);
  const m = useMutation({
    /** `only` limits it to one network (the Settings row); without it, every deployed network that lacks the agent. */
    mutationFn: async (only?: ChainId): Promise<AgentStatus> => {
      let status = await call<AgentStatus>(`/api/safes/${address}/agent`, "GET");
      const eligible = new Set(status.eligibleChainIds);
      const requested = only === undefined ? undefined : status.networks.find((n) => n.chainId === only);
      if (requested?.deployed && !requested.added && !eligible.has(requested.chainId)) {
        const network = chainName(requested.chainId);
        throw new ApiError(403, `Your wallet is not an owner of this Safe on ${network}. Switch to a wallet that owns it on ${network}, then try again.`);
      }
      const todo = status.networks.filter((n) => eligible.has(n.chainId) && n.deployed && !n.added && (only === undefined || n.chainId === only));
      try {
        for (const [i, n] of todo.entries()) {
          setProgress({ chainId: n.chainId, network: chainName(n.chainId), n: i + 1, total: todo.length });
          const signature = await sign(n.chainId);
          status = await call<AgentStatus>(`/api/safes/${address}/agent`, "POST", { chainId: n.chainId, signature });
        }
      } finally {
        setProgress(null);
      }
      return status;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: safeSummaryKey(address) }),
    onSettled: () => qc.invalidateQueries({ queryKey: statusKey(address) }),
  });
  return { add: (only?: ChainId) => m.mutateAsync(only), adding: m.isPending, progress, error: m.error as Error | null, reset: m.reset };
}

/** Add a network to the Safe (a row on the server); the agent is added afterwards, one signature there if the Safe is set up. */
export function useAddNetwork(address: string) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (chainId: ChainId) => call<AgentStatus>(`/api/safes/${address}/networks`, "POST", { chainId }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: statusKey(address) }), qc.invalidateQueries({ queryKey: ["loans", address.toLowerCase()] })]),
  });
  return { addNetwork: m.mutateAsync, adding: m.isPending, error: m.error as Error | null, reset: m.reset };
}

/** Remove the agent: one signature on each network where it is on, then one server call. */
export function useRemoveAgent(address: string) {
  const qc = useQueryClient();
  const sign = useSignDelegate(address);
  const [progress, setProgress] = useState<SigningProgress | null>(null);
  const m = useMutation({
    mutationFn: async (): Promise<AgentStatus> => {
      const status = await call<AgentStatus>(`/api/safes/${address}/agent`, "GET");
      const on = status.networks.filter((n) => n.added);
      const signatures: { chainId: ChainId; signature: string }[] = [];
      try {
        for (const [i, n] of on.entries()) {
          setProgress({ chainId: n.chainId, network: chainName(n.chainId), n: i + 1, total: on.length });
          signatures.push({ chainId: n.chainId, signature: await sign(n.chainId) });
        }
      } finally {
        setProgress(null);
      }
      return call<AgentStatus>(`/api/safes/${address}/agent`, "DELETE", { signatures });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: safeSummaryKey(address) }),
    onSettled: () => qc.invalidateQueries({ queryKey: statusKey(address) }),
  });
  return { remove: m.mutateAsync, removing: m.isPending, progress, error: m.error as Error | null, reset: m.reset };
}
