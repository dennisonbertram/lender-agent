import { describe, expect, it } from "vitest";
import type { Address, ChainId } from "@/shared/types";
import { DISCOVERY_CHAIN_IDS, mergeOwnedSafeSlices, type OwnedSafeSlice } from "./owned-safes";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const ME = "0x00000000000000000000000000000000000000a1" as Address;
const CO = "0x00000000000000000000000000000000000000b2" as Address;

const slice = (chainId: ChainId, over: Partial<OwnedSafeSlice> = {}): OwnedSafeSlice => ({
  address: SAFE,
  chainId,
  threshold: 2,
  ownerCount: 2,
  owners: [{ address: ME }, { address: CO, ens: "bob.eth" }],
  balanceUsd: 4500,
  assets: [
    { symbol: "ETH", amount: 2 },
    { symbol: "USDC", amount: 500 },
  ],
  ...over,
});

describe("mergeOwnedSafeSlices", () => {
  it("merges slices in served-network order however they arrived", () => {
    for (const input of [[slice(8453), slice(42161)], [slice(42161), slice(8453)]]) {
      const [s] = mergeOwnedSafeSlices(input);
      expect(s).toMatchObject({ address: SAFE, threshold: 2, ownerCount: 2, chainIds: [8453, 42161], balanceUsd: 9000, balanceChainIds: [8453, 42161] });
      expect(s.networkDetails).toEqual([
        { chainId: 8453, threshold: 2, ownerCount: 2, owners: [{ address: ME }, { address: CO, ens: "bob.eth" }] },
        { chainId: 42161, threshold: 2, ownerCount: 2, owners: [{ address: ME }, { address: CO, ens: "bob.eth" }] },
      ]);
      expect(s.assets).toEqual([
        { symbol: "ETH", amount: 4 },
        { symbol: "USDC", amount: 1000 },
      ]);
    }
  });

  it("drops the total, never guesses it, when the balance could not be read on every found network", () => {
    const [s] = mergeOwnedSafeSlices([slice(8453, { balanceUsd: undefined, assets: undefined }), slice(42161)]);
    expect(s.balanceUsd).toBeUndefined();
    expect(s.assets).toBeUndefined();
    expect(s.balanceChainIds).toEqual([]);
  });

  it("keeps the first-in-served-order network's headline owners and threshold, and each network's own details", () => {
    const [s] = mergeOwnedSafeSlices([
      slice(8453, { threshold: 1, ownerCount: 1, owners: [{ address: ME }] }),
      slice(42161),
    ]);
    expect(s).toMatchObject({ threshold: 1, ownerCount: 1 });
    expect(s.owners).toEqual([{ address: ME }]);
    expect(s.networkDetails?.map((d) => d.chainId)).toEqual([8453, 42161]);
  });

  it("keeps separate Safes as separate rows", () => {
    const other = { ...slice(8453), address: "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0002" as Address };
    expect(mergeOwnedSafeSlices([slice(8453), other])).toHaveLength(2);
  });
});

describe("DISCOVERY_CHAIN_IDS", () => {
  it("is the served networks in their declared order", () => {
    expect(DISCOVERY_CHAIN_IDS).toEqual([8453, 42161]);
  });
});
