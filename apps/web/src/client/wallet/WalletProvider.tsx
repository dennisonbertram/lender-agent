"use client";
import { useState, type ReactNode } from "react";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { ApiError, retryTransient } from "@/client/http";
import { wagmiConfig } from "./config";
import { maybeInstallMockWallet } from "./dev-provider";

// Legacy mock/fork modes may install the dev wallet on an empty `window.ethereum`. Dedicated local-demo mode
// supplies its own wagmi target and never changes the browser's wallet object.
if (process.env.NEXT_PUBLIC_LOCAL_DEMO !== "1") maybeInstallMockWallet();

const SESSION_KEY = ["session"] as const;

/** One retry rule for every read (network only, never an HTTP answer), and a 401 anywhere ends the client session. */
export function makeQueryClient() {
  const queryCache: QueryCache = new QueryCache({
    onError: (error, query) => {
      if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== SESSION_KEY[0]) {
        queryClient.setQueryData(SESSION_KEY, null);
      }
    },
  });
  const queryClient: QueryClient = new QueryClient({ queryCache, defaultOptions: { queries: { retry: retryTransient } } });
  return queryClient;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
