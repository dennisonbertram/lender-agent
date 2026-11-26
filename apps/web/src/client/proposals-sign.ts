"use client";
// Hooks for an owner to sign and send a queued proposal from the app. The server rebuilds everything
// from the stored transaction; the wallet signs exactly the typed data the server returns, after the
// client recomputes its hash and compares it with the server's. Errors are `ProposalActionError`s.
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { hashTypedData, type Hex } from "viem";
import { useAccount, useSendTransaction, useSignTypedData, useSwitchChain } from "wagmi";
import { ApiError } from "@/client/http";
import type { ProposalView } from "@/server/proposals/view";
import type { ChainId } from "@/shared/types";

export type ProposalActionErrorKind =
  | "wallet_rejected" // the person cancelled in the wallet
  | "wrong_chain" // the wallet would not switch to the Safe's network
  | "not_owner" // this wallet is not a current owner on that network
  | "already_signed"
  | "out_of_date"
  | "simulation_failed" // the transaction would revert: Send is not offered
  | "not_ready" // not enough signatures, blocked by an earlier nonce, not queued
  | "hash_mismatch" // what the server sent does not hash to what it claims: nothing was signed
  | "insufficient_funds" // the wallet cannot pay the network fee to send
  | "cancelled" // the page that asked for an automatic approval is gone or moved on: nothing was asked of the wallet
  | "wallet_unsupported" // the wallet cannot sign typed data (contract wallet): use approveHash
  | "server"
  | "unknown";

export class ProposalActionError extends Error {
  constructor(public readonly kind: ProposalActionErrorKind, message: string, public readonly detail?: unknown) {
    super(message);
    this.name = "ProposalActionError";
  }
}

/** Map anything a wallet or fetch throws to a ProposalActionError. */
export function toActionError(e: unknown): ProposalActionError {
  if (e instanceof ProposalActionError) return e;
  if (e instanceof ApiError) {
    const kind: ProposalActionErrorKind = e.status === 403 ? "not_owner" : e.status === 409 ? "not_ready" : "server";
    return new ProposalActionError(kind, e.message, e);
  }
  const err = e as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  const code = err?.code ?? err?.cause?.code;
  const text = `${err?.name ?? ""} ${err?.shortMessage ?? err?.message ?? ""}`;
  if (code === 4001 || /UserRejected|User rejected|denied|rejected the request/i.test(text)) return new ProposalActionError("wallet_rejected", "You cancelled in your wallet. Nothing was signed.", e);
  if (code === 4200 || code === -32601 || /UnsupportedProviderMethod|method .* not (found|supported)/i.test(text)) return new ProposalActionError("wallet_unsupported", "This wallet cannot sign this kind of message.", e);
  if (/SwitchChain|chain.*(mismatch|switch)|ChainMismatch|4902|unrecognized chain/i.test(text) || code === 4902) return new ProposalActionError("wrong_chain", "Your wallet is on a different network. Switch to the Safe's network and try again.", e);
  if (/insufficient funds|InsufficientFunds|exceeds.*balance/i.test(text)) return new ProposalActionError("insufficient_funds", "This wallet doesn't have enough ETH for the network fee.", e);
  return new ProposalActionError("unknown", err?.shortMessage ?? err?.message ?? "Something went wrong. Try again.", e);
}

const call = async <T,>(url: string, method: "GET" | "POST", body?: unknown): Promise<T> => {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "Something went wrong");
  return data as T;
};

const proposalKey = (address: string, id: string) => ["proposals", address.toLowerCase(), id] as const;

export type SignData = {
  typedData: { domain: { chainId: number; verifyingContract: Hex }; types: Record<string, { name: string; type: string }[]>; primaryType: "SafeTx"; message: Record<string, string | number> };
  safeTxHash: Hex;
  domainHash: Hex;
  messageHash: Hex;
  fields: { safe: Hex; chainId: ChainId; to: Hex; value: string; operation: number; nonce: string; dataSelector: Hex | null; dataBytes: number };
  owners: Hex[];
  threshold: number;
  signedBy: Hex[];
  canSign: boolean;
  reasons: { code: string; message: string; blocksSigning: boolean }[];
  blockedBy: { id: string | null; nonce: string; title: string | null }[];
};

export type ExecuteData = {
  ready: boolean;
  needs: "ok" | "blocked" | "underSigned" | "outdated" | "refused" | "simulation_failed";
  reason: string | null;
  to: Hex;
  chainId: ChainId;
  safeTxHash: Hex | null;
  data: Hex | null;
  signatures: Hex | null;
  gas: string | null;
  gasLimit: string | null;
  fee: { eth: string; usd: number | null } | null;
  simulation: { ok: boolean; error?: string } | null;
  blockedBy: { id: string | null; nonce: string; title: string | null }[];
  includesYourApproval: boolean;
  nonce: { chain: string; tx: string | null };
};

/** Read-only: what the wallet will be asked to sign, and why it may not be. */
export const useSignData = (address: string, id: string, enabled = true) =>
  useQuery({ enabled, queryKey: ["proposals", address.toLowerCase(), id, "sign-data"], queryFn: () => call<SignData>(`/api/safes/${address}/proposals/${id}/sign-data`, "GET"), staleTime: 0 });

/** Read-only: the Send transaction, its simulation result and the network fee. */
export const useExecuteData = (address: string, id: string, enabled = true) =>
  useQuery({ enabled, queryKey: ["proposals", address.toLowerCase(), id, "execute-data"], queryFn: () => call<ExecuteData>(`/api/safes/${address}/proposals/${id}/execute-data`, "GET"), staleTime: 0 });

async function ensureChain(current: number | undefined, wanted: ChainId, switchChainAsync: (a: { chainId: number }) => Promise<unknown>) {
  if (current === wanted) return;
  try {
    await switchChainAsync({ chainId: wanted });
  } catch (e) {
    const a = toActionError(e);
    throw a.kind === "wallet_rejected" ? a : new ProposalActionError("wrong_chain", "Your wallet is on a different network. Switch to the Safe's network and try again.", e);
  }
}

/** Settle the cache with the answer, then refetch everything for this Safe's proposals. */
function settle(qc: QueryClient, address: string, id: string, proposal?: ProposalView) {
  if (proposal) qc.setQueryData(proposalKey(address, id), proposal);
  void qc.invalidateQueries({ queryKey: ["proposals", address.toLowerCase()] });
}

/** Refetch the proposal every few seconds until it is final (or a couple of minutes pass): the server follower settles executed/failed. */
function pollUntilFinal(qc: QueryClient, address: string, id: string, everyMs = 4000, maxMs = 3 * 60_000) {
  const t0 = Date.now();
  const tick = async () => {
    await qc.invalidateQueries({ queryKey: ["proposals", address.toLowerCase()] });
    const v = qc.getQueryData<ProposalView>(proposalKey(address, id));
    if (v?.final || Date.now() - t0 > maxMs) return;
    setTimeout(() => void tick(), everyMs);
  };
  setTimeout(() => void tick(), everyMs);
}

/** Switch network, fetch the typed data, verify its hash locally, sign in the wallet, POST it. */
export function useSignProposal(address: string, id: string, opts: { onWalletSigned?: () => void; /** Asked right before the wallet request opens; false stops the signature (an automatic start whose page went away). */ beforeWallet?: () => boolean } = {}) {
  const qc = useQueryClient();
  const { chainId: walletChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  return useMutation<ProposalView, ProposalActionError, void, { prev?: ProposalView }>({
    mutationFn: async () => {
      try {
        const d = await call<SignData>(`/api/safes/${address}/proposals/${id}/sign-data`, "GET");
        const blocker = d.reasons.find((r) => r.blocksSigning);
        if (!d.canSign || blocker) {
          const code = blocker?.code;
          throw new ProposalActionError(code === "not_owner" ? "not_owner" : code === "already_signed" ? "already_signed" : code === "out_of_date" ? "out_of_date" : "not_ready", blocker?.message ?? "This cannot be signed now.");
        }
        const message = {
          to: d.typedData.message.to as Hex, value: BigInt(d.typedData.message.value), data: d.typedData.message.data as Hex, operation: Number(d.typedData.message.operation),
          safeTxGas: BigInt(d.typedData.message.safeTxGas), baseGas: BigInt(d.typedData.message.baseGas), gasPrice: BigInt(d.typedData.message.gasPrice),
          gasToken: d.typedData.message.gasToken as Hex, refundReceiver: d.typedData.message.refundReceiver as Hex, nonce: BigInt(d.typedData.message.nonce),
        };
        const typed = { domain: d.typedData.domain, types: d.typedData.types, primaryType: "SafeTx" as const, message };
        if (hashTypedData(typed as never).toLowerCase() !== d.safeTxHash.toLowerCase()) {
          throw new ProposalActionError("hash_mismatch", "What the server sent does not match its own hash. Nothing was signed.");
        }
        await ensureChain(walletChain, d.fields.chainId, switchChainAsync);
        if (opts.beforeWallet && !opts.beforeWallet()) throw new ProposalActionError("cancelled", "The approval was not started.");
        const signature = await signTypedDataAsync(typed as never);
        opts.onWalletSigned?.(); // the wallet is done: the page shows "Saving…" at once while the server records it
        return (await call<{ proposal: ProposalView }>(`/api/safes/${address}/proposals/${id}/confirm`, "POST", { signature })).proposal;
      } catch (e) {
        throw toActionError(e);
      }
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: proposalKey(address, id) });
      const prev = qc.getQueryData<ProposalView>(proposalKey(address, id));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(proposalKey(address, id), ctx.prev);
    },
    // The optimistic step is applied once the wallet has signed (not before: a cancelled prompt must not flash "signed").
    onSuccess: (proposal) => settle(qc, address, id, proposal),
  });
}

/** Fetch the Send transaction, refuse on a failed simulation, send it from the wallet, tell the server, poll. */
export function useExecuteProposal(address: string, id: string, opts: { onSubmitted?: (txHash: Hex) => void } = {}) {
  const qc = useQueryClient();
  const { chainId: walletChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  return useMutation<{ txHash: Hex; proposal: ProposalView | null }, ProposalActionError, void>({
    mutationFn: async () => {
      try {
        const d = await call<ExecuteData>(`/api/safes/${address}/proposals/${id}/execute-data`, "GET");
        if (!d.ready || !d.data) {
          throw new ProposalActionError(d.needs === "simulation_failed" ? "simulation_failed" : d.needs === "outdated" ? "out_of_date" : "not_ready", d.reason ?? "This cannot be sent now.", d);
        }
        await ensureChain(walletChain, d.chainId, switchChainAsync);
        const txHash = await sendTransactionAsync({ to: d.to, data: d.data, chainId: d.chainId, ...(d.gasLimit ? { gas: BigInt(d.gasLimit) } : {}) } as never);
        opts.onSubmitted?.(txHash); // the wallet sent it: the page shows "Sending…" until the server settles it
        // The hash is a hint for the server (it keeps the card from going out of date while Safe indexes it).
        const proposal = await call<{ proposal: ProposalView }>(`/api/safes/${address}/proposals/${id}/executed`, "POST", { txHash }).then((r) => r.proposal).catch(() => null);
        return { txHash, proposal };
      } catch (e) {
        throw toActionError(e);
      }
    },
    onSuccess: ({ proposal }) => {
      settle(qc, address, id, proposal ?? undefined);
      pollUntilFinal(qc, address, id);
    },
  });
}
