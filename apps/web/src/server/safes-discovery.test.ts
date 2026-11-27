import { describe, expect, it } from "vitest";
import type { Address } from "@/shared/types";
import type { Services } from "@/server/services";
import { findOwnedSafes, findOwnedSafesOnChain } from "./safes";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const ME = "0x00000000000000000000000000000000000000a1" as Address;
const CO = "0x00000000000000000000000000000000000000b2" as Address;

const services = (over: Record<string, unknown> = {}, on: number[] = [8453]) => ({
  safeService: (c: number) => ({ getSafesByOwner: async () => (on.includes(c) ? [SAFE] : []) }),
  reader: {
    readSafeOwners: async (c: number) => (on.includes(c) ? [ME, CO] : null),
    readSafeThreshold: async (c: number) => (on.includes(c) ? 2 : null),
    readBalances: async () => ({ balances: [{ symbol: "ETH", amount: 2, token: null, decimals: 18, raw: 0n }, { symbol: "USDC", amount: 500, token: null, decimals: 6, raw: 0n }] }),
    readPrices: async () => ({ prices: { ETH: 2000, USDC: 1, DAI: 1 } }),
    ...over,
  },
}) as unknown as Services;

describe("findOwnedSafesOnChain", () => {
  it("returns one network's verified slice: Service candidates confirmed on-chain, with value and owner names", async () => {
    const slices = await findOwnedSafesOnChain(services(), 8453, ME, { ens: async () => new Map([[CO.toLowerCase(), "bob.eth"]]) });
    expect(slices).toEqual([
      {
        address: SAFE,
        chainId: 8453,
        threshold: 2,
        ownerCount: 2,
        owners: [{ address: ME }, { address: CO, ens: "bob.eth" }],
        balanceUsd: 4500,
        assets: [
          { symbol: "ETH", amount: 2 },
          { symbol: "USDC", amount: 500 },
        ],
      },
    ]);
  });

  it("finds nothing on a network where the wallet is not an on-chain owner", async () => {
    const svc = services({ readSafeOwners: async () => [CO] }, [8453]);
    expect(await findOwnedSafesOnChain(svc, 8453, ME, { ens: async () => new Map() })).toEqual([]);
  });

  it("never asks the Safe service about a non-Base network on the fork", async () => {
    const svc = services() as Services & { fork?: boolean };
    svc.fork = true;
    let asked = false;
    svc.safeService = (() => { asked = true; throw new Error("no such chain"); }) as Services["safeService"];
    expect(await findOwnedSafesOnChain(svc, 42161, ME, { ens: async () => new Map() })).toEqual([]);
    expect(asked).toBe(false);
  });

  it("still asks Base on the fork", async () => {
    const svc = services() as Services & { fork?: boolean };
    svc.fork = true;
    expect(await findOwnedSafesOnChain(svc, 8453, ME, { ens: async () => new Map() })).toHaveLength(1);
  });
});

describe("findOwnedSafes (aggregate, unchanged)", () => {
  it("still merges every network's verified slice into one row per Safe", async () => {
    const found = await findOwnedSafes(services({}, [8453, 42161]), ME, { ens: async () => new Map() });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ chainIds: [8453, 42161], balanceChainIds: [8453, 42161], balanceUsd: 9000 });
  });
});
