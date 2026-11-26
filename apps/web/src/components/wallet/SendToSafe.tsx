"use client";

import { useContext, useState } from "react";
import { erc20Abi, formatUnits, getAddress, type Address } from "viem";
import { WagmiContext, useAccount, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { Check, X } from "lucide-react";
import { AddressText } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { checkAmount, formatAmount, isRejection, maxSendable } from "./send-math";
import { ETH_GAS_RESERVE_TEXT, sendAssetsFor, sendChainsFor, type SendChain } from "./tokens";
import { useTxToasts } from "./TxToasts";
import { REPLACED_TEXT, stalledText, useTransferOutcome } from "./useTransferOutcome";
import { useWalletBalances } from "./useWalletBalances";

export type SendToSafeProps = {
  /** The Safe's address as the server gave it. The only place this form can send to. */
  safe: string;
  /** Chain ids where the server says the Safe is set up and owned by the signed-in user. The form sends only on these (an undeployed network's address would strand the funds). */
  chainIds: readonly number[];
  /** The assets the card lists (symbols). */
  assets?: string[];
};

type Phase = "idle" | "switching" | "confirm" | "sent";

/** Send ETH or wstETH from the connected wallet to the Safe. Renders nothing outside a wallet provider. */
export function SendToSafe(props: SendToSafeProps) {
  const inProvider = useContext(WagmiContext) !== undefined;
  const chains = sendChainsFor(props.chainIds);
  if (!inProvider || chains.length === 0) return null;
  if (process.env.NEXT_PUBLIC_LOCAL_DEMO === "1") return <DemoTransferNotice />;
  return <SendForm key={chains.map((c) => c.id).join()} safe={props.safe} assets={props.assets} chains={chains} />;
}

export function DemoTransferNotice() {
  return <p role="note" className="rounded-lg bg-muted p-2 text-xs">Demo Safe is already funded in the mock world. Sending from a wallet is unavailable in this local demo.</p>;
}

function SentNotice({ hash, chain, onHash, onReset }: { hash: `0x${string}`; chain: SendChain; onHash: (h: `0x${string}`) => void; onReset: () => void }) {
  const outcome = useTransferOutcome(hash, chain.id, onHash);
  const failed = outcome === "reverted" || outcome === "cancelled" || outcome === "replaced";
  const message = outcome === "reverted" ? "The transfer failed on the network. Nothing left your wallet except the network fee."
    : outcome === "cancelled" ? "You cancelled this transfer in your wallet."
    : outcome === "replaced" ? REPLACED_TEXT
    : outcome === "stalled" ? stalledText(chain.explorerName)
    : outcome === "success" ? "Sent. It will show in your Safe in about a minute."
    : "Sent. Waiting for the network… It will show in your Safe in about a minute once it lands.";
  return (
    <div role="status" className="flex flex-col gap-1 rounded-xl bg-muted p-3 text-sm">
      <p className="flex items-start gap-2">{failed ? <X className="mt-0.5 size-4 shrink-0 text-destructive-text" /> : <Check className="mt-0.5 size-4 shrink-0 text-success" />}{message}</p>
      {outcome !== "cancelled" && <a href={`${chain.explorerTx}${hash}`} target="_blank" rel="noreferrer" className="pl-6 text-xs underline">View on {chain.explorerName}</a>}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => { onReset(); }}>{failed ? "Try again" : "Send more"}</Button>
    </div>
  );
}

function SendForm({ safe, assets, chains }: { safe: string; assets?: string[]; chains: ReturnType<typeof sendChainsFor> }) {
  const [selected, setSelected] = useState(chains[0].id);
  const chain = chains.find((c) => c.id === selected) ?? chains[0];
  const sendChainId = chain.id;
  const sendChainName = chain.name;
  const list = sendAssetsFor(assets, chain.assets);
  const { address, isConnected, chainId } = useAccount();
  const balances = useWalletBalances(address, list, sendChainId);
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const [symbol, setSymbol] = useState(list[0]?.symbol ?? "ETH");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const toasts = useTxToasts();

  const asset = list.find((a) => a.symbol === symbol);
  if (!asset) return null;
  if (!isConnected) return <p className="text-sm text-muted-foreground">Connect your wallet to send funds straight to your Safe.</p>;

  const balance = balances[asset.symbol];
  const max = balance === undefined ? 0n : maxSendable(asset, balance);
  const checked = balance === undefined ? {} : checkAmount(text, asset, balance);
  const empty = balance === 0n || (balance !== undefined && max === 0n);
  const reason = balance === undefined ? "Reading your balance…"
    : balance === 0n ? `You have no ${asset.symbol} on ${sendChainName} in this wallet.`
    : max === 0n ? "Your ETH is needed for the network fee." : (text.trim() ? checked.error : null) ?? null;
  const busy = phase === "switching" || phase === "confirm";
  const canSend = !!checked.value && !busy && !empty;

  const submit = async () => {
    if (!checked.value) return;
    setError(null);
    let toastId = 0;
    try {
      if (chainId !== sendChainId) {
        setPhase("switching");
        await switchChainAsync({ chainId: sendChainId });
      }
      setPhase("confirm");
      toastId = toasts.confirm();
      const to = getAddress(safe) as Address;
      const h = asset.address
        ? await writeContractAsync({ address: asset.address, abi: erc20Abi, functionName: "transfer", args: [to, checked.value], chainId: sendChainId })
        : await sendTransactionAsync({ to, value: checked.value, chainId: sendChainId });
      toasts.sending(toastId, { hash: h, chain, text: `Sending ${formatAmount(checked.value, asset.decimals)} ${asset.symbol} to your Safe` });
      setHash(h);
      setPhase("sent");
      setText("");
    } catch (e) {
      setPhase("idle");
      if (toastId) toasts.fail(toastId, isRejection(e) ? "You cancelled in your wallet." : "The wallet could not send this. Nothing was sent.", isRejection(e));
      setError(isRejection(e) ? "You cancelled in your wallet." : "The wallet could not send this. Nothing was sent. Try again.");
    }
  };

  if (phase === "sent" && hash) return <SentNotice hash={hash} chain={chain} onHash={setHash} onReset={() => { setPhase("idle"); setHash(undefined); }} />;

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {list.map((a) => <li key={a.symbol}>{balances[a.symbol] === undefined ? "…" : formatAmount(balances[a.symbol]!, a.decimals)} {a.symbol}</li>)}
      </ul>
      {chains.length > 1 && (
        <NativeSelect size="sm" aria-label="Network" value={chain.id} disabled={busy} onChange={(e) => { setSelected(Number(e.target.value)); setSymbol("ETH"); setText(""); setError(null); }}>
          {chains.map((c) => <NativeSelectOption key={c.id} value={c.id}>{c.name}</NativeSelectOption>)}
        </NativeSelect>
      )}
      <p className="flex flex-wrap items-center gap-x-1 text-sm" data-testid="send-to"><AddressText address={safe} chainId={sendChainId} label="To:" /> <span className="text-muted-foreground">(your Safe, {sendChainName})</span></p>
      <p className="text-xs text-muted-foreground">In your connected wallet on {sendChainName}. Sends to your Safe, nowhere else.</p>
      <div className="flex items-center gap-2">
        <NativeSelect size="sm" className="shrink-0" aria-label="Asset" value={symbol} disabled={busy} onChange={(e) => { setSymbol(e.target.value); setText(""); setError(null); }}>
          {list.map((a) => <NativeSelectOption key={a.symbol} value={a.symbol}>{a.symbol}</NativeSelectOption>)}
        </NativeSelect>
        <Input aria-label="Amount" inputMode="decimal" placeholder="0.0" autoComplete="off" value={text} disabled={busy} aria-invalid={!!checked.error || undefined} onChange={(e) => { setText(e.target.value); setError(null); }} />
        <Button type="button" variant="outline" size="sm" disabled={busy || max === 0n} onClick={() => { setText(formatUnits(max, asset.decimals)); setError(null); }}>Max</Button>
      </div>
      {!asset.address && <p className="text-xs text-muted-foreground">Max keeps {ETH_GAS_RESERVE_TEXT} ETH in your wallet for the network fee.</p>}
      {(reason || error) && <p role={error ? "alert" : undefined} className={error ? "text-sm text-destructive-text" : "text-xs text-muted-foreground"}>{error ?? reason}</p>}
      <Button type="submit" disabled={!canSend}>
        {phase === "switching" ? `Switching to ${sendChainName}…` : phase === "confirm" ? "Confirm in your wallet…" : "Send to Safe"}
      </Button>
    </form>
  );
}

