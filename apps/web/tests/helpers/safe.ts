// Fork helpers for Safe 1.4.1: deploy a test Safe through the pinned factory and execute a Safe
// transaction with owner signatures. Owner keys must be anvil keys (ANVIL_KEYS).
import { concatHex, getAddress, parseEventLogs, parseAbi, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentCalldata, newSafeSetup, predictSafeAddress } from "@/server/safe/setup";
import { safeTxHash, safeTxTypedData } from "@/server/safe/hash";
import { SAFE_PROXY_FACTORY } from "@/server/safe/constants";
import type { Address, ChainId, SafeSetup, SafeTx } from "@/shared/types";
import { ANVIL_KEYS, type Fork } from "./anvil";

export const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash, uint256 payment)",
]);

/** The account that pays for fork transactions (anvil account 0, funded on the fork). */
const sender = () => privateKeyToAccount(ANVIL_KEYS[0]);

/** Deploy a SafeL2 1.4.1 proxy through the pinned factory. Returns the setup and the deployed address. */
export async function deployTestSafe(p: {
  fork: Fork;
  owners: Address[];
  threshold: number;
  saltNonce?: string;
}): Promise<{ setup: SafeSetup; address: Address; predicted: Address; receipt: TransactionReceipt }> {
  const setup = newSafeSetup({ owners: p.owners, threshold: p.threshold, saltNonce: p.saltNonce ?? "1" });
  const predicted = predictSafeAddress(setup);
  const hash = await p.fork.walletClient.sendTransaction({
    account: sender(),
    chain: p.fork.chain,
    to: SAFE_PROXY_FACTORY,
    data: deploymentCalldata(setup),
  });
  const receipt = await p.fork.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Safe deployment reverted");
  const code = await p.fork.publicClient.getCode({ address: predicted });
  if (!code || code === "0x") throw new Error("no code at the predicted Safe address");
  return { setup, address: predicted, predicted, receipt };
}

/** Signatures of `ownerKeys` over the Safe tx hash, sorted by owner address as the contract requires. */
export async function signSafeTx(chainId: ChainId, safe: Address, tx: SafeTx, ownerKeys: readonly Hex[]): Promise<Hex> {
  const sigs = await Promise.all(
    ownerKeys.map(async (k) => {
      const account = privateKeyToAccount(k);
      return { owner: account.address, sig: await account.signTypedData(safeTxTypedData(chainId, safe, tx)) };
    }),
  );
  sigs.sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  return concatHex(sigs.map((s) => s.sig));
}

/** Execute `tx` on the Safe with signatures from `ownerKeys`. `success` comes from the Safe's events. */
export async function execSafeTx(
  fork: Fork,
  safe: Address,
  tx: SafeTx,
  ownerKeys: readonly Hex[],
): Promise<{ receipt: TransactionReceipt; success: boolean; safeTxHash: Hex }> {
  const signatures = await signSafeTx(fork.chain.id as ChainId, safe, tx, ownerKeys);
  const hash = await fork.walletClient.writeContract({
    account: sender(),
    chain: fork.chain,
    address: getAddress(safe),
    abi: safeAbi,
    functionName: "execTransaction",
    args: [
      tx.to, BigInt(tx.value), tx.data, tx.operation, BigInt(tx.safeTxGas), BigInt(tx.baseGas),
      BigInt(tx.gasPrice), tx.gasToken, tx.refundReceiver, signatures,
    ],
    gas: 3_000_000n,
  });
  const receipt = await fork.publicClient.waitForTransactionReceipt({ hash });
  const logs = parseEventLogs({ abi: safeAbi, logs: receipt.logs, eventName: ["ExecutionSuccess", "ExecutionFailure"] });
  const success = logs.some((l) => l.eventName === "ExecutionSuccess") && !logs.some((l) => l.eventName === "ExecutionFailure");
  return { receipt, success, safeTxHash: safeTxHash(fork.chain.id as ChainId, safe, tx) };
}
