// The chain calls the execute route needs: simulate the call as the sender, price gas, look up a sent
// transaction. Real by default; mock mode and tests use `mockExecDeps` or their own.
import { MOCK_GAS_PRICE_WEI, MOCK_TX_GAS } from "@/server/simulate/fee";
import type { Address, ChainId, Hex } from "@/shared/types";
import { getPublicClient } from "@/server/chain/client";
import { decodeSafeRevert } from "@/server/safe/errors";

export type ExecReceipt = { status: "success" | "reverted"; logs: { address: Address; topics: readonly Hex[]; data: Hex }[] };

export type ExecDeps = {
  /** eth_estimateGas as `from`; a revert is returned decoded, never thrown. */
  estimate(p: { chainId: ChainId; from: Address; to: Address; data: Hex }): Promise<{ ok: true; gas: bigint } | { ok: false; error: string }>;
  /** Wei per gas. */
  gasPrice(chainId: ChainId): Promise<bigint>;
  /** A transaction by hash, or null when the node does not know it (yet). */
  getTransaction(chainId: ChainId, hash: Hex): Promise<{ to: Address | null; input: Hex } | null>;
  /** A mined transaction's receipt, or null when it is not mined (or unknown). */
  getReceipt(chainId: ChainId, hash: Hex): Promise<ExecReceipt | null>;
};

export const chainExecDeps: ExecDeps = {
  async estimate({ chainId, from, to, data }) {
    try {
      return { ok: true, gas: await getPublicClient(chainId).estimateGas({ account: from, to, data }) };
    } catch (e) {
      return { ok: false, error: decodeSafeRevert(e) };
    }
  },
  gasPrice: (chainId) => getPublicClient(chainId).getGasPrice(),
  async getTransaction(chainId, hash) {
    const tx = await getPublicClient(chainId).getTransaction({ hash }).catch(() => null);
    return tx ? { to: tx.to ?? null, input: tx.input } : null;
  },
  async getReceipt(chainId, hash) {
    const r = await getPublicClient(chainId).getTransactionReceipt({ hash }).catch(() => null);
    return r ? { status: r.status, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) } : null;
  },
};

export const mockExecDeps: ExecDeps = {
  estimate: async () => ({ ok: true, gas: MOCK_TX_GAS }),
  gasPrice: async () => MOCK_GAS_PRICE_WEI,
  getTransaction: async () => null,
  getReceipt: async () => null,
};
