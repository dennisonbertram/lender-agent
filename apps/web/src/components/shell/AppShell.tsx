"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Menu, MessageSquare, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { agentButtonLabel } from "@/lib/loan-copy";
import { attentionOf } from "@/lib/loan-math";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Sidebar, SafePicker, safePaths } from "./Sidebar";
import { TxToastProvider } from "@/components/wallet/TxToasts";
import { GuideButton } from "@/components/guide/Guide";
import { primaryChain, useShell } from "./ShellContext";
import { CHAIN_IDS, CHAIN_NAME, isChainId } from "@/shared/types";
import { NetworkMark } from "@/components/ui/network-mark";
import { keyboardViewport } from "@/components/ui/keyboard-viewport";

/** Tracks a media query. False on the server and until mounted. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export type AppShellProps = {
  children: ReactNode;
  /** The chat panel. Docked at 1100px and wider, a bottom sheet below. A function receives a `close` callback. Omit to hide the agent button. */
  chat?: ReactNode | ((close: () => void) => ReactNode);
  /** Short name of the signed-in user, shown at the bottom of the sidebar. */
  userLabel?: string;
  /** The signed-in address, so the sidebar can tell when the connected wallet is another one. */
  userAddress?: string;
  /** Chain ids where the Safe is set up and owned by the signed-in user; the wallet menu sends only there. */
  ownedChainIds?: readonly number[];
  /** Signs the user out (Sidebar button, also in the phone menu). */
  onSignOut?: () => void;
};

// Chains in CHAIN_NAME that are test networks (Arbitrum 42161 and Base 8453 are mainnets).
const TESTNET_IDS: ReadonlySet<number> = new Set([CHAIN_IDS.baseSepolia]);

export function AppShell({ children, chat, userLabel, userAddress, ownedChainIds, onSignOut }: AppShellProps) {
  const { safe, safes, loans, loansError, reserve, chainIds } = useShell();
  const chainId = primaryChain(chainIds);
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [chatDocked, setChatDocked] = useState(true);
  const [chatSheet, setChatSheet] = useState(false);
  const [navSheet, setNavSheet] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const showSidebar = useMedia("(min-width: 768px)");
  const showChat = useMedia("(min-width: 1100px)");
  // The page is the chat: no side panel or header button. Addresses in URLs may be lowercased.
  const onChat = pathname.toLowerCase() === safePaths(safe.address).chat.toLowerCase();
  const hasChat = chat !== undefined;
  const docked = hasChat && showChat && chatDocked && !onChat;
  const risk = attentionOf(loans).risk;
  const riskLoans = loans.filter((l) => l.status === "risk" || l.status === "liquidatable");
  const riskHref = riskLoans.length === 1 ? safePaths(safe.address).loan(riskLoans[0].id) : safePaths(safe.address).overview;

  useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [pathname]);

  // Some mobile browsers resize only the visual viewport when the keyboard opens.
  // Match that viewport at the normal zoom level; leave browser pinch zoom alone.
  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = shellRef.current;
    if (!viewport || !shell) return;
    const syncVisibleViewport = () => {
      const visible = keyboardViewport();
      if (!visible) {
        shell.style.height = "";
        shell.style.top = "";
        return;
      }
      shell.style.height = `${visible.height}px`;
      shell.style.top = `${viewport.offsetTop}px`;
    };
    syncVisibleViewport();
    viewport.addEventListener("resize", syncVisibleViewport);
    viewport.addEventListener("scroll", syncVisibleViewport);
    return () => {
      viewport.removeEventListener("resize", syncVisibleViewport);
      viewport.removeEventListener("scroll", syncVisibleViewport);
    };
  }, []);

  useEffect(() => setNavSheet(false), [pathname]);
  // Links navigate themselves; the Safe picker's menu items need the router.
  const go = (href: string) => router.push(href);
  const statusesBySafe = { [safe.id]: loans.map((l) => l.status) };
  const renderChat = (close: () => void) => (typeof chat === "function" ? chat(close) : chat);

  return (
    <TxToastProvider>
    <div ref={shellRef} className="relative flex h-dvh flex-col overflow-hidden">
    {chainId !== undefined && isChainId(chainId) && TESTNET_IDS.has(chainId) && (
      <p role="note" className="flex shrink-0 items-center justify-center gap-1.5 border-b border-warning-text/30 bg-warning/15 px-3 py-1 text-xs text-warning-text"><NetworkMark id={chainId} />Test network: {CHAIN_NAME[chainId]}</p>
    )}
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <a href="#main-content" className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-2 focus-visible:top-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-background focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:ring-2 focus-visible:ring-ring">Skip to content</a>
      {showSidebar && <aside className="w-[232px] shrink-0 border-r border-sidebar-border"><Sidebar safe={safe} safes={safes} statusesBySafe={statusesBySafe} chainId={chainId} loans={loans} loansError={loansError} pathname={pathname} onNavigate={go} userLabel={userLabel} userAddress={userAddress} reserve={reserve} ownedChainIds={ownedChainIds} onSignOut={onSignOut} /></aside>}

      <main id="main-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col focus:outline-none">
        {(!showSidebar || (hasChat && !docked && !onChat)) && (
        <header className="flex items-center gap-2 border-b border-border p-2 pl-3">
          {!showSidebar && (
            <Button variant="ghost" size="icon" aria-label="Menu" onClick={() => setNavSheet(true)}><Menu /></Button>
          )}
          {!showSidebar && <SafePicker compact safe={safe} safes={safes} statusesBySafe={statusesBySafe} chainId={chainId} onNavigate={go} />}
          {!showSidebar && <GuideButton />}
          {!showChat && risk > 0 && (
            <Link href={riskHref} className="ml-auto shrink-0"><Badge variant="destructive" className="h-6 gap-1"><TriangleAlert className="size-3.5" aria-hidden />{risk === 1 ? "1 loan needs action" : `${risk} loans need action`}</Badge></Link>
          )}
          {hasChat && !docked && !onChat && (
            <Button variant="outline" size="icon" className={cn("relative", risk > 0 && !showChat ? "" : "ml-auto")} aria-label={agentButtonLabel(risk)} onClick={() => { setChatDocked(true); setChatSheet(true); }}>
              <MessageSquare />
              {risk > 0 && showChat && <span aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-destructive" />}
            </Button>
          )}
        </header>
        )}
        {onChat ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : (
        <div ref={scrollRef} className="rk-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </div>
        )}
      </main>

      {docked && (
        <aside className="flex min-h-0 w-[440px] min-[1440px]:w-[520px] shrink-0 flex-col border-l border-border">{renderChat(() => setChatDocked(false))}</aside>
      )}

      {!showSidebar && (
        <Sheet open={navSheet} onOpenChange={setNavSheet}>
          <SheetContent className="h-[85dvh] p-0">
            <div className="flex items-center justify-between px-3 pt-3">
              <SheetTitle>Menu</SheetTitle>
              <SheetClose render={<Button variant="ghost" size="icon" className="size-11" aria-label="Close menu" />}><X /></SheetClose>
            </div>
            <Sidebar safe={safe} safes={safes} statusesBySafe={statusesBySafe} chainId={chainId} loans={loans} loansError={loansError} pathname={pathname} onNavigate={go} userLabel={userLabel} userAddress={userAddress} reserve={reserve} ownedChainIds={ownedChainIds} onSignOut={onSignOut} showGuide={false} />
          </SheetContent>
        </Sheet>
      )}
      {hasChat && !showChat && (
        <Sheet open={chatSheet && !onChat} onOpenChange={setChatSheet}>
          <SheetContent className="h-[90dvh] overflow-hidden p-0">
            <SheetTitle className="sr-only">Lender agent</SheetTitle>
            {renderChat(() => setChatSheet(false))}
          </SheetContent>
        </Sheet>
      )}
    </div>
    </div>
    </TxToastProvider>
  );
}
