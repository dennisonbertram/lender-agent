// Safe{Wallet} links (M0-2).
import { getAddress } from "viem";
import { safeShortName } from "@/lib/explorer";
import type { Address, ChainId, Hex } from "@/shared/types";

const APP = "https://app.safe.global";

export function safeTxLink(chainId: ChainId, safe: Address, safeTxHash: Hex): string {
  return `${APP}/transactions/tx?id=multisig_${getAddress(safe)}_${safeTxHash}&safe=${safeShortName(chainId, safe)}`;
}

export function safeQueueLink(chainId: ChainId, safe: Address): string {
  return `${APP}/transactions/queue?safe=${safeShortName(chainId, safe)}`;
}
