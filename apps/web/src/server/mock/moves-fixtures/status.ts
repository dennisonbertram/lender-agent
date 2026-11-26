// Recorded-shape /v1/status bodies (docs.li.fi status tracking; field names checked against the live API on 2026-11-14 with a
// historic transfer). Amounts are the destination token's smallest unit. One per outcome the move follow-up must handle.
export const SAFE = "0x9fC3dc011b461664c835F2527fffb1169b3C213e";
export const SRC_TX = "0x" + "a1".repeat(32);
export const DEST_TX = "0x" + "b2".repeat(32);
const base = { transactionId: "0x" + "c3".repeat(32), fromAddress: SAFE.toLowerCase(), toAddress: SAFE.toLowerCase(), tool: "relay", sending: { txHash: SRC_TX, chainId: 8453, amount: "1000000000000000" } };
const receiving = (amount: string, chainId = 1, token = "0x0000000000000000000000000000000000000000") => ({ txHash: DEST_TX, chainId, amount, token: { address: token, chainId, symbol: "ETH", decimals: 18 } });

export const STATUS = {
  done: { ...base, status: "DONE", substatus: "COMPLETED", substatusMessage: "The transfer is complete.", receiving: receiving("910700000000000") },
  doneLess: { ...base, status: "DONE", substatus: "COMPLETED", substatusMessage: "The transfer is complete.", receiving: receiving("900000000000000") },
  partial: { ...base, status: "DONE", substatus: "PARTIAL", substatusMessage: "The transfer is partially complete: you received a different token.", receiving: receiving("5000", 1, "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0") },
  refunded: { ...base, status: "DONE", substatus: "REFUNDED", substatusMessage: "The transfer was refunded.", receiving: { txHash: "0x" + "d4".repeat(32), chainId: 8453, amount: "1000000000000000" } },
  failed: { ...base, status: "FAILED", substatus: "NOT_PROCESSABLE_REFUND_NEEDED", substatusMessage: "The transfer cannot be completed; a refund is needed." },
  pending: { ...base, status: "PENDING", substatus: "WAIT_DESTINATION_TRANSACTION", substatusMessage: "Waiting for the destination transaction." },
  notFound: { status: "NOT_FOUND", message: "Transaction not found" },
} as const;
