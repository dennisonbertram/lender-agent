"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { HealthStatus } from "@/lib/loan-math";
import type { Loan, Safe } from "@/lib/types";

/** A loan as the shell shows it: the position plus its health now (from the server). */
export type ShellLoan = Omit<Loan, "debt"> & { debt: number | null; hf: number | null; status: HealthStatus };

/** The Reserve's one status as every surface shows it (BP-40); absent when no Reserve is linked. */
export type ShellReserve = { kind: "armed" | "limitReached" | "paused"; label: string; tone: "success" | "warning" | "muted"; banner: string; balanceUsd: number };

export type ShellState = {
  /** The Safe in the URL. */
  safe: Safe;
  /** Every Safe the signed-in user can open. */
  safes: Safe[];
  /** Loans of the current Safe. */
  loans: ShellLoan[];
  /** The loan read failed: `loans` is empty but unknown, not "none". */
  loansError?: boolean;
  /** Chain ids this Safe is set up on; the first (8453 preferred) is the one the shell links to. */
  chainIds?: readonly number[];
  /** The agent is a proposer on at least one network of this Safe. */
  agentOn: boolean;
  /** The agent is watching this Safe's loans (a worker tick ran recently). */
  watching: boolean;
  /** Checks are failing (not just not started): the header says so. */
  failing?: boolean;
  /** The worker is alive but this Safe has not had its first check yet. */
  starting?: boolean;
  /** Time of the monitor's last check of this Safe (ISO), or null/absent before the first. */
  lastCheckAt?: string | null;
  /** The worker is alive and this Safe has had no check yet. */
  firstCheckDue?: boolean;
  /** The linked Reserve's status, or null/absent when there is none. */
  reserve?: ShellReserve | null;
  /** Wallet identity scopes browser-only nicknames. */
  walletAddress?: string;
  safeName?: (address: string, fallback: string) => string;
  safeNickname?: (address: string) => string | undefined;
  setSafeNickname?: (address: string, value: string) => boolean;
};

const nicknamePrefix = (wallet: string) => `la:safeNickname:${wallet.toLowerCase()}:`;
const nicknameKey = (wallet: string, address: string) => `${nicknamePrefix(wallet)}${address.toLowerCase()}`;
function readNicknames(wallet: string | undefined, addresses: string[]): Record<string, string> {
  if (!wallet || typeof window === "undefined") return {};
  const names: Record<string, string> = {};
  for (const address of addresses) {
    try {
      const raw = localStorage.getItem(nicknameKey(wallet, address));
      if (raw === null) continue;
      const value: unknown = JSON.parse(raw);
      if (typeof value === "string" && value.trim()) names[address.toLowerCase()] = value.trim().replace(/\s+/g, " ").slice(0, 40);
    } catch { /* bad or blocked storage falls back to the default name */ }
  }
  return names;
}

const ShellContext = createContext<ShellState | null>(null);

/** Provides the shell data. A later story fills the props from the server; this component fetches nothing. */
export function ShellProvider({ children, safe, safes, loans, loansError, chainIds, agentOn, watching, failing, starting, lastCheckAt, firstCheckDue, reserve, walletAddress }: ShellState & { children: ReactNode }) {
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [nicknamesWallet, setNicknamesWallet] = useState<string>();
  const addresses = [safe.address, ...safes.map((item) => item.address)];
  useEffect(() => {
    setNicknames(readNicknames(walletAddress, addresses));
    setNicknamesWallet(walletAddress?.toLowerCase());
    const prefix = walletAddress ? nicknamePrefix(walletAddress) : "";
    const onStorage = (event: StorageEvent) => {
      if (!walletAddress || (event.key !== null && !event.key.startsWith(prefix))) return;
      if (event.key === null) setNicknames(readNicknames(walletAddress, addresses));
      else {
        const address = event.key.slice(prefix.length);
        if (!/^0x[\da-f]{40}$/i.test(address)) return;
        const name = readNicknames(walletAddress, [address])[address.toLowerCase()];
        setNicknames((current) => {
          const next = { ...current };
          if (name) next[address.toLowerCase()] = name; else delete next[address.toLowerCase()];
          return next;
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [walletAddress, safe.address, safes]);
  const safeNickname = useCallback((address: string) => walletAddress && nicknamesWallet === walletAddress.toLowerCase() ? nicknames[address.toLowerCase()] : undefined, [nicknames, nicknamesWallet, walletAddress]);
  const safeName = useCallback((address: string, fallback: string) => safeNickname(address) ?? fallback, [safeNickname]);
  const setSafeNickname = useCallback((address: string, input: string) => {
    if (!walletAddress) return false;
    const name = input.trim().replace(/\s+/g, " ").slice(0, 40);
    let stored = false;
    try {
      const key = nicknameKey(walletAddress, address);
      if (name) localStorage.setItem(key, JSON.stringify(name)); else localStorage.removeItem(key);
      stored = true;
    } catch { /* browser storage can be disabled; keep the last confirmed display */ }
    if (stored) {
      setNicknames((current) => {
        const next = { ...current };
        if (name) next[address.toLowerCase()] = name; else delete next[address.toLowerCase()];
        return next;
      });
      setNicknamesWallet(walletAddress.toLowerCase());
    }
    return stored;
  }, [walletAddress]);
  const value = useMemo(() => ({ safe, safes, loans, loansError, chainIds, agentOn, watching, failing, starting, lastCheckAt, firstCheckDue, reserve, walletAddress, safeName, safeNickname, setSafeNickname }), [safe, safes, loans, loansError, chainIds, agentOn, watching, failing, starting, lastCheckAt, firstCheckDue, reserve, walletAddress, safeName, safeNickname, setSafeNickname]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside ShellProvider");
  return ctx;
}

export function useSafeNickname() {
  const ctx = useContext(ShellContext);
  return { safeName: ctx?.safeName ?? ((_address: string, fallback: string) => fallback), safeNickname: ctx?.safeNickname ?? (() => undefined), setSafeNickname: ctx?.setSafeNickname ?? (() => false) };
}

/** The chain the shell shows and links for a Safe: Base when it is set up there, else its first chain. */
export const primaryChain = (chainIds: readonly number[] | undefined): number | undefined => (chainIds?.includes(8453) ? 8453 : chainIds?.[0]);
