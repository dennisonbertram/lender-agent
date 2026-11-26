import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, getAddress, parseAbiParameters, type Hex } from "viem";
import { erc20Abi } from "@/server/chain/abis";
import { buildSafeTx } from "@/server/safe/multisend";
import quoteBody from "@/server/mock/moves-fixtures/quote-eth-base-to-ethereum.json";
import { SAFE } from "@/server/mock/moves-fixtures/status";
import { encodeBridgeCall, LZ_DST_EID } from "./facets";
import { createLifi, LIFI_DIAMOND } from "./lifi";
import { buildMoveBatch, checkMoveBatch, checkMoveQuote } from "./invariants";
import { USDC } from "./tokens";
import { NATIVE, type AggregatorQuote } from "./types";

const STRANGER = getAddress("0x00000000000000000000000000000000000dEaD1");
const safe = getAddress(SAFE);
const WSTETH_BASE = getAddress("0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452");
const WSTETH_ETH = getAddress("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0");
const USDC_BASE = getAddress(USDC[8453]!);
const USDC_ETH = getAddress(USDC[1]!);
const OTHER_TOKEN = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"); // WBTC on Ethereum: a real token that is not the quote's

const real = async () => (await createLifi({ fetch: async () => new Response(JSON.stringify(quoteBody)) }).quote({ fromChain: 8453, toChain: 1, fromToken: NATIVE, toToken: NATIVE, fromAmount: 1_000_000_000_000_000n, address: safe }))!;

const w32 = (a: string) => ("0x" + a.slice(2).toLowerCase().padStart(64, "0")) as Hex;
const Z32 = ("0x" + "0".repeat(64)) as Hex;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ARRIVE = 10n ** 18n; // a guaranteed minimum well above the recorded quote's (910700000000000)
const SD_RATE = 10n ** 12n; // Stargate floors its enforced minimum to 6 shared decimals: 18 - 6 = 12
/** The token pair each retained facet can prove on the recorded quote's Base → Ethereum route. */
const FIXTURE: Record<string, { from: `0x${string}`; to: `0x${string}` }> = {
  AcrossV3: { from: WSTETH_BASE, to: WSTETH_ETH }, // a fill pays a contract a token, never the coin
  AcrossV4: { from: WSTETH_BASE, to: WSTETH_ETH },
  PolymerCCTP: { from: USDC_BASE, to: USDC_ETH }, // CCTP carries only USDC
  Stargate: { from: NATIVE, to: NATIVE }, // the native coin on both impls
};
const SUPPORTED = ["AcrossV3", "AcrossV4", "PolymerCCTP", "Stargate"];
const OPAQUE = ["Relay", "LayerSwap", "Symbiosis"];
const bd = (receiver: string, over: { destinationChainId?: bigint; hasDestinationCall?: boolean; hasSourceSwaps?: boolean; minAmount?: bigint; sendingAssetId?: string } = {}) => ({ transactionId: ("0x" + "11".repeat(32)) as Hex, bridge: "x", integrator: "x", referrer: NATIVE, sendingAssetId: over.sendingAssetId ?? NATIVE, receiver, minAmount: over.minAmount ?? 1_000_000_000_000_000n, destinationChainId: over.destinationChainId ?? 1n, hasSourceSwaps: over.hasSourceSwaps ?? false, hasDestinationCall: over.hasDestinationCall ?? false });
/** The facet data of each decoded facet, consistent with the facet's token pair, with the Safe everywhere an address goes (`over` replaces fields). */
const facetData = (via: string, who: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const t = FIXTURE[via] ?? { from: NATIVE, to: NATIVE };
  switch (via) {
    case "AcrossV3": return { receiverAddress: who, refundAddress: who, receivingAssetId: t.to, outputAmount: ARRIVE, outputAmountPercent: 0n, exclusiveRelayer: ZERO_ADDR, quoteTimestamp: 0, fillDeadline: 0, exclusivityDeadline: 0, message: "0x", ...over };
    case "AcrossV4": return { receiverAddress: w32(who), refundAddress: w32(who), sendingAssetId: w32(t.from), receivingAssetId: w32(t.to), outputAmount: ARRIVE, outputAmountMultiplier: 0n, exclusiveRelayer: Z32, quoteTimestamp: 0, fillDeadline: 0, exclusivityParameter: 0, message: "0x", ...over };
    case "Relay": return { requestId: Z32, nonEVMReceiver: Z32, receivingAssetId: Z32, signature: "0x", ...over };
    case "PolymerCCTP": return { polymerTokenFee: 0n, maxCCTPFee: 0n, nonEVMReceiver: Z32, solanaReceiverATA: Z32, minFinalityThreshold: 1000, refundRecipient: who, hookData: "0x", ...over };
    case "Symbiosis": return { refundRecipient: who, nonEvmReceiver: Z32, firstSwapCalldata: "0x", secondSwapCalldata: "0x", firstDexRouter: ZERO_ADDR, secondDexRouter: ZERO_ADDR, approvedTokens: [], callTo: ZERO_ADDR, callData: ("0x1234" + w32(who).slice(2)) as Hex, viaOnchainSwapV3: false, dex: ZERO_ADDR, dexgateway: ZERO_ADDR, onchainSwapData: "0x", fee: 0n, deadline: 0n, signature: "0x", ...over };
    case "Stargate": return { assetId: 13, sendParams: { dstEid: LZ_DST_EID[1], to: w32(who), amountLD: 1n, minAmountLD: ARRIVE, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" }, fee: { nativeFee: 0n, lzTokenFee: 0n }, refundAddress: who, ...over };
    case "LayerSwap": return { requestId: Z32, depositoryReceiver: STRANGER, refundRecipient: who, nonEVMReceiver: Z32, signature: "0x", deadline: 0n, ...over };
    default: throw new Error(via);
  }
};
/** A LI.FI-shaped call of `via` consistent with the facet's token pair (Stargate here unless said); `swaps` makes it a swapAndStart call. */
function bridgeCall(receiver: `0x${string}`, over: { destinationChainId?: bigint; hasDestinationCall?: boolean; hasSourceSwaps?: boolean; minAmount?: bigint; sendingAssetId?: string } = {}, via = "Stargate", facetOver: Record<string, unknown> = {}, swaps: readonly Record<string, unknown>[] | boolean = false): Hex {
  const t = FIXTURE[via] ?? { from: NATIVE, to: NATIVE };
  return encodeBridgeCall(via, bd(receiver, { sendingAssetId: t.from, ...over }), facetData(via, receiver, facetOver), swaps);
}
/** The quote matching the facet's pair: native both ways, or a token pair (approved to the diamond, no ETH carried). */
const quoteFor = async (via: string): Promise<AggregatorQuote> => {
  const t = FIXTURE[via] ?? { from: NATIVE, to: NATIVE };
  const q = await real();
  return t.from === NATIVE ? q : { ...q, fromToken: t.from, toToken: t.to, approvalAddress: LIFI_DIAMOND, tx: { ...q.tx, value: 0n } };
};
const withData = (q: AggregatorQuote, data: Hex): AggregatorQuote => ({ ...q, tx: { ...q.tx, data } });
/** The recorded quote with a supported direct call in place of its swap-and-bridge calldata. */
const good = async () => withData(await real(), bridgeCall(safe));
const reason = (r: { ok: boolean; reason?: string }) => (r as { reason: string }).reason;
const stargate = (minAmountLD: bigint) => ({ sendParams: { dstEid: LZ_DST_EID[1], to: w32(safe), amountLD: 1n, minAmountLD, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" } });

describe("recipient invariant (M5 exit 3)", () => {
  it("accepts a supported route whose calldata names the Safe and enforces the quote's minimum", async () => {
    for (const via of SUPPORTED) {
      expect(checkMoveQuote(withData(await quoteFor(via), bridgeCall(safe, {}, via)), { safe, fromChain: 8453, toChain: 1 })).toEqual({ ok: true });
    }
  });
  it("rejects calldata whose receiver is not the Safe", async () => {
    const r = checkMoveQuote(withData(await real(), bridgeCall(STRANGER, {}, "Stargate", facetData("Stargate", safe))), { safe, fromChain: 8453, toChain: 1 });
    expect(r).toMatchObject({ ok: false });
    expect(reason(r)).toMatch(/receiver/);
  });
  it("rejects nonempty Stargate extra options even when the bridge and refund recipients are the Safe", async () => {
    const q = await good();
    const bounds = { safe, fromChain: q.fromChain, toChain: q.toChain };
    const { sendParams } = stargate(ARRIVE);

    expect(checkMoveQuote(q, bounds)).toEqual({ ok: true });
    for (const extraOptions of ["0x00", "0x0003"]) {
      const data = bridgeCall(safe, {}, "Stargate", { sendParams: { ...sendParams, extraOptions } });
      expect(checkMoveQuote(withData(q, data), bounds)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/sendParams\.extraOptions must be empty/),
      });
    }
  });
  it("refuses a facet the app cannot read, and truncated or garbled calldata", async () => {
    const q = await real();
    expect(checkMoveQuote(withData(q, "0xdeadbeef" + "00".repeat(200) as Hex), { safe, fromChain: 8453, toChain: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/does not know how to read/) });
    expect(checkMoveQuote(withData(q, bridgeCall(safe).slice(0, 300) as Hex), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
  });
  it("rejects a quote addressed to someone else, or sent from someone else", async () => {
    const q = await good();
    expect(checkMoveQuote({ ...q, toAddress: STRANGER }, { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
    expect(checkMoveQuote({ ...q, fromAddress: STRANGER }, { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
  });
  it("rejects a different destination network, a destination call, an unknown target and calldata it cannot read", async () => {
    const q = await good();
    expect(checkMoveQuote(withData(q, bridgeCall(safe, { destinationChainId: 10n })), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
    expect(checkMoveQuote(withData(q, bridgeCall(safe, { hasDestinationCall: true })), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
    expect(checkMoveQuote({ ...q, tx: { ...q.tx, to: STRANGER } }, { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
    expect(checkMoveQuote(withData(q, "0x4c279d6b00"), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
  });
  it("rejects a quote whose minimum received is above what it says it delivers, or zero", async () => {
    const q = await good();
    expect(checkMoveQuote({ ...q, toAmountMin: q.toAmount + 1n }, { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
    expect(checkMoveQuote({ ...q, toAmountMin: 0n }, { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
  });
});

describe("the calldata must prove the quote's token and network", () => {
  it("refuses a Stargate call routed to another network: the real route is sendParams.dstEid, not BridgeData", async () => {
    const routed = (dstEid: number) => ({ sendParams: { dstEid, to: w32(safe), amountLD: 1n, minAmountLD: ARRIVE, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" } });
    const r = checkMoveQuote(withData(await real(), bridgeCall(safe, {}, "Stargate", routed(LZ_DST_EID[8453]!))), { safe, fromChain: 8453, toChain: 1 });
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/rout/);
    // even when BridgeData's own destinationChainId agrees with the quote, dstEid rules
    const agreed = checkMoveQuote(withData(await real(), bridgeCall(safe, { destinationChainId: 1n }, "Stargate", routed(LZ_DST_EID[42161]!))), { safe, fromChain: 8453, toChain: 1 });
    expect(agreed.ok).toBe(false);
    expect(reason(agreed)).toMatch(/rout/);
  });
  it("refuses a call delivering a different token than the quote, however much it pays", async () => {
    const v4 = checkMoveQuote(withData(await quoteFor("AcrossV4"), bridgeCall(safe, {}, "AcrossV4", { receivingAssetId: w32(OTHER_TOKEN), outputAmount: ARRIVE })), { safe, fromChain: 8453, toChain: 1 });
    expect(v4.ok).toBe(false);
    expect(reason(v4)).toMatch(/delivers/);
    const v3 = checkMoveQuote(withData(await quoteFor("AcrossV3"), bridgeCall(safe, {}, "AcrossV3", { receivingAssetId: OTHER_TOKEN, outputAmount: ARRIVE })), { safe, fromChain: 8453, toChain: 1 });
    expect(v3.ok).toBe(false);
    expect(reason(v3)).toMatch(/delivers/);
  });
  it("refuses a call depositing a different token than the quote", async () => {
    const deposit = checkMoveQuote(withData(await real(), bridgeCall(safe, { sendingAssetId: OTHER_TOKEN }, "Stargate")), { safe, fromChain: 8453, toChain: 1 });
    expect(deposit.ok).toBe(false);
    expect(reason(deposit)).toMatch(/deposit/);
    const v4 = checkMoveQuote(withData(await quoteFor("AcrossV4"), bridgeCall(safe, {}, "AcrossV4", { sendingAssetId: w32(OTHER_TOKEN) })), { safe, fromChain: 8453, toChain: 1 });
    expect(v4.ok).toBe(false);
    expect(reason(v4)).toMatch(/deposit/);
  });
  it("refuses the native coin as an Across destination: a fill pays a contract the wrapped token, never the coin", async () => {
    for (const via of ["AcrossV3", "AcrossV4"]) {
      const r = checkMoveQuote(withData(await real(), bridgeCall(safe, { sendingAssetId: NATIVE }, via)), { safe, fromChain: 8453, toChain: 1 });
      expect(r.ok).toBe(false);
      expect(reason(r)).toMatch(/native coin/);
    }
  });
  it("refuses a Polymer call whose quote is not USDC to USDC", async () => {
    const wsteth = checkMoveQuote(withData(await quoteFor("AcrossV4"), bridgeCall(safe, { sendingAssetId: WSTETH_BASE }, "PolymerCCTP")), { safe, fromChain: 8453, toChain: 1 });
    expect(wsteth.ok).toBe(false);
    expect(reason(wsteth)).toMatch(/USDC/);
    const unproven = checkMoveQuote(withData({ ...(await quoteFor("PolymerCCTP")), toChain: 100 }, bridgeCall(safe, {}, "PolymerCCTP")), { safe, fromChain: 8453, toChain: 100 });
    expect(unproven.ok).toBe(false);
    expect(reason(unproven)).toMatch(/USDC/);
  });
  it("refuses a Stargate asset id the app cannot prove a token for", async () => {
    const r = checkMoveQuote(withData(await real(), bridgeCall(safe, {}, "Stargate", { assetId: 1 })), { safe, fromChain: 8453, toChain: 1 });
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/asset id/);
  });
});

describe("the calldata must enforce the quote's guaranteed minimum", () => {
  it("accepts a route enforcing exactly the quote's minimum, and refuses one wei less", async () => {
    const q = { ...(await real()), toAmountMin: 911_000_000_000_000n }; // whole shared-decimal units: Stargate's floor keeps it
    expect(checkMoveQuote(withData(q, bridgeCall(safe, {}, "Stargate", stargate(q.toAmountMin))), { safe, fromChain: 8453, toChain: 1 })).toEqual({ ok: true });
    const r = checkMoveQuote(withData(q, bridgeCall(safe, {}, "Stargate", stargate(q.toAmountMin - 1n))), { safe, fromChain: 8453, toChain: 1 });
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/guarantee/);
  });
  it("refuses a quote claiming a higher minimum than the calldata enforces", async () => {
    const q = { ...(await real()), toAmountMin: 911_000_000_000_000n };
    const bound = bridgeCall(safe, {}, "Stargate", stargate(q.toAmountMin));
    const r = checkMoveQuote(withData({ ...q, toAmountMin: q.toAmountMin + 1n }, bound), { safe, fromChain: 8453, toChain: 1 });
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/guarantee/);
  });
  it("floors the Stargate minimum to shared decimals: equal to the quote is not enough when it rounds down", async () => {
    const q = await real(); // toAmountMin 910700000000000 is not a whole 1e12 unit
    const r = checkMoveQuote(withData(q, bridgeCall(safe, {}, "Stargate", stargate(q.toAmountMin))), { safe, fromChain: 8453, toChain: 1 });
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/guarantee/);
    expect(checkMoveQuote(withData(q, bridgeCall(safe, {}, "Stargate", stargate(q.toAmountMin - (q.toAmountMin % SD_RATE) + SD_RATE))), { safe, fromChain: 8453, toChain: 1 })).toEqual({ ok: true });
  });
  it("Across: outputAmount is the enforced delivery; a max-uint256 output proves nothing", async () => {
    for (const via of ["AcrossV3", "AcrossV4"]) {
      const q = await quoteFor(via);
      expect(checkMoveQuote(withData(q, bridgeCall(safe, {}, via, { outputAmount: q.toAmountMin - 1n })), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
      expect(checkMoveQuote(withData(q, bridgeCall(safe, {}, via, { outputAmount: (1n << 256n) - 1n })), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
    }
  });
  it("PolymerCCTP: the enforced minimum is the deposit minus the Polymer and CCTP fees", async () => {
    const q = await quoteFor("PolymerCCTP");
    const headroom = bd(safe).minAmount - q.toAmountMin; // 89300000000000
    expect(checkMoveQuote(withData(q, bridgeCall(safe, {}, "PolymerCCTP", { polymerTokenFee: headroom / 2n, maxCCTPFee: headroom / 2n })), { safe, fromChain: 8453, toChain: 1 })).toEqual({ ok: true });
    expect(checkMoveQuote(withData(q, bridgeCall(safe, {}, "PolymerCCTP", { polymerTokenFee: 0n, maxCCTPFee: headroom + 1n })), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
  });
});

describe("routes the app refuses", () => {
  it("refuses the recorded quote: it swaps through a contract the app did not build, then bridges via LayerSwap", async () => {
    const r = checkMoveQuote(await real(), { safe, fromChain: 8453, toChain: 1 });
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/swap/);
  });
  it("refuses every swapAndStart route, even when every address is the Safe and the flags agree", async () => {
    for (const via of [...SUPPORTED, ...OPAQUE]) {
      const r = checkMoveQuote(withData(await real(), bridgeCall(safe, { hasSourceSwaps: true }, via, {}, true)), { safe, fromChain: 8453, toChain: 1 });
      expect(r.ok).toBe(false);
      expect(reason(r)).toMatch(/swap/);
    }
  });
  it("refuses a swapAndStart whose SwapData[] is not empty", async () => {
    const swap = { callTo: STRANGER, approveTo: STRANGER, sendingAssetId: NATIVE, receivingAssetId: NATIVE, fromAmount: 1n, callData: "0x" as Hex, requiresDeposit: false };
    expect(checkMoveQuote(withData(await real(), bridgeCall(safe, { hasSourceSwaps: true }, "Stargate", {}, [swap])), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
  });
  it("refuses a direct call whose BridgeData claims source swaps", async () => {
    expect(checkMoveQuote(withData(await real(), bridgeCall(safe, { hasSourceSwaps: true })), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
  });
  it("refuses Relay and LayerSwap routes: the amount arriving is fixed off-chain, and Symbiosis: its router cannot be checked", async () => {
    for (const via of OPAQUE) {
      const r = checkMoveQuote(withData(await real(), bridgeCall(safe, {}, via, facetData(via, safe))), { safe, fromChain: 8453, toChain: 1 });
      expect(r.ok).toBe(false);
      expect(reason(r)).toContain(via);
    }
  });
});

describe("the move batch", () => {
  it("is one plain call for native ETH, with the quoted value", async () => {
    const q = await good();
    const calls = buildMoveBatch(q);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: LIFI_DIAMOND, value: 1_000_000_000_000_000n });
    const outer = buildSafeTx(calls, 3);
    expect(checkMoveBatch(q, { safe, fromChain: 8453, toChain: 1, calls, outer })).toEqual({ ok: true });
  });
  it("is approve then bridge for a token, and the approval goes only to the aggregator", async () => {
    const q = withData(await quoteFor("AcrossV4"), bridgeCall(safe, {}, "AcrossV4"));
    const calls = buildMoveBatch(q);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ to: WSTETH_BASE });
    const outer = buildSafeTx(calls, 0);
    expect(outer.operation).toBe(1);
    expect(checkMoveBatch(q, { safe, fromChain: 8453, toChain: 1, calls, outer })).toEqual({ ok: true });
    const bad = [{ ...calls[0], data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STRANGER, q.fromAmount] }) }, calls[1]];
    expect(checkMoveBatch(q, { safe, fromChain: 8453, toChain: 1, calls: bad, outer: buildSafeTx(bad, 0) }).ok).toBe(false);
  });
  it("rejects a batch that differs from the checked quote, or an outer transaction that does not match", async () => {
    const q = await good();
    const calls = buildMoveBatch(q);
    const foreign = [{ ...calls[0], data: bridgeCall(STRANGER, {}, "Stargate", facetData("Stargate", safe)) }];
    expect(checkMoveBatch(q, { safe, fromChain: 8453, toChain: 1, calls: foreign, outer: buildSafeTx(foreign, 0) }).ok).toBe(false);
    expect(checkMoveBatch(q, { safe, fromChain: 8453, toChain: 1, calls, outer: { ...buildSafeTx(calls, 0), to: STRANGER } }).ok).toBe(false);
    expect(checkMoveBatch(q, { safe, fromChain: 8453, toChain: 1, calls, outer: { ...buildSafeTx(calls, 0), gasPrice: "1" } }).ok).toBe(false);
  });
});

const FACET_FOREIGN: Record<string, { field: string; over: Record<string, unknown> }[]> = {
  AcrossV3: [{ field: "refundAddress", over: { refundAddress: STRANGER } }, { field: "receiverAddress", over: { receiverAddress: STRANGER } }, { field: "message", over: { message: "0x1234" } }],
  AcrossV4: [{ field: "refundAddress", over: { refundAddress: w32(STRANGER) } }, { field: "receiverAddress", over: { receiverAddress: w32(STRANGER) } }, { field: "message", over: { message: "0x1234" } }],
  PolymerCCTP: [{ field: "refundRecipient", over: { refundRecipient: STRANGER } }, { field: "nonEVMReceiver", over: { nonEVMReceiver: w32(STRANGER) } }, { field: "solanaReceiverATA", over: { solanaReceiverATA: w32(STRANGER) } }, { field: "hookData", over: { hookData: "0x1234" } }],
  Stargate: [{ field: "refundAddress", over: { refundAddress: STRANGER } }, { field: "sendParams.to", over: { sendParams: { dstEid: LZ_DST_EID[1], to: w32(STRANGER), amountLD: 1n, minAmountLD: ARRIVE, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" } } }, { field: "sendParams.composeMsg", over: { sendParams: { dstEid: LZ_DST_EID[1], to: w32(safe), amountLD: 1n, minAmountLD: ARRIVE, extraOptions: "0x", composeMsg: "0x1234", oftCmd: "0x" } } }],
};

describe("every allowed bridge facet: each recipient, refund and fallback address must be the Safe", () => {
  for (const [via, bad] of Object.entries(FACET_FOREIGN)) {
    it(`${via}: accepts the Safe everywhere`, async () => {
      expect(checkMoveQuote(withData(await quoteFor(via), bridgeCall(safe, {}, via)), { safe, fromChain: 8453, toChain: 1 })).toEqual({ ok: true });
    });
    for (const b of bad) {
      it(`${via}: refuses ${b.field} that is not the Safe`, async () => {
        const r = checkMoveQuote(withData(await quoteFor(via), bridgeCall(safe, {}, via, b.over)), { safe, fromChain: 8453, toChain: 1 });
        expect(r.ok).toBe(false);
        expect(reason(r)).toContain(b.field);
      });
    }
    it(`${via}: refuses a foreign BridgeData.receiver`, async () => {
      expect(checkMoveQuote(withData(await quoteFor(via), bridgeCall(STRANGER, {}, via, facetData(via, safe))), { safe, fromChain: 8453, toChain: 1 }).ok).toBe(false);
    });
  }
});
