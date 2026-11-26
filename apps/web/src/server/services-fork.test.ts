import { describe, expect, it, vi } from "vitest";
import { selectServices, isFork, assertForkEnv, assertAnvil, createForkServices } from "@/server/services";
import { findOwnedSafes } from "@/server/safes";

const SAFE = "0x1111111111111111111111111111111111111111";
const base = { FORK: "1", RPC_URL_8453: "http://127.0.0.1:8545", NODE_ENV: "development" };

describe("fork mode service selection", () => {
  it("FORK=1 picks the fork services: real reader and chain deps, fake Safe service seeded from FORK_SAFES", async () => {
    const env = { ...base, FORK_SAFES: JSON.stringify([{ address: SAFE, owners: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"], threshold: 1 }]) };
    expect(isFork(env)).toBe(true);
    const s = selectServices(env);
    expect(s.mock).toBe(false);
    expect(s.fork).toBe(true);
    expect(s.fixture).toBeUndefined();
    expect(s.fakes?.get(8453)).toBeDefined();
    expect((await s.safeService(8453).getSafe(SAFE))?.threshold).toBe(1);
    expect(s.lenders).toBeDefined();
  });

  it("MOCK=1 still picks the mock world and no env picks real services", () => {
    expect(selectServices({ MOCK: "1" }).mock).toBe(true);
    vi.stubEnv("DEV_PROPOSER_KEY", "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const real = selectServices({});
    vi.unstubAllEnvs();
    expect(real.mock).toBe(false);
    expect(real.fork).toBeUndefined();
    expect(real.fakes).toBeUndefined();
  });

  it.each(["http://example.com:8545", "https://mainnet.base.org", "http://127.0.0.1.evil.com:8545", "http://127.0.0.1:8545,https://mainnet.base.org", ""])("refuses a non-localhost RPC (%s)", (rpc) => {
    expect(() => selectServices({ ...base, RPC_URL_8453: rpc })).toThrow(/localhost/i);
  });

  it("accepts localhost spellings", () => {
    for (const u of ["http://localhost:8545", "http://127.0.0.1:9999", "http://[::1]:8545"]) expect(() => assertForkEnv({ ...base, RPC_URL_8453: u })).not.toThrow();
  });

  it("refuses production", () => {
    expect(() => selectServices({ ...base, NODE_ENV: "production" })).toThrow(/production/i);
  });

  it("FORK=1 with MOCK=1 is an error, not a silent mock", () => {
    expect(() => isFork({ ...base, MOCK: "1" })).toThrow(/FORK=1 and MOCK=1/);
    expect(() => selectServices({ ...base, MOCK: "1" })).toThrow(/FORK=1 and MOCK=1/);
    expect(isFork({ ...base, MOCK: "" })).toBe(true);
  });
});

const rpc = (result: unknown) => (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))) as unknown as typeof fetch;

describe("fork endpoint must be anvil", () => {
  it("accepts anvil and refuses another node", async () => {
    await expect(assertAnvil(base, rpc("anvil/v1.9.0"))).resolves.toBeUndefined();
    await expect(assertAnvil(base, rpc("Geth/v1.13"))).rejects.toThrow(/anvil/);
    await expect(assertAnvil(base, rpc(undefined))).rejects.toThrow(/anvil/);
  });
  it("the fork services refuse to open the database on a non-anvil node", async () => {
    await expect(createForkServices(base, { fetch: rpc("reth/v1") }).db()).rejects.toThrow(/anvil/);
  });
});

describe("owned-Safe discovery in fork mode", () => {
  const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  it("returns the seeded Base Safes and never asks for Arbitrum", async () => {
    const env = { ...base, FORK_SAFES: JSON.stringify([{ address: SAFE, owners: [ME], threshold: 1 }]) };
    const fork = createForkServices(env);
    const services = { ...fork, reader: { ...fork.reader, readSafeOwners: async () => [ME], readSafeThreshold: async () => 1, readBalances: async () => ({ balances: [] }), readPrices: async () => ({ prices: {} }) } } as unknown as typeof fork;
    const found = await findOwnedSafes(services, ME as `0x${string}`, { ens: async () => new Map() });
    expect(found.map((f) => f.address.toLowerCase())).toEqual([SAFE]);
    expect(found[0]!.chainIds).toEqual([8453]);
  });
});
