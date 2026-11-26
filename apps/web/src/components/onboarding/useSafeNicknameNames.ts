"use client";

import { useEffect, useState } from "react";
import { readSafeNickname, safeNicknameStoragePrefix } from "@/components/shell/ShellContext";

const EMPTY_NAMES: Record<string, string> = {};

/** Wallet-scoped, display-only aliases for the Safe cards in an onboarding view. */
export function useSafeNicknameNames(walletAddress: string | undefined, safeAddresses: readonly string[]) {
  const walletKey = walletAddress?.toLowerCase();
  const addressKey = [...new Set(safeAddresses.map((address) => address.toLowerCase()))].sort().join("|");
  const [snapshot, setSnapshot] = useState<{ wallet: string; addresses: string; names: Record<string, string> }>();

  useEffect(() => {
    if (!walletAddress || !walletKey) { setSnapshot(undefined); return; }
    const addresses = addressKey ? addressKey.split("|") : [];
    const load = () => {
      const names: Record<string, string> = {};
      for (const address of addresses) {
        const alias = readSafeNickname(walletAddress, address);
        if (alias) names[address] = alias;
      }
      setSnapshot({ wallet: walletKey, addresses: addressKey, names });
    };
    load();
    const prefix = safeNicknameStoragePrefix(walletAddress);
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(prefix)) load(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [walletAddress, walletKey, addressKey]);

  return walletKey && snapshot?.wallet === walletKey && snapshot.addresses === addressKey ? snapshot.names : EMPTY_NAMES;
}
