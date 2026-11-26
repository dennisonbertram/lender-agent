// Fork helper for the Reserve (M0-6 on Base): a Reserve Safe whose owners sign two Safe transactions, exactly as
// the real setup does: (1) deploy a Roles v2 proxy through the Zodiac factory; (2) one MultiSend that enables it,
// approves the pool once (owners sign the approval, the role has no `approve`), assigns the executor, scopes
// `Pool.repay` and sets the daily allowance. No hosted API is involved.
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tokenBySymbol } from "@/server/chain/config";
import type { Db } from "@/server/db/client";
import { reserveLinks, safes } from "@/server/db/schema";
import { revokeCall, setLimitCall } from "@/server/reserve/policy-change/calls";
import { buildReserveSetup } from "@/server/reserve";
import type { ExecLink } from "@/server/reserve/types";
import type { Address, SafeTx } from "@/shared/types";
import { ANVIL_KEYS, type Fork } from "./anvil";
import { setUsdc } from "./oracle";
import { deployTestSafe, execSafeTx, safeAbi } from "./safe";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
export const USDC = tokenBySymbol(8453, "USDC")!.address!;
export const reserveOwnerKeys = [ANVIL_KEYS[0], ANVIL_KEYS[1]] as unknown as Hex[];
export const EXECUTOR_KEY = ANVIL_KEYS[4];
export const executorAddress = privateKeyToAccount(EXECUTOR_KEY).address as Address;

export async function safeTx(fork: Fork, safe: Address, p: { to: Address; data: Hex; operation?: 0 | 1 }): Promise<SafeTx> {
  const nonce = await fork.publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  return { to: p.to, value: "0", data: p.data, operation: p.operation ?? 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO, nonce: String(nonce) };
}

export async function execOwners(fork: Fork, safe: Address, tx: SafeTx, keys: readonly Hex[] = reserveOwnerKeys) {
  const r = await execSafeTx(fork, safe, tx, keys);
  if (!r.success) throw new Error("the Safe transaction failed");
  return r;
}

/** A Reserve Safe set up by the canonical `buildReserveSetup` batch, signed by its two owners like the real setup. */
export async function deployReserve(fork: Fork, p: { mainSafe: Address; dailyLimitUsdc: number; balanceUsdc: number; saltNonce: string; /** Keys of the Reserve Safe's two owners (default: anvil 0 and 1). */ ownerKeys?: Hex[] }): Promise<ExecLink> {
  const keys = p.ownerKeys ?? reserveOwnerKeys;
  const owners = keys.map((k) => privateKeyToAccount(k).address) as Address[];
  const { address: reserveSafe } = await deployTestSafe({ fork, owners, threshold: 2, saltNonce: p.saltNonce });
  const block = await fork.publicClient.getBlock();
  const setup = buildReserveSetup({ chainId: 8453, reserveSafe, mainSafe: p.mainSafe, executor: executorAddress, dailyLimit: BigInt(Math.round(p.dailyLimitUsdc * 1e6)), nowSec: Number(block.timestamp) }, await fork.publicClient.readContract({ address: reserveSafe, abi: safeAbi, functionName: "nonce" }));
  await execOwners(fork, reserveSafe, setup.tx, keys);
  await setUsdc(fork, reserveSafe, BigInt(Math.round(p.balanceUsdc * 1e6)));
  return {
    safeId: 0, chainId: 8453, mainSafe: p.mainSafe, reserveSafe, roles: setup.roles, executor: executorAddress,
    token: USDC, tokenSymbol: "USDC", tokenDecimals: 6, trigger: 1.3, attempt: 0, active: true, fromBlock: block.number,
  };
}

/** The canonical `reserve_links` row (and the Reserve Safe's `safes` row) for a Reserve made by `deployReserve`. */
export async function saveLink(db: Db, l: ExecLink, dailyLimit = "0"): Promise<void> {
  const [res] = await db.insert(safes).values({ address: l.reserveSafe.toLowerCase(), name: "Reserve" }).returning();
  await db.insert(reserveLinks).values({
    mainSafeId: l.safeId, reserveSafeId: res!.id, chainId: l.chainId, rolesAddress: l.roles.toLowerCase(), executorAddress: l.executor.toLowerCase(), saltNonce: "0",
    dailyLimit, triggerHf: l.trigger, attempt: l.attempt, fromBlock: l.fromBlock, state: l.active ? "linked" : "off",
  });
}

/** The owners' Safe transaction that removes the executor from the role. */
export const executeRevoke = async (fork: Fork, link: ExecLink) =>
  execOwners(fork, link.reserveSafe, await safeTx(fork, link.reserveSafe, revokeCall(link)));
export { revokeCall, setLimitCall };
