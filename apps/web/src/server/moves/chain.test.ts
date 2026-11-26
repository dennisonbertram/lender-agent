import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, toHex, type Hex } from "viem";
import { safeAbi } from "@/server/chain/abis";
import { SAFE, DEST_TX } from "@/server/mock/moves-fixtures/status";
import { CANONICAL_SAFE_SINGLETONS, SAFE_L2_SINGLETON } from "@/server/safe/constants";
import { isSafeProxyCode, PROXY_CREATION_CODE, SAFE_PROXY_EXECUTABLE, SAFE_PROXY_RUNTIME } from "@/server/safe/setup";
import { destinationFromClient, type ProbeClient, type TraceCall } from "./chain";
import { NATIVE } from "./types";

const safe = getAddress(SAFE);
const TOKEN = getAddress("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0");
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const topicOf = (a: string) => ("0x" + a.slice(2).toLowerCase().padStart(64, "0")) as `0x${string}`;
const log = (address: string, to: string, value: bigint) => ({ address, topics: [TRANSFER, topicOf("0x1111111111111111111111111111111111111111"), topicOf(to)] as `0x${string}`[], data: encodeAbiParameters([{ type: "uint256" }], [value]) });
const client = (o: Partial<{ status: "success" | "reverted"; logs: ReturnType<typeof log>[]; to: string | null; value: bigint; trace: TraceCall | null; noTraces: boolean; noReceipt: boolean }> = {}): ProbeClient => ({
  getTransactionReceipt: async () => (o.noReceipt ? null : { status: o.status ?? "success", blockNumber: 100n, logs: o.logs ?? [] }),
  getTransaction: async () => ({ to: o.to ?? null, value: o.value ?? 0n }),
  ...(o.noTraces ? {} : { traceCalls: async () => { if (!o.trace) throw new Error("no traces"); return o.trace; } }),
  getCode: async () => "0x6080",
});
const dest = (o?: Parameters<typeof client>[0]) => destinationFromClient(() => client(o));

describe("destination transaction pays the Safe", () => {
  it("a token: a Transfer log of that token to the Safe", async () => {
    const r = await dest({ logs: [log(TOKEN, safe, 7n), log(TOKEN, "0x00000000000000000000000000000000000dEaD1", 99n)] }).paysSafe({ chainId: 1, txHash: DEST_TX as `0x${string}`, safe, token: TOKEN });
    expect(r).toEqual({ ok: true, amountRaw: 7n });
  });
  it("a token: a Transfer of another token, or to someone else, is not payment", async () => {
    const other = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
    expect((await dest({ logs: [log(other, safe, 7n)] }).paysSafe({ chainId: 1, txHash: DEST_TX as `0x${string}`, safe, token: TOKEN })).ok).toBe(false);
    expect((await dest({ logs: [log(TOKEN, "0x00000000000000000000000000000000000dEaD1", 7n)] }).paysSafe({ chainId: 1, txHash: DEST_TX as `0x${string}`, safe, token: TOKEN })).ok).toBe(false);
  });
  const hash = DEST_TX as `0x${string}`;
  const trace = (value: string, to: string = safe): TraceCall => ({ type: "CALL", from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", value: "0x0", calls: [{ type: "CALL", to, value }] });
  it("native: a direct transfer to the Safe, or an internal transfer to it in this transaction's trace", async () => {
    expect(await dest({ to: safe, value: 9n }).paysSafe({ chainId: 1, txHash: hash, safe, token: NATIVE })).toEqual({ ok: true, amountRaw: 9n });
    expect(await dest({ trace: trace("0xf") }).paysSafe({ chainId: 1, txHash: hash, safe, token: NATIVE })).toEqual({ ok: true, amountRaw: 15n });
  });
  it("native: an unrelated deposit to the Safe in the same block is not payment", async () => {
    // The transaction's trace pays someone else (the Safe's block balance may have risen from another transaction).
    expect((await dest({ trace: trace("0xf", "0x00000000000000000000000000000000000dEaD1") }).paysSafe({ chainId: 1, txHash: hash, safe, token: NATIVE })).ok).toBe(false);
  });
  it("native: a transfer inside a failed sub-call is not payment", async () => {
    expect((await dest({ trace: { type: "CALL", to: "0x2222222222222222222222222222222222222222", error: "reverted", calls: [{ type: "CALL", to: safe, value: "0xf" }] } }).paysSafe({ chainId: 1, txHash: hash, safe, token: NATIVE })).ok).toBe(false);
  });
  it("native: no traces from the RPC means it cannot be proved yet", async () => {
    for (const o of [{ noTraces: true }, { trace: null }]) {
      const r = await dest(o).paysSafe({ chainId: 1, txHash: hash, safe, token: NATIVE });
      expect(r.ok).toBe(false);
    }
  });
  it("not confirmed: no receipt, or a reverted transaction", async () => {
    expect((await dest({ noReceipt: true }).paysSafe({ chainId: 1, txHash: DEST_TX as `0x${string}`, safe, token: NATIVE })).ok).toBe(false);
    expect((await dest({ status: "reverted", to: safe, value: 9n }).paysSafe({ chainId: 1, txHash: DEST_TX as `0x${string}`, safe, token: NATIVE })).ok).toBe(false);
  });
  it("a read that throws is not payment", async () => {
    const d = destinationFromClient(() => ({ ...client(), getTransactionReceipt: async () => { throw new Error("rpc"); } }));
    expect((await d.paysSafe({ chainId: 1, txHash: DEST_TX as `0x${string}`, safe, token: NATIVE })).ok).toBe(false);
  });
});

const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const ownersResult = (owners: string[]) => encodeFunctionResult({ abi: safeAbi, functionName: "getOwners", result: owners as `0x${string}`[] });

/** A destination probe whose `getCode` returns `code` and whose `ethCall` answers `calls` by calldata. */
const identityClient = (o: { code: Hex | undefined; calls?: Record<string, Hex | undefined>; noCall?: boolean; getCodeThrows?: boolean }): ProbeClient => ({
  getTransactionReceipt: async () => null,
  getTransaction: async () => ({ to: null, value: 0n }),
  getCode: async () => {
    if (o.getCodeThrows) throw new Error("rpc down");
    return o.code;
  },
  ...(o.noCall ? {} : { ethCall: async ({ data }: { to: `0x${string}`; data: Hex }) => o.calls?.[data.toLowerCase()] }),
});
const masterCopyCall = "0xa619486e";
const getOwnersCall = "0xa0e67e2b";

/**
 * The real Safe 1.3.0 proxy runtime: `deployedBytecode` of GnosisSafeProxy in the published
 * `@gnosis.pm/safe-contracts@1.3.0` artifact (the audited 1.3.0 deployment). Its executable code is
 * byte-identical to the 1.4.1 proxy's; only the CBOR metadata tail (the IPFS hash) differs.
 */
const SAFE_PROXY_RUNTIME_1_3_0: Hex =
  "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033";

describe("the destination Safe's owners are read only from a verified Safe", () => {
  const owners = [safe, "0x2222222222222222222222222222222222222222" as `0x${string}`];
  const realSafeCalls: Record<string, Hex> = {
    [masterCopyCall]: word(SAFE_L2_SINGLETON),
    [getOwnersCall]: ownersResult(owners),
  };
  const d = (o: Parameters<typeof identityClient>[0]) => destinationFromClient(() => identityClient(o));

  it("the proxy runtime is the code the pinned creation code deploys", () => {
    expect(PROXY_CREATION_CODE.slice(2 + 0x119 * 2, 2 + (0x119 + 0xab) * 2)).toBe(SAFE_PROXY_RUNTIME.slice(2));
    expect(CANONICAL_SAFE_SINGLETONS).toContain(SAFE_L2_SINGLETON);
    // Both audited proxy runtimes carry the same executable code; the metadata tail is the only difference.
    expect(SAFE_PROXY_RUNTIME.startsWith(SAFE_PROXY_EXECUTABLE)).toBe(true);
    expect(SAFE_PROXY_RUNTIME_1_3_0.startsWith(SAFE_PROXY_EXECUTABLE)).toBe(true);
    expect(isSafeProxyCode(SAFE_PROXY_RUNTIME)).toBe(true);
    expect(isSafeProxyCode(SAFE_PROXY_RUNTIME_1_3_0)).toBe(true);
    expect(isSafeProxyCode(`${SAFE_PROXY_RUNTIME}deadbeef` as Hex)).toBe(false);
  });

  it("a canonical Safe proxy: its live owners", async () => {
    expect(await d({ code: SAFE_PROXY_RUNTIME, calls: realSafeCalls }).ownersOf(1, safe)).toEqual(owners.map(getAddress));
    // The audited 1.x singletons are Safes too (an imported Safe may predate 1.4.1).
    const v130 = { [masterCopyCall]: word("0x3E5c63644E683549055b9Be8653de26E0B4CD36E"), [getOwnersCall]: ownersResult(owners) };
    expect(await d({ code: SAFE_PROXY_RUNTIME, calls: v130 }).ownersOf(1, safe)).toEqual(owners.map(getAddress));
  });

  it("a genuine 1.3.0 proxy is a Safe too: the same executable code, only the compiler metadata differs", async () => {
    expect(SAFE_PROXY_RUNTIME_1_3_0).not.toBe(SAFE_PROXY_RUNTIME);
    const v130 = { [masterCopyCall]: word("0x3E5c63644E683549055b9Be8653de26E0B4CD36E"), [getOwnersCall]: ownersResult(owners) };
    expect(await d({ code: SAFE_PROXY_RUNTIME_1_3_0, calls: v130 }).ownersOf(1, safe)).toEqual(owners.map(getAddress));
  });

  it("code that differs in the executable portion is not a Safe, even with a canonical singleton", async () => {
    // One instruction byte changed inside the executable region, metadata untouched: byte-exact is the rule.
    const mutated = `${SAFE_PROXY_RUNTIME.slice(0, 100)}aa${SAFE_PROXY_RUNTIME.slice(102)}` as Hex;
    expect(await d({ code: mutated, calls: realSafeCalls }).ownersOf(1, safe)).toBeNull();
  });

  it("the proxy executable with arbitrary bytes after it, or truncated, is not a Safe", async () => {
    expect(await d({ code: `${SAFE_PROXY_RUNTIME}deadbeef` as Hex, calls: realSafeCalls }).ownersOf(1, safe)).toBeNull();
    expect(await d({ code: SAFE_PROXY_RUNTIME.slice(0, -4) as Hex, calls: realSafeCalls }).ownersOf(1, safe)).toBeNull();
    expect(await d({ code: SAFE_PROXY_RUNTIME.slice(0, 200) as Hex, calls: realSafeCalls }).ownersOf(1, safe)).toBeNull();
  });

  it("a contract that merely implements getOwners is not a Safe", async () => {
    const calls = { [getOwnersCall]: ownersResult(owners) };
    expect(await d({ code: "0x6080604052" as Hex, calls }).ownersOf(1, safe)).toBeNull();
    // Even a getOwners answer naming the wallet: the wrong bytecode decides it before the call is ever made.
    expect(await d({ code: "0x60aa60" as Hex, calls: { ...calls, [masterCopyCall]: word(SAFE_L2_SINGLETON) } }).ownersOf(1, safe)).toBeNull();
  });

  it("a real proxy on a non-canonical singleton is not a Safe", async () => {
    const calls = { [masterCopyCall]: word("0x00000000000000000000000000000000000dEaD1"), [getOwnersCall]: ownersResult(owners) };
    expect(await d({ code: SAFE_PROXY_RUNTIME, calls }).ownersOf(1, safe)).toBeNull();
  });

  it("nothing there, no call support, or reads that fail: cannot be verified", async () => {
    expect(await d({ code: undefined }).ownersOf(1, safe)).toBeNull();
    expect(await d({ code: SAFE_PROXY_RUNTIME, noCall: true }).ownersOf(1, safe)).toBeNull();
    expect(await d({ code: SAFE_PROXY_RUNTIME, calls: { [masterCopyCall]: word(SAFE_L2_SINGLETON) } }).ownersOf(1, safe)).toBeNull(); // getOwners unanswered
    expect(await d({ code: SAFE_PROXY_RUNTIME, getCodeThrows: true, calls: realSafeCalls }).ownersOf(1, safe)).toBeNull();
  });
});
