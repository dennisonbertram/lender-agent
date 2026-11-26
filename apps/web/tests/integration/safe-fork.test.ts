import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe, execSafeTx, safeAbi } from "../helpers/safe";
import {
  COMPATIBILITY_FALLBACK_HANDLER, MULTISEND_CALL_ONLY, SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY,
} from "@/server/safe/constants";
import { safeTxHash } from "@/server/safe/hash";
import { buildSafeTx } from "@/server/safe/multisend";
import { PROXY_CREATION_CODE, predictSafeAddress, proxyFactoryAbi } from "@/server/safe/setup";
import type { Address, SafeTx } from "@/shared/types";

const owners = [0, 1, 2].map((i) => privateKeyToAccount(ANVIL_KEYS[i]!).address) as Address[];
const ownerKeys = [ANVIL_KEYS[0], ANVIL_KEYS[1]] as Hex[]; // 2 of 3
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);

describe("Safe 1.4.1 on a Base fork", () => {
  let fork: Fork;
  let safe: Address;
  beforeAll(async () => { fork = await startBaseFork(); });
  afterAll(async () => { await fork?.stop(); });

  it("pinned contracts have code and the creation code matches the factory", async () => {
    for (const a of [SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY, COMPATIBILITY_FALLBACK_HANDLER, MULTISEND_CALL_ONLY]) {
      const code = await fork.publicClient.getCode({ address: a });
      expect(code && code.length > 2, a).toBe(true);
    }
    const creation = await fork.publicClient.readContract({ address: SAFE_PROXY_FACTORY, abi: proxyFactoryAbi, functionName: "proxyCreationCode" });
    expect(creation).toBe(PROXY_CREATION_CODE);
  });

  it("deploys a 2-of-3 Safe at the predicted address", async () => {
    const d = await deployTestSafe({ fork, owners, threshold: 2, saltNonce: "42" });
    safe = d.address;
    expect(d.address).toBe(predictSafeAddress(d.setup));
    const onchainOwners = await fork.publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" });
    expect(onchainOwners.map(getAddress)).toEqual(owners.map(getAddress));
    expect(await fork.publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" })).toBe(2n);
    expect(predictSafeAddress({ ...d.setup, saltNonce: "43" })).not.toBe(safe);
  });

  it("our safeTxHash equals the contract's getTransactionHash", async () => {
    const txs: SafeTx[] = [
      buildSafeTx([{ to: WETH, data: "0xdeadbeef", value: 7n }], 0),
      buildSafeTx([{ to: WETH, data: "0x" }, { to: owners[0]!, value: 1n }], 5),
      { ...buildSafeTx([{ to: WETH }], 3), safeTxGas: "21000", baseGas: "100", gasPrice: "2" },
    ];
    for (const tx of txs) {
      const onchain = await fork.publicClient.readContract({
        address: safe, abi: safeAbi, functionName: "getTransactionHash",
        args: [tx.to, BigInt(tx.value), tx.data, tx.operation, BigInt(tx.safeTxGas), BigInt(tx.baseGas), BigInt(tx.gasPrice), tx.gasToken, tx.refundReceiver, BigInt(tx.nonce)],
      });
      expect(safeTxHash(8453, safe, tx)).toBe(onchain);
    }
  });

  it("executes a MultiSendCallOnly batch of two calls with two owner signatures", async () => {
    const spenders = ["0x000000000000000000000000000000000000dEaD", "0x000000000000000000000000000000000000bEEF"] as const;
    const tx = buildSafeTx(
      spenders.map((s, i) => ({ to: WETH, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [s, BigInt(i + 1)] }) })),
      0,
    );
    expect(tx).toMatchObject({ to: MULTISEND_CALL_ONLY, operation: 1 });
    const r = await execSafeTx(fork, safe, tx, ownerKeys);
    expect(r.success).toBe(true);
    for (const [i, s] of spenders.entries()) {
      expect(await fork.publicClient.readContract({ address: WETH, abi: erc20, functionName: "allowance", args: [safe, s] })).toBe(BigInt(i + 1));
    }
    expect(await fork.publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" })).toBe(1n);
  });

  it("a reverted inner call is observable (ExecutionFailure)", async () => {
    // the Safe holds no ETH, so sending 1 ether fails inside; safeTxGas > 0 lets the outer tx succeed
    const tx: SafeTx = { ...buildSafeTx([{ to: owners[2]!, value: parseEther("1") }], 1), safeTxGas: "100000" };
    const r = await execSafeTx(fork, safe, tx, ownerKeys);
    expect(r.receipt.status).toBe("success");
    expect(r.success).toBe(false);
  });

  it("one owner signature is not enough", async () => {
    const tx = buildSafeTx([{ to: owners[2]!, value: 0n }], 2);
    const r = await execSafeTx(fork, safe, tx, [ANVIL_KEYS[0]]); // GS020: signatures too short
    expect(r.receipt.status).toBe("reverted");
    expect(r.success).toBe(false);
  });
});
