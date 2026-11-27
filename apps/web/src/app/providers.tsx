"use client";
import type { ReactNode } from "react";
import { WalletProvider } from "@/client/wallet/WalletProvider";
import { GuideProvider } from "@/components/guide/Guide";

export function Providers({ children }: { children: ReactNode }) {
  return <WalletProvider><GuideProvider>{children}</GuideProvider></WalletProvider>;
}
