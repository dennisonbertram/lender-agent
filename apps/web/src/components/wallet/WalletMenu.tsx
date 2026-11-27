"use client";

import { useContext, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { WagmiContext, useAccount } from "wagmi";
import { ChevronsUpDown, Wallet } from "lucide-react";
import { AddressText } from "@/components/ui/address";
import { NetworkChip } from "@/components/common";
import { Button } from "@/components/ui/button";
import { shortAddress } from "@/lib/address";
import { DemoTransferNotice, SendToSafe } from "./SendToSafe";
import { sendChainsFor } from "./tokens";

/** No network where this wallet can safely send from here: the address and Copy only, with the network to send on. */
function ReceiveOnly({ safe, ownedChainIds }: { safe: string; ownedChainIds: readonly number[] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(safe); } catch { /* clipboard can be blocked */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">{ownedChainIds.length ? <>Send on {ownedChainIds.map((id, i) => <span key={id} className="inline-flex items-center gap-1">{i > 0 && "or"}<NetworkChip id={id} className="px-1.5 py-0" /></span>)} from your wallet to this address.</> : "Send from your wallet to this address on a network where your Safe is set up."}</p>
      <div className="flex items-center gap-2 rounded-lg bg-muted p-2">
        <code className="min-w-0 flex-1 text-xs break-all">{safe}</code>
        <Button variant="outline" size="sm" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
      </div>
    </div>
  );
}
export type WalletMenuProps = {
  /** What the sidebar footer shows for the signed-in user. */
  userLabel: string;
  /** The signed-in address, when known: a different connected wallet is called out. */
  userAddress?: string;
  /** Chain for the explorer link of the connected wallet's address. */
  chainId?: number;
  /** The Safe the Send form pays into. */
  safe: string;
  /** Chain ids where the Safe is set up and owned by the signed-in user (from the server). Sends are offered only there. */
  ownedChainIds?: readonly number[];
  onSignOut?: () => void;
};

/** Sidebar footer: the signed-in user as a button that opens the connected wallet, its balances and a Send to Safe form.
 *  No mainnet transport is configured (src/client/wallet/config.ts), so there is no ENS name: the address is shown. */
export function WalletMenu(props: WalletMenuProps) {
  const inProvider = useContext(WagmiContext) !== undefined;
  return inProvider ? <Menu {...props} /> : <Footer {...props} />;
}

function Footer({ userLabel, onSignOut }: WalletMenuProps) {
  return (
    <div className="flex items-center gap-2 px-2.5 pt-2">
      <span className="flex size-7 items-center justify-center rounded-full bg-sidebar-accent"><Wallet className="size-3.5" aria-hidden /></span>
      <span className="min-w-0 flex-1 truncate text-sm">{userLabel}</span>
      {onSignOut && <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" aria-label={`Sign out of ${userLabel}`} onClick={onSignOut}>Sign out</Button>}
    </div>
  );
}

function Menu({ userLabel, userAddress, safe, chainId, ownedChainIds = [], onSignOut }: WalletMenuProps) {
  const { address, isConnected } = useAccount();
  const differs = isConnected && !!address && (userAddress ? userAddress.toLowerCase() !== address.toLowerCase() : /^0x/i.test(userLabel) && userLabel.toLowerCase() !== shortAddress(address).toLowerCase());
  return (
    <div className="flex items-center gap-2 px-2.5 pt-2">
      <Popover.Root>
        <Popover.Trigger data-guide-target="wallet-menu" aria-label={`Your wallet: ${userLabel}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left outline-none hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent"><Wallet className="size-3.5" aria-hidden /></span>
          <span className="min-w-0 flex-1 truncate font-mono text-sm">{userLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={6} className="isolate z-50 outline-none">
            <Popover.Popup className="flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-3 rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
              <Popover.Title className="flex items-center gap-2 text-sm font-medium"><Wallet className="size-4" aria-hidden /> Your connected wallet</Popover.Title>
              {isConnected && address ? (
                <>
                  <AddressText address={address} chainId={chainId} className="text-xs" />
                  {differs && <p role="note" className="rounded-lg bg-muted p-2 text-xs">This is not the wallet you signed in with ({userLabel}). Funds sent from here still go to your Safe.</p>}
                  {process.env.NEXT_PUBLIC_LOCAL_DEMO === "1"
                    ? <DemoTransferNotice />
                    : sendChainsFor(ownedChainIds).length > 0 ? <SendToSafe safe={safe} chainIds={ownedChainIds} /> : <ReceiveOnly safe={safe} ownedChainIds={ownedChainIds} />}
                </>
              ) : process.env.NEXT_PUBLIC_LOCAL_DEMO === "1"
                ? <DemoTransferNotice />
                : <p className="text-sm text-muted-foreground">No wallet is connected in this browser. Connect your wallet app to send funds to your Safe.</p>}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {onSignOut && <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" aria-label={`Sign out of ${userLabel}`} onClick={onSignOut}>Sign out</Button>}
    </div>
  );
}
