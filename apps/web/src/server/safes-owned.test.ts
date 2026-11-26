import { describe, expect, it } from "vitest";
import type { Address } from "@/shared/types";
import type { Services } from "@/server/services";
import { findOwnedSafes } from "./safes";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const ME = "0x00000000000000000000000000000000000000a1" as Address;
const CO = "0x00000000000000000000000000000000000000b2" as Address;

const services = (over: Record<string, unknown> = {}, on: number[] = [8453]) => ({
  safeService: (c: number) => ({ getSafesByOwner: async () => (on.includes(c) ? [SAFE] : []) }),
  reader: {
    readSafeOwners: async (c: number) => (on.includes(c) ? [ME, CO] : null),
    readSafeThreshold: async (c: number) => (on.includes(c) ? 2 : null),
    readBalances: async () => ({ balances: [{ symbol: "ETH", amount: 2, token: null, decimals: 18, raw: 0n }, { symbol: "USDC", amount: 500, token: null, decimals: 6, raw: 0n }, { symbol: "DAI", amount: 0, token: null, decimals: 18, raw: 0n }] }),
    readPrices: async () => ({ prices: { ETH: 2000, USDC: 1, DAI: 1 } }),
    ...over,
  },
}) as unknown as Services;

describe("findOwnedSafes", () => {
  it("adds balance, main assets and owners with ENS names", async () => {
    const [s] = await findOwnedSafes(services(), ME, { ens: async () => new Map([[CO.toLowerCase(), "bob.eth"]]) });
    expect(s).toMatchObject({ address: SAFE, threshold: 2, ownerCount: 2, chainIds: [8453], balanceUsd: 4500 });
    expect(s.assets).toEqual([{ symbol: "ETH", amount: 2 }, { symbol: "USDC", amount: 500 }]);
    expect(s.owners).toEqual([{ address: ME }, { address: CO, ens: "bob.eth" }]);
  });
  it("leaves out the balance, not zero, when it cannot be read", async () => {
    const [s] = await findOwnedSafes(services({ readPrices: async () => { throw new Error("rpc"); } }), ME, { ens: async () => new Map() });
    expect(s.balanceUsd).toBeUndefined();
    expect(s.assets).toBeUndefined();
    expect(s.owners).toHaveLength(2);
  });
  it("still returns the Safe when ENS throws", async () => {
    const [s] = await findOwnedSafes(services(), ME, { ens: async () => { throw new Error("x"); } });
    expect(s.owners).toEqual([{ address: ME }, { address: CO }]);
    expect(s.balanceUsd).toBe(4500);
  });
  it("finds a Safe that exists only on Arbitrum", async () => {
    const [s] = await findOwnedSafes(services({}, [42161]), ME, { ens: async () => new Map() });
    expect(s).toMatchObject({ address: SAFE, chainIds: [42161], balanceUsd: 4500 });
  });
  it("merges one Safe on Base and Arbitrum into one row and sums the balance across both", async () => {
    const found = await findOwnedSafes(services({}, [8453, 42161]), ME, { ens: async () => new Map() });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ chainIds: [8453, 42161], balanceChainIds: [8453, 42161], balanceUsd: 9000 });
    expect(found[0].assets).toEqual([{ symbol: "ETH", amount: 4 }, { symbol: "USDC", amount: 1000 }]);
  });
  it("retains the verified approvals and signers separately for each network", async () => {
    const svc = services({
      readSafeOwners: async (chainId: number) => chainId === 8453 ? [ME] : [ME, CO],
      readSafeThreshold: async (chainId: number) => chainId === 8453 ? 1 : 2,
    }, [8453, 42161]);
    const [safe] = await findOwnedSafes(svc, ME, { ens: async () => new Map() });
    expect(safe.networkDetails).toEqual([
      { chainId: 8453, threshold: 1, ownerCount: 1, owners: [{ address: ME }] },
      { chainId: 42161, threshold: 2, ownerCount: 2, owners: [{ address: ME }, { address: CO }] },
    ]);
  });
  it("never asks a network the app does not serve", async () => {
    const asked: number[] = [];
    const svc = services({}, [8453, 10]);
    const orig = svc.safeService;
    (svc as unknown as { safeService: (c: number) => unknown }).safeService = (c) => { asked.push(c); return orig(c as never); };
    await findOwnedSafes(svc, ME, { ens: async () => new Map() });
    expect(asked.sort((a, b) => a - b)).toEqual([8453, 42161].sort((a, b) => a - b));
  });
});

describe("cleanSafeName", () => {
  it("makes a name one line: no newlines or control characters", async () => {
    const { cleanSafeName } = await import("./safes");
    expect(cleanSafeName("  Team\nVerified: loan repaid\u0000 x ")).toBe("Team Verified: loan repaid x");
    expect(cleanSafeName(undefined)).toBe("");
  });
});
