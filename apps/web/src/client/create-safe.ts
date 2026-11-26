"use client";
// Client side of Create a Safe: the wallet signs the setup (and, when the user pays the fee, sends the deployment).
// The server only ever sees the signature (G2).
import { useMemo } from "react";
import { useConfig, useSendTransaction, useSignMessage, useSwitchChain } from "wagmi";
import { getAccount, waitForTransactionReceipt } from "wagmi/actions";
import { safeNetworkName } from "@/lib/safe-create";
import type { CreateSafeApi } from "@/components/onboarding/CreateSafe";

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? "Something went wrong. Try again.");
  return data as T;
}

/** The wallet must be on the network the Safe is being set up on. Switch it, or refuse before anything is sent. */
export async function ensureWalletChain(current: number | undefined, wanted: number, switchChain: (chainId: number) => Promise<unknown>): Promise<void> {
  if (current === wanted) return;
  try {
    await switchChain(wanted);
  } catch {
    throw new Error(`Switch your wallet to ${safeNetworkName(wanted)} to pay the setup fee.`);
  }
}

/** The payment account must still be the account that authenticated the setup. */
export function assertWalletOwner(connected: string | undefined, owner: string): void {
  if (!connected || connected.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Your connected wallet changed. Reconnect the wallet you used to sign in before paying.");
  }
}

/** Classify the transaction that replaced the submitted hash after Viem observes its receipt. */
export function classifySetupPaymentReplacement(
  replacement: { reason: "repriced" | "replaced" | "cancelled"; transaction: { hash: string; to: string | null; input: string; value: bigint } },
  intended: { to: string; data: string; value?: bigint },
): { outcome: "setup" | "cancelled" | "replaced"; hash: string } {
  if (replacement.reason === "cancelled") return { outcome: "cancelled", hash: replacement.transaction.hash };
  const tx = replacement.transaction;
  const isSameSetupCall = tx.to?.toLowerCase() === intended.to.toLowerCase()
    && tx.input.toLowerCase() === intended.data.toLowerCase()
    && tx.value === (intended.value ?? 0n);
  return { outcome: isSameSetupCall ? "setup" : "replaced", hash: tx.hash };
}

export function useCreateSafeApi(): CreateSafeApi {
  const { signMessageAsync } = useSignMessage();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const config = useConfig();
  return useMemo<CreateSafeApi>(() => ({
    preview: (d) => call("/api/safes/create/preview", "POST", d),
    async create(d, pv) {
      const signature = await signMessageAsync({ message: pv.message });
      return call("/api/safes/create", "POST", { ...d, index: pv.index, signature });
    },
    setup: (address, chainId, txHash) => call(`/api/safes/${address}/setup`, "POST", { chainId, txHash }),
    reconcile: (address, chainId) => call(`/api/safes/${address}/setup`, "POST", { chainId, reconcile: true }),
    async payFee(tx, chainId, onSent, owner) {
      // Check the connected account before and after switching: a changed extension account must never pay this Safe's fee.
      assertWalletOwner(getAccount(config).address, owner);
      await ensureWalletChain(getAccount(config).chainId, chainId, (id) => switchChainAsync({ chainId: id }));
      assertWalletOwner(getAccount(config).address, owner);
      const hash = await sendTransactionAsync({ to: tx.to, data: tx.data, chainId: chainId as never });
      onSent?.(hash);
      let replacementOutcome: "setup" | "cancelled" | "replaced" | undefined;
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: chainId as never,
        onReplaced(replacement) {
          const classified = classifySetupPaymentReplacement(replacement, tx);
          replacementOutcome = classified.outcome;
          if (classified.outcome === "setup") onSent?.(classified.hash);
        },
      });
      if (replacementOutcome === "cancelled") throw new Error(`Payment was cancelled on ${safeNetworkName(chainId)}. The Safe was not deployed; review the fee before trying again.`);
      if (replacementOutcome === "replaced") throw new Error(`A different transaction replaced the setup payment on ${safeNetworkName(chainId)}. The Safe was not deployed; check its status and review the fee before trying again.`);
      if (receipt.status === "reverted") throw new Error(`Payment reverted on ${safeNetworkName(chainId)}. The Safe was not deployed; you can review the fee and try again.`);
      return replacementOutcome === "setup" ? (receipt.transactionHash ?? hash) : hash;
    },
    async indexed(address, chainId) {
      return (await call<{ indexed: boolean }>(`/api/safes/${address}/setup?chainId=${chainId}`, "GET")).indexed;
    },
  }), [signMessageAsync, sendTransactionAsync, switchChainAsync, config]);
}
