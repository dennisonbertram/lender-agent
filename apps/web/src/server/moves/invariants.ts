// The move's invariants (architecture section 2 rule 4, milestones M5 exit 3). A move is built from the aggregator's
// transaction only after this passes: the Safe is sender and recipient, the destination is the network asked for, the
// only contract called is the aggregator's, and the batch is exactly what the checked quote produces.
import { encodeFunctionData, getAddress, isAddressEqual, type Hex } from "viem";
import { erc20Abi } from "@/server/chain/abis";
import { MULTISEND_CALL_ONLY } from "@/server/chain/config";
import { encodeMultiSend, type Call } from "@/server/safe/multisend";
import type { Address, SafeTx } from "@/shared/types";
import { readBridgeCall } from "./facets";
import { LIFI_DIAMOND } from "./lifi";
import type { AggregatorQuote, MoveChain } from "./types";

export type MoveCheck = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): MoveCheck => ({ ok: false, reason });
const ZERO = "0x0000000000000000000000000000000000000000";

/** The recipient invariant and the checks around it, on one quote. */
export function checkMoveQuote(q: AggregatorQuote, p: { safe: Address; fromChain: MoveChain; toChain: MoveChain }): MoveCheck {
  const safe = getAddress(p.safe);
  if (q.fromChain !== p.fromChain || q.toChain !== p.toChain) return fail("the quote is for a different pair of networks");
  if (!isAddressEqual(q.fromAddress, safe)) return fail("the quote is sent from an address that is not the Safe");
  if (!isAddressEqual(q.toAddress, safe)) return fail("the quote pays an address that is not the Safe");
  if (!isAddressEqual(q.tx.from, safe) || q.tx.chainId !== p.fromChain) return fail("the transaction is not the Safe's, on the source network");
  if (!isAddressEqual(q.tx.to, LIFI_DIAMOND)) return fail(`the transaction calls ${q.tx.to}, not the bridge aggregator`);
  if (q.approvalAddress && !isAddressEqual(q.approvalAddress, LIFI_DIAMOND)) return fail(`the approval goes to ${q.approvalAddress}, not the bridge aggregator`);
  const native = q.fromToken.toLowerCase() === ZERO;
  if (native ? q.tx.value !== q.fromAmount : q.tx.value !== 0n) return fail("the transaction carries an unexpected amount of ETH");
  if (!native && !q.approvalAddress) return fail("the token needs an approval and the quote names none");
  if (q.toAmountMin <= 0n || q.toAmountMin > q.toAmount) return fail("the quote's minimum received is not usable");
  const read = readBridgeCall(q.tx.data, safe, { fromChain: q.fromChain, toChain: q.toChain, fromToken: q.fromToken, toToken: q.toToken });
  if (!read.ok) return fail(read.reason);
  const bd = read.call;
  if (!isAddressEqual(bd.receiver, safe)) return fail(`the calldata's receiver is ${bd.receiver}, not the Safe`);
  if (bd.destinationChainId !== BigInt(p.toChain)) return fail("the calldata's destination network is not the one asked for");
  if (bd.hasDestinationCall) return fail("the calldata makes a call on the destination network");
  if (bd.minAmount > q.fromAmount) return fail("the calldata moves more than the quote's amount");
  if (bd.guaranteed < q.toAmountMin) return fail(`the calldata guarantees ${bd.guaranteed} on arrival, less than the quote's ${q.toAmountMin}`);
  return { ok: true };
}

/** The calls of a move: approve (tokens only) then the aggregator's transaction. The card's step wording is the library's (`compute`). */
export function buildMoveBatch(q: AggregatorQuote): Required<Call>[] {
  const calls: Required<Call>[] = [];
  if (q.approvalAddress) calls.push({ to: q.fromToken, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [q.approvalAddress, q.fromAmount] }) });
  calls.push({ to: q.tx.to, value: q.tx.value, data: q.tx.data });
  return calls;
}

const sameCall = (a: Call, b: Call) => a.to.toLowerCase() === b.to.toLowerCase() && BigInt(a.value ?? 0) === BigInt(b.value ?? 0) && (a.data ?? "0x").toLowerCase() === (b.data ?? "0x").toLowerCase();

/** The batch and the outer Safe transaction are exactly what the checked quote produces. */
export function checkMoveBatch(q: AggregatorQuote, p: { safe: Address; fromChain: MoveChain; toChain: MoveChain; calls: (Call & { operation?: number })[]; outer: SafeTx }): MoveCheck {
  const quote = checkMoveQuote(q, p);
  if (!quote.ok) return quote;
  const expected = buildMoveBatch(q);
  if (p.calls.length !== expected.length || p.calls.some((c, i) => (c.operation ?? 0) !== 0 || !sameCall(c, expected[i]!))) return fail("the batch is not what the checked quote produces");
  const o = p.outer;
  if (o.gasPrice !== "0" || o.safeTxGas !== "0" || o.baseGas !== "0") return fail("the transaction asks the Safe to refund gas");
  if (o.gasToken.toLowerCase() !== ZERO || o.refundReceiver.toLowerCase() !== ZERO) return fail("the transaction names a refund receiver");
  if (o.operation === 1) {
    if (o.to.toLowerCase() !== MULTISEND_CALL_ONLY.toLowerCase()) return fail("a delegate call must go to the batch contract (MultiSendCallOnly)");
    if (BigInt(o.value) !== 0n) return fail("the batch transaction carries ETH");
    return o.data.toLowerCase() === encodeMultiSend(p.calls).toLowerCase() ? { ok: true } : fail("the transaction does not match the checked calls");
  }
  if (o.operation !== 0 || p.calls.length !== 1) return fail("a plain transaction must hold exactly one call");
  return sameCall(o, p.calls[0]!) ? { ok: true } : fail("the transaction does not match the checked calls");
}

