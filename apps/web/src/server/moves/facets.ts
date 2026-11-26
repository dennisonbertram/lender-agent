// What a LI.FI bridge call can be (D-18, M0-7). Every bridge call is `startBridgeTokensVia<Facet>(BridgeData, FacetData)` or
// `swapAndStartBridgeTokensVia<Facet>(BridgeData, SwapData[], FacetData)`. BridgeData names the receiver, but each facet also
// carries its own recipient, refund or fallback address (a failed bridge refunds there), so an allowlist of facets is decoded
// here, field by field, from the facet sources in lifinance/contracts. A facet that is not listed is refused: a call we cannot
// read is not sent. Each retained facet must also prove from the calldata which token leaves, which token arrives and where the
// call really routes — on Stargate the route is `sendParams.dstEid` and BridgeData is documented as analytics only — and the
// destination floor must still hold after the bridge's own rounding. Adding a facet means adding its ABI, the address fields it
// carries, and those proofs, with a test.
import { decodeFunctionData, encodeFunctionData, getAddress, isAddressEqual, parseAbi, toFunctionSelector, getAbiItem, type Hex } from "viem";
import type { Address } from "@/shared/types";
import { NATIVE, type MoveChain } from "./types";
import { USDC } from "./tokens";

const BRIDGE_DATA = "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }";
const SWAP_DATA = "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }";

type Check = { name: string; /** `safe`: an address (or a bytes32 holding one) equal to the Safe; `zero`: unset; `empty`: no bytes. */ kind: "safe" | "zero" | "empty" };

const safe = (name: string, d: Record<string, unknown>): Check & { value: unknown } => ({ name, kind: "safe", value: d[name] });
const zero = (name: string, d: Record<string, unknown>): Check & { value: unknown } => ({ name, kind: "zero", value: d[name] });
const empty = (name: string, d: Record<string, unknown>): Check & { value: unknown } => ({ name, kind: "empty", value: d[name] });

const MAX_UINT256 = (1n << 256n) - 1n;
/** Across V3 and V4 pass `outputAmount` verbatim into the SpokePool deposit: it is exactly what the receiver gets. The max uint256 marks a deposit whose output is updated later, so it proves nothing. */
const acrossOutput = (d: Record<string, unknown>): bigint | string =>
  d.outputAmount === MAX_UINT256 ? "the Across deposit's output amount can be changed after it is sent" : (d.outputAmount as bigint);
/** Signed-request routes: the amount the destination pays lives in the signed order (requestId), not in the calldata. */
const opaque = (via: string) => `${via} routes are not supported: the amount arriving is fixed off-chain in the signed request, not readable from the calldata`;

/** What the quote asked for: the token and network on each side that the calldata must prove it uses. */
export type QuoteSemantics = { fromChain: MoveChain; toChain: MoveChain; fromToken: Address; toToken: Address };

const isNative = (a: Address) => a.toLowerCase() === NATIVE;

/** LayerZero V2 endpoint ids of the move networks (@layerzerolabs/lz-definitions): a Stargate call routes on `sendParams.dstEid`, not on BridgeData's chain id. */
export const LZ_DST_EID: Partial<Record<MoveChain, number>> = { 1: 30101, 10: 30111, 100: 30145, 137: 30109, 8453: 30184, 42161: 30110 };

/** The Stargate V2 assets a call can prove end to end (stg-definitions-v2 `ASSETS`): `10^(localDecimals - sharedDecimals)` is the
 * rate Stargate's send path truncates `minAmountLD` by before enforcing it, and `nativeChains` are the networks whose impl is
 * `StargateType.Native`, where the delivery really is the native coin. ETH (asset id 13) is the only move asset Stargate carries;
 * any other asset id is refused rather than guessed. */
const STARGATE_ASSETS: Record<number, { token: "native"; localDecimals: number; sharedDecimals: number; nativeChains: ReadonlySet<MoveChain> }> = {
  13: { token: "native", localDecimals: 18, sharedDecimals: 6, nativeChains: new Set<MoveChain>([1, 10, 8453, 42161]) },
};

const padded = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const isZero = (v: unknown) => typeof v === "string" && /^0x0*$/i.test(v);

/** The token a call delivers, as a 32-byte word for comparison. */
const asWord = (v: unknown): string | null => (typeof v !== "string" ? null : v.length === 42 ? padded(v as Address) : v.length === 66 ? v.toLowerCase() : null);

/** The SpokePool deposit's `outputToken` (`receivingAssetId`) is the only token a fill can pay — and it is never the native coin:
 * the pool sends the wrapped native token to contract recipients, so a Safe can only ever be delivered a token address. */
const acrossDelivered = (receiving: unknown, e: QuoteSemantics): string | null => {
  if (isNative(e.toToken)) return "the quote asks for the native coin, but an Across fill pays a contract receiver the wrapped native token, never the coin";
  return asWord(receiving) === padded(e.toToken) ? null : `the Across call delivers ${String(receiving)}, not the quote's ${e.toToken}`;
};

/** Facet data structs, copied from the facet sources. `via` is the suffix of the facet's function names. */
export const FACETS: {
  via: string; data: string; checks: (d: Record<string, unknown>) => (Check & { value: unknown })[];
  /** The facet's semantics: which token the call deposits beyond BridgeData's, which token it delivers and where it routes,
   * proved against the quote — or a reason the facet cannot prove them. Omitted for facets refused wholesale by `guaranteed`. */
  prove?: (d: Record<string, unknown>, e: QuoteSemantics) => string | null;
  /** The least the destination can pay the receiver, proved from the calldata (`minAmount` is BridgeData's: what the bridge is fed), or a reason it cannot be proved. */
  guaranteed: (d: Record<string, unknown>, minAmount: bigint) => bigint | string;
}[] = [
  { // AcrossFacetV3 (archived): receiverAddress and refundAddress are addresses.
    via: "AcrossV3", data: "struct AcrossV3Data { address receiverAddress; address refundAddress; address receivingAssetId; uint256 outputAmount; uint64 outputAmountPercent; address exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityDeadline; bytes message; }",
    checks: (d) => [safe("receiverAddress", d), safe("refundAddress", d), empty("message", d)],
    prove: (d, e) => acrossDelivered(d.receivingAssetId, e),
    guaranteed: acrossOutput,
  },
  { // AcrossFacetV4: the same, as bytes32. `sendingAssetId` is the input token only for an ERC-20 deposit — a native deposit ignores it.
    via: "AcrossV4", data: "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
    checks: (d) => [safe("receiverAddress", d), safe("refundAddress", d), empty("message", d)],
    prove: (d, e) =>
      acrossDelivered(d.receivingAssetId, e) ??
      (isNative(e.fromToken) || asWord(d.sendingAssetId) === padded(e.fromToken) ? null : `the Across call deposits ${String(d.sendingAssetId)}, not the quote's ${e.fromToken}`),
    guaranteed: acrossOutput,
  },
  { // RelayFacet (archived): the receiver is BridgeData's, signed into the request; a non-EVM receiver must be unset.
    via: "Relay", data: "struct RelayData { bytes32 requestId; bytes32 nonEVMReceiver; bytes32 receivingAssetId; bytes signature; }",
    checks: (d) => [zero("nonEVMReceiver", d)],
    guaranteed: () => opaque("Relay"),
  },
  { // PolymerCCTPFacet: CCTP depositForBurn of the facet's immutable USDC — the only asset it can ever carry.
    via: "PolymerCCTP", data: "struct PolymerCCTPData { uint256 polymerTokenFee; uint256 maxCCTPFee; bytes32 nonEVMReceiver; bytes32 solanaReceiverATA; uint32 minFinalityThreshold; address refundRecipient; bytes hookData; }",
    checks: (d) => [zero("nonEVMReceiver", d), zero("solanaReceiverATA", d), safe("refundRecipient", d), empty("hookData", d)],
    prove: (_d, e) => {
      const src = USDC[e.fromChain], dst = USDC[e.toChain];
      if (!src || !dst) return "the Polymer call only ever carries USDC, and the app cannot prove USDC on this network pair";
      return isAddressEqual(e.fromToken, src) && isAddressEqual(e.toToken, dst) ? null : "the Polymer call only ever carries USDC, which is not what the quote names";
    },
    guaranteed: (d, minAmount) => minAmount - (d.polymerTokenFee as bigint) - (d.maxCCTPFee as bigint),
  },
  { // SymbiosisFacet: the MetaRouter's own calldata (`callData`, `onchainSwapData`) is opaque here and is checked for the Safe by `symbiosisOpaque`.
    via: "Symbiosis", data: "struct SymbiosisData { address refundRecipient; bytes32 nonEvmReceiver; bytes firstSwapCalldata; bytes secondSwapCalldata; address firstDexRouter; address secondDexRouter; address[] approvedTokens; address callTo; bytes callData; bool viaOnchainSwapV3; address dex; address dexgateway; bytes onchainSwapData; uint256 fee; uint256 deadline; bytes signature; }",
    checks: (d) => [safe("refundRecipient", d), zero("nonEvmReceiver", d)],
    guaranteed: () => "Symbiosis routes are not supported: their recipient cannot be fully checked",
  },
  { // StargateFacetV2: the route is `sendParams.dstEid` and the delivered token is the impl's for `assetId` — BridgeData is
    // only analytics. `sendParams.minAmountLD` is enforced against the send in shared decimals, so it is floored first.
    via: "Stargate", data: "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; } struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; } struct StargateData { uint16 assetId; SendParam sendParams; MessagingFee fee; address refundAddress; }",
    checks: (d) => {
      const sp = d.sendParams as Record<string, unknown>;
      return [
        safe("refundAddress", d),
        { name: "sendParams.to", kind: "safe", value: sp.to },
        { name: "sendParams.composeMsg", kind: "empty", value: sp.composeMsg },
        // LayerZero options can direct a native token drop to a separate receiver.
        { name: "sendParams.extraOptions", kind: "empty", value: sp.extraOptions },
      ];
    },
    prove: (d, e) => {
      const sp = d.sendParams as { dstEid: number };
      const asset = STARGATE_ASSETS[d.assetId as number];
      if (!asset) return `the Stargate call carries asset id ${String(d.assetId)}, which the app cannot prove a token for`;
      const eid = LZ_DST_EID[e.toChain];
      if (eid === undefined || sp.dstEid !== eid) return `the Stargate call routes to LayerZero endpoint ${sp.dstEid}, not the quote's destination network`;
      if (!asset.nativeChains.has(e.fromChain) || !asset.nativeChains.has(e.toChain)) return "the Stargate call carries the native coin over a network where the app cannot prove it lands as the coin";
      return isNative(e.fromToken) && isNative(e.toToken) ? null : "the Stargate call carries the native coin, not the quote's token";
    },
    guaranteed: (d) => {
      const asset = STARGATE_ASSETS[d.assetId as number];
      if (!asset) return "the Stargate call carries an asset the app cannot prove";
      const rate = 10n ** BigInt(asset.localDecimals - asset.sharedDecimals);
      const min = (d.sendParams as Record<string, unknown>).minAmountLD as bigint;
      return min - (min % rate);
    },
  },
  { // LayerSwapFacet: `depositoryReceiver` is LayerSwap's deposit contract, not a recipient.
    via: "LayerSwap", data: "struct LayerSwapData { bytes32 requestId; address depositoryReceiver; address refundRecipient; bytes32 nonEVMReceiver; bytes signature; uint256 deadline; }",
    checks: (d) => [safe("refundRecipient", d), zero("nonEVMReceiver", d)],
    guaranteed: () => opaque("LayerSwap"),
  },
];

const structName = (data: string) => data.match(/struct (\w+Data) \{[^}]*\}\s*$/)![1]!;

function abiFor(f: (typeof FACETS)[number]) {
  const name = structName(f.data);
  return parseAbi([
    BRIDGE_DATA, SWAP_DATA, ...f.data.split(/(?<=\})\s+/),
    `function startBridgeTokensVia${f.via}(BridgeData _bridgeData, ${name} _facetData) payable`,
    `function swapAndStartBridgeTokensVia${f.via}(BridgeData _bridgeData, SwapData[] _swapData, ${name} _facetData) payable`,
  ]);
}

const ABIS = FACETS.map((f) => ({ f, abi: abiFor(f) }));
const SELECTORS = new Map<string, { f: (typeof FACETS)[number]; abi: ReturnType<typeof abiFor>; swap: boolean }>();
for (const { f, abi } of ABIS) {
  for (const swap of [false, true]) {
    const item = getAbiItem({ abi, name: `${swap ? "swapAndStart" : "start"}BridgeTokensVia${f.via}` as never })!;
    SELECTORS.set(toFunctionSelector(item as never), { f, abi, swap });
  }
}

export type BridgeCall = { facet: string; receiver: Address; minAmount: bigint; destinationChainId: bigint; hasDestinationCall: boolean; hasSourceSwaps: boolean; /** The least the calldata can pay the receiver on the destination network, in the quote's `toToken` units. */ guaranteed: bigint };
export type ReadBridgeCall = { ok: true; call: BridgeCall } | { ok: false; reason: string };

/** Does the Safe's address appear as a whole 32-byte word of `data`? (Symbiosis's MetaRouter calldata embeds its receiver.) */
const hasAddressWord = (data: unknown, safeAddr: Address) => typeof data === "string" && data.slice(2).toLowerCase().includes(padded(safeAddr).slice(2));

/**
 * Decode a bridge call and check it against the Safe and the quote: every recipient, refund and fallback address is the Safe;
 * the token BridgeData deposits is the quote's `fromToken`; the facet proves its delivered token is the quote's `toToken` and
 * that its real route is the quote's `toChain`. Refused: an unknown facet, calldata that does not decode, any address field
 * that is not the Safe, a destination call or a message, and any token, route or floor the calldata cannot prove.
 */
export function readBridgeCall(data: Hex, safeAddr: Address, expected: QuoteSemantics): ReadBridgeCall {
  const sel = SELECTORS.get(data.slice(0, 10).toLowerCase());
  if (!sel) return { ok: false, reason: `the bridge calldata calls a function (${data.slice(0, 10)}) the app does not know how to read` };
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: sel.abi, data }).args as readonly unknown[];
  } catch {
    return { ok: false, reason: "the bridge calldata could not be read" };
  }
  if (sel.swap) return { ok: false, reason: `the calldata swaps on the source network before bridging, and a swap the app did not build cannot be fully checked` };
  const bd = args[0] as { receiver: Address; sendingAssetId: Address; minAmount: bigint; destinationChainId: bigint; hasDestinationCall: boolean; hasSourceSwaps: boolean };
  if (bd.hasSourceSwaps) return { ok: false, reason: "the calldata claims a source swap but calls the function for a direct bridge" };
  const owner = getAddress(safeAddr);
  if (!isAddressEqual(bd.receiver, owner)) return { ok: false, reason: `the call's receiver is ${bd.receiver}, not the Safe` };
  const fd = args[args.length - 1] as Record<string, unknown>;
  for (const c of sel.f.checks(fd)) {
    const v = c.value;
    const ok = c.kind === "zero" ? isZero(v)
      : c.kind === "empty" ? v === "0x"
      : typeof v === "string" && v.length === 66 ? v.toLowerCase() === padded(owner)
      : typeof v === "string" && isAddressEqual(v as Address, owner);
    if (!ok) return { ok: false, reason: c.kind === "safe" ? `the ${sel.f.via} data's ${c.name} is ${String(v)}, not the Safe` : `the ${sel.f.via} data's ${c.name} must be ${c.kind === "zero" ? "unset" : "empty"}` };
  }
  if (!isAddressEqual(bd.sendingAssetId, expected.fromToken)) return { ok: false, reason: `the call deposits ${bd.sendingAssetId}, not the quote's ${expected.fromToken}` };
  const semantics = sel.f.prove?.(fd, expected);
  if (semantics) return { ok: false, reason: semantics };
  const guaranteed = sel.f.guaranteed(fd, bd.minAmount);
  if (typeof guaranteed === "string") return { ok: false, reason: guaranteed };
  return { ok: true, call: { facet: sel.f.via, receiver: getAddress(bd.receiver), minAmount: bd.minAmount, destinationChainId: bd.destinationChainId, hasDestinationCall: bd.hasDestinationCall, hasSourceSwaps: bd.hasSourceSwaps, guaranteed } };
}

/** For tests and the MOCK aggregator: encode a call of a facet from BridgeData and facet fields. */
export function encodeBridgeCall(via: string, bridgeData: Record<string, unknown>, facetData: unknown, swaps: readonly Record<string, unknown>[] | boolean = false): Hex {
  const entry = ABIS.find((a) => a.f.via === via);
  if (!entry) throw new Error(`unknown facet ${via}`);
  const swapData = swaps === true ? [] : swaps;
  return (encodeFunctionData as (a: unknown) => Hex)({ abi: entry.abi, functionName: `${swaps ? "swapAndStart" : "start"}BridgeTokensVia${via}`, args: swaps ? [bridgeData, swapData, facetData] : [bridgeData, facetData] });
}
