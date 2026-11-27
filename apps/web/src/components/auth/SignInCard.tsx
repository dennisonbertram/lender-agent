"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Wallet } from "lucide-react";
import { useAccount, useConnect } from "wagmi";
import { useSession } from "@/client/auth/useSession";
import { GuideIntro } from "@/components/guide/Guide";
import { OnboardingCard } from "@/components/onboarding/OnboardingCard";
import { shortAddress } from "@/lib/address";

const buttonClass =
  "inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-ring";

type Connector = ReturnType<typeof useConnect>["connectors"][number];

const optionClass =
  "inline-flex h-10 w-full items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-ring";

/** Wallets to offer: extensions announced via EIP-6963, the generic `window.ethereum` one only if nothing was announced, and Coinbase. */
function walletChoices(connectors: readonly Connector[]) {
  const hasEthereum = typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const generic = connectors.filter((c) => c.id === "injected" && hasEthereum && announced.length === 0);
  const coinbase = connectors.filter((c) => c.type === "baseAccount" || c.type === "coinbaseWallet");
  const rest = connectors.filter((c) => !announced.includes(c) && !generic.includes(c) && !coinbase.includes(c) && c.id !== "injected");
  return [
    ...announced.map((c) => ({ connector: c, label: c.name })),
    ...generic.map((c) => ({ connector: c, label: "Browser wallet" })),
    ...coinbase.map((c) => ({ connector: c, label: "Coinbase Wallet" })),
    ...rest.map((c) => ({ connector: c, label: c.name })),
  ];
}

export function SignInCard({ returning = false, presentation = "default", className, id }: { returning?: boolean; presentation?: "default" | "hero"; className?: string; id?: string } = {}) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { session, loading: sessionLoading, hasFreshSession, signIn, signingIn, signInError } = useSession();
  const [choosing, setChoosing] = useState(false);
  const [signAfterConnect, setSignAfterConnect] = useState(false);
  const [walletCheckMessage, setWalletCheckMessage] = useState(false);
  const [walletReady, setWalletReady] = useState(false);
  const signing = useRef(false);
  const mock = process.env.NEXT_PUBLIC_MOCK_WALLET === "1";
  const localDemo = process.env.NEXT_PUBLIC_LOCAL_DEMO === "1";
  const authPending = sessionLoading || Boolean(session);
  const guideAvailable = !returning || (!sessionLoading && hasFreshSession && !session);
  const choices = walletReady ? walletChoices(connectors) : [];
  // What the borrower can actually use: `injected()` is always configured, so a connector count lies.
  const noWallet = walletReady && choices.length === 0 && !(mock && connectors.some((c) => c.id === "injected"));
  useEffect(() => setWalletReady(true), []);
  const connectAndSign = (connector: Connector) => {
    if (!walletReady || authPending) return;
    setSignAfterConnect(true);
    connect({ connector });
  };
  // A wallet installed after the page loaded: re-read what the browser offers now.
  const checkAgain = () => {
    if (!walletReady || authPending) return;
    const fresh = walletChoices(connectors);
    setWalletCheckMessage(false);
    if (fresh.length === 1) connectAndSign(fresh[0]!.connector);
    else if (fresh.length > 1) setChoosing(true);
    else setWalletCheckMessage(true);
  };
  // Once the wallet is connected after the click, ask for the signature straight away.
  useEffect(() => {
    if (connectError) setSignAfterConnect(false);
    if (!signAfterConnect || !isConnected || signing.current || sessionLoading) return;
    if (session) {
      setSignAfterConnect(false);
      return;
    }
    signing.current = true;
    setSignAfterConnect(false);
    void signIn().catch(() => {}).finally(() => { signing.current = false; });
  }, [signAfterConnect, isConnected, connectError, sessionLoading, session, signIn]);
  const busy = connecting || signingIn || signAfterConnect || authPending || !walletReady;
  const error = signInError?.message ?? connectError?.message;

  const content = (
    <>
        {presentation === "default" && <>
          <h1 className="text-lg font-medium outline-none">{returning ? "Sign in to continue" : "Borrow cash against your crypto"}</h1>
          {returning && <p className="text-sm text-muted-foreground">You will go back to the page you opened.</p>}
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
            <li>Tell Lender agent how much cash you need.</li>
            <li>It finds loan offers and prepares each step. It cannot move money.</li>
            <li>You approve every step in your Safe, a crypto wallet that only moves money when its owners approve.</li>
          </ol>
        </>}
        {!returning && presentation === "default" && (
          <p className="text-xs text-muted-foreground">
            The money you borrow arrives in your Safe as USDC — digital dollars. Sending it to a bank account is a separate transfer.
          </p>
        )}
        <button type="button" className={buttonClass} data-guide-target="sign-in" disabled={busy} aria-describedby={!isConnected && noWallet ? "no-wallet-note" : undefined} aria-expanded={isConnected ? undefined : choosing} onClick={() => {
          if (!walletReady || authPending) return;
          if (isConnected) { void signIn().catch(() => {}); return; }
          if (noWallet) { checkAgain(); return; }
          const direct = localDemo ? connectors.find((c) => c.id === "local-demo") : mock ? connectors.find((c) => c.id === "injected") : choices.length === 1 ? choices[0]!.connector : undefined;
          if (direct) connectAndSign(direct);
          else setChoosing((v) => !v);
        }}>
          <Wallet className="size-4" /> {sessionLoading ? "Checking session…" : session ? "Opening your app…" : !walletReady ? "Checking wallet…" : connecting ? "Connecting…" : signingIn || signAfterConnect ? "Waiting for your wallet…" : presentation === "hero" && !isConnected ? "Connect wallet" : !isConnected && noWallet ? "Check again" : "Sign in with wallet"}
        </button>
        {!isConnected && choosing && !connecting && (
          <ul aria-label="Choose a wallet" className="flex flex-col gap-2">
            {choices.map(({ connector, label }) => (
              <li key={connector.uid ?? connector.id}>
                <button type="button" className={optionClass} onClick={() => connectAndSign(connector)}>
                  {connector.icon ? <img src={connector.icon} alt="" className="size-5 rounded" /> : <Wallet className="size-5" />}
                  {label}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!isConnected && noWallet && (
          <p id="no-wallet-note" className="text-xs text-muted-foreground">
            No wallet found in this browser. A wallet is an app or browser extension that holds your crypto. Install one, then choose {presentation === "hero" ? "Connect wallet" : "Check again"}.{" "}
            <a href="https://ethereum.org/wallets/find-wallet/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
              How to choose a wallet<span className="sr-only"> (opens a new tab)</span>
            </a>
          </p>
        )}
        {!isConnected && noWallet && walletCheckMessage && (
          <p role="status" className="text-xs text-muted-foreground">Still no wallet detected. If you just installed one, reload this page so the browser can detect it, then choose {presentation === "hero" ? "Connect wallet" : "Check again"}.</p>
        )}
        {!isConnected && !noWallet && <p className="text-xs text-muted-foreground">You need a crypto wallet app. Signing in is free and sends nothing.</p>}
        {isConnected && <p className="text-xs text-muted-foreground">Signing proves you own this wallet. No transaction is sent.</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {isConnected && address && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3 text-success" /> Wallet connected {shortAddress(address)}
          </p>
        )}
    </>
  );

  if (presentation === "hero") return <div className={className} id={id}>{content}</div>;
  return <OnboardingCard guide={guideAvailable}>{content}{returning && guideAvailable && <GuideIntro topicId="welcome" />}</OnboardingCard>;
}
