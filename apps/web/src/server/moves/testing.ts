// Test and MOCK=1 stand-ins: a deterministic aggregator whose quotes carry real-shaped LI.FI calldata (the Safe as receiver),
// a scripted status per transfer, and a destination chain you can set up. Never used when MOCK is not set.
import { getAddress, type Hex } from "viem";
import type { Address } from "@/shared/types";
import type { DestinationChain } from "./arrival";
import { STATUS } from "@/server/mock/moves-fixtures/status";
import { encodeBridgeCall, LZ_DST_EID } from "./facets";
import { LIFI_DIAMOND } from "./lifi";
import type { AggregatorQuote, BridgeAggregator, QuoteParams, StatusParams, TransferStatus } from "./types";
import { NATIVE } from "./types";

/** LI.FI-shaped calldata the app's checks can pass: Stargate carries the native coin (asset id 13 to the destination's LayerZero
 * endpoint, `minAmountLD` rounded up to shared-decimal precision); an ERC-20 goes by AcrossV4, whose deposit names the same
 * sending and receiving tokens the quote does. */
export function bridgeCalldata(p: { receiver: Address; destinationChainId: number; sendingAssetId: Address; receivingAssetId: Address; minAmount: bigint }): Hex {
  const word = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  const ZERO32 = `0x${"0".repeat(64)}` as Hex;
  const bd = { transactionId: `0x${"11".repeat(32)}`, bridge: "lifi", integrator: "lender-agent", referrer: NATIVE, sendingAssetId: p.sendingAssetId, receiver: p.receiver, minAmount: p.minAmount, destinationChainId: BigInt(p.destinationChainId), hasSourceSwaps: false, hasDestinationCall: false };
  if (p.sendingAssetId.toLowerCase() === NATIVE) {
    const rate = 10n ** 12n; // Stargate shared decimals: the enforced minimum is floored to this precision, so round it up
    const minAmountLD = ((p.minAmount + rate - 1n) / rate) * rate;
    return encodeBridgeCall("Stargate", bd,
      { assetId: 13, sendParams: { dstEid: LZ_DST_EID[p.destinationChainId] ?? 0, to: word(p.receiver), amountLD: p.minAmount, minAmountLD, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" }, fee: { nativeFee: 0n, lzTokenFee: 0n }, refundAddress: p.receiver });
  }
  return encodeBridgeCall("AcrossV4", bd,
    { receiverAddress: word(p.receiver), refundAddress: word(p.receiver), sendingAssetId: word(p.sendingAssetId), receivingAssetId: word(p.receivingAssetId), outputAmount: p.minAmount, outputAmountMultiplier: 0n, exclusiveRelayer: ZERO32, quoteTimestamp: 0, fillDeadline: 0, exclusivityParameter: 0, message: "0x" });
}

export type FakeAggregatorOptions = { feeUsd?: number; ratio?: number; durationSec?: number; noRoute?: boolean; tool?: string; now?: () => number };

/** Quotes at `ratio` (default 0.995) of the amount sent, with the Safe as receiver. */
export function fakeAggregator(o: FakeAggregatorOptions = {}): BridgeAggregator & { statuses: Map<string, TransferStatus>; quotes: AggregatorQuote[] } {
  const statuses = new Map<string, TransferStatus>();
  const quotes: AggregatorQuote[] = [];
  return {
    statuses, quotes,
    async quote(p: QuoteParams) {
      if (o.noRoute) return null;
      const safe = getAddress(p.address);
      const native = p.fromToken.toLowerCase() === NATIVE;
      const decimals = p.fromToken.toLowerCase() === NATIVE ? 18 : 18;
      const toAmount = (p.fromAmount * 996n) / 1000n;
      const toAmountMin = (p.fromAmount * BigInt(Math.round((o.ratio ?? 0.995) * 1000))) / 1000n;
      const q: AggregatorQuote = {
        id: `fake-${quotes.length}`, tool: o.tool ?? "across", fromChain: p.fromChain, toChain: p.toChain, fromToken: p.fromToken, toToken: p.toToken,
        fromAmount: p.fromAmount, toAmount, toAmountMin, fromDecimals: decimals, toDecimals: decimals, fromAddress: safe, toAddress: safe,
        approvalAddress: native ? null : LIFI_DIAMOND, durationSec: o.durationSec ?? 600, feeUsd: o.feeUsd ?? 4,
        tx: { to: LIFI_DIAMOND, from: safe, chainId: p.fromChain, value: native ? p.fromAmount : 0n, data: bridgeCalldata({ receiver: safe, destinationChainId: p.toChain, sendingAssetId: p.fromToken, receivingAssetId: p.toToken, minAmount: toAmountMin }) },
        quotedAt: (o.now ?? Date.now)(),
      };
      quotes.push(q);
      return q;
    },
    async status(p: StatusParams) { return statuses.get(p.txHash.toLowerCase()) ?? { state: "not_found" }; },
  };
}

/** A recorded `/v1/status` outcome, normalised the way the client does. */
export function statusOf(name: keyof typeof STATUS): TransferStatus {
  const s = STATUS[name] as { status: string; substatus?: string; substatusMessage?: string; receiving?: { txHash: string; chainId: number; amount: string; token?: { address: string } } };
  const out: TransferStatus = { state: s.status === "DONE" ? "done" : s.status === "FAILED" ? "failed" : s.status === "PENDING" ? "pending" : "not_found" };
  if (s.substatus) out.sub = s.substatus;
  if (s.substatusMessage) out.message = s.substatusMessage;
  if (s.receiving) out.receiving = { txHash: s.receiving.txHash as Hex, chainId: s.receiving.chainId, amount: BigInt(s.receiving.amount), token: s.receiving.token?.address ? getAddress(s.receiving.token.address) : null };
  return out;
}

export type FakeDestination = DestinationChain & {
  deployed: Set<string>;
  payments: Map<string, bigint>;
  owners: Map<string, Address[]>;
  /** Addresses where code answers `getOwners` without being a verified Safe: `ownersOf` refuses them (null). */
  fakeContracts: Map<string, Address[]>;
  /** Record a Safe as deployed with these owners (what a deployment of its setup would produce). */
  setOwners(chainId: number, safe: Address, owners: Address[]): void;
  /** Deploy a non-Safe contract that returns these owners from `getOwners`: deployed, decodable, not a Safe. */
  setFakeContract(chainId: number, address: Address, owners: Address[]): void;
};

export type FakeDestinationOptions = {
  /** Fallback code read (the fixture chain's `isDeployed` on served networks). */
  hasCode?: (chainId: number, safe: Address) => Promise<boolean>;
  /** Fallback owners read (the fixture chain's `readSafeOwners` on served networks). */
  ownersOf?: (chainId: number, safe: Address) => Promise<Address[] | null>;
};

/** `payments`: destination transaction hash → amount it paid the Safe. A hash not in it is unconfirmed. */
export function fakeDestination(opts: FakeDestinationOptions = {}): FakeDestination {
  const deployed = new Set<string>();
  const payments = new Map<string, bigint>();
  const owners = new Map<string, Address[]>();
  const fakeContracts = new Map<string, Address[]>();
  return {
    deployed, payments, owners, fakeContracts,
    setOwners(chainId, safe, o) {
      const k = `${chainId}:${safe.toLowerCase()}`;
      deployed.add(k);
      owners.set(k, [...o]);
    },
    setFakeContract(chainId, address, o) {
      fakeContracts.set(`${chainId}:${address.toLowerCase()}`, [...o]);
    },
    async hasCode(chainId, address) {
      if (deployed.has(`${chainId}:${address.toLowerCase()}`) || fakeContracts.has(`${chainId}:${address.toLowerCase()}`)) return true;
      return (await opts.hasCode?.(chainId, address).catch(() => false)) ?? false;
    },
    async ownersOf(chainId, address) {
      const k = `${chainId}:${address.toLowerCase()}`;
      if (fakeContracts.has(k)) return null; // it answers getOwners, but it is not a verified Safe
      return owners.get(k) ?? (await opts.ownersOf?.(chainId, address).catch(() => null)) ?? null;
    },
    async paysSafe({ txHash, minRaw = 1n }) {
      const paid = payments.get(txHash.toLowerCase());
      if (paid === undefined) return { ok: false, reason: "the destination transaction is not confirmed yet" };
      return paid >= minRaw ? { ok: true, amountRaw: paid } : { ok: false, reason: "the destination transaction pays less than expected" };
    },
  };
}
