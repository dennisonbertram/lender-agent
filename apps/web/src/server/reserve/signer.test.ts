import { encodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ANVIL_DEV_KEYS } from "@/server/signer/dev";
import type { Address } from "@/shared/types";
import { buildRoleRepay } from "./build";
import { assertRoleCall, DevExecutorSigner, getExecutorSigner, KmsExecutorSigner } from "./signer";
import { ROLE_KEY } from "./constants";
import { rolesAbi } from "./roles-abi";

const roles = "0x00000000000000000000000000000000000000aa" as Address;
const main = "0xBbceD41A64edAb661586A660c5E3421f55A83564" as Address;
const good = buildRoleRepay({ chainId: 8453, roles, mainSafe: main, amount: 1n });
const exec = (value: bigint, op: number, revert: boolean) =>
  encodeFunctionData({ abi: rolesAbi, functionName: "execTransactionWithRole", args: [main, value, "0x", op, ROLE_KEY, revert] });

describe("reserve executor signer (architecture 2 rule 6)", () => {
  it("signs only a role call without value or delegatecall that must revert on failure", () => {
    expect(() => assertRoleCall(good)).not.toThrow();
    expect(() => assertRoleCall({ data: good.data, value: 1n })).toThrow("never sends ETH");
    expect(() => assertRoleCall({ data: exec(1n, 0, true) })).toThrow("never sends ETH");
    expect(() => assertRoleCall({ data: exec(0n, 1, true) })).toThrow("never sends ETH or delegates");
    expect(() => assertRoleCall({ data: exec(0n, 0, false) })).toThrow("shouldRevert");
    expect(() => assertRoleCall({ data: "0xa9059cbb" as Hex })).toThrow("only signs execTransactionWithRole");
    expect(() => assertRoleCall({ data: "0x" })).toThrow("only signs execTransactionWithRole");
  });
  it("the dev key must be an anvil key; the KMS signer is a stub", async () => {
    expect(() => new DevExecutorSigner(`0x${"11".repeat(32)}`)).toThrow("anvil");
    expect(() => new DevExecutorSigner(undefined)).toThrow("not set");
    const s = new DevExecutorSigner(ANVIL_DEV_KEYS[2]);
    await expect(s.signRoleCall({ type: "eip1559", chainId: 8453, to: roles, data: "0xa9059cbb", gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0 })).rejects.toThrow("only signs");
    const raw = await s.signRoleCall({ type: "eip1559", chainId: 8453, to: roles, data: good.data, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0 });
    expect(raw.startsWith("0x02")).toBe(true);
    expect(() => new KmsExecutorSigner().address).toThrow("not configured");
  });
  it("is never the proposer key", () => {
    const key = ANVIL_DEV_KEYS[5]!;
    expect(() => getExecutorSigner({ DEV_EXECUTOR_KEY: key, DEV_PROPOSER_KEY: key })).toThrow("must not be the proposer key");
    expect(getExecutorSigner({ DEV_EXECUTOR_KEY: ANVIL_DEV_KEYS[2], DEV_PROPOSER_KEY: key }).address).not.toBe(getExecutorSigner({ DEV_EXECUTOR_KEY: key }).address);
    expect(() => getExecutorSigner({ EXECUTOR_SIGNER: "kms" }).address).toThrow("not configured");
    expect(() => getExecutorSigner({ EXECUTOR_SIGNER: "nope" })).toThrow("Unknown");
  });
});
