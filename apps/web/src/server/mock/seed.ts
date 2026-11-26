// `MOCK=1` world: who owns what, for local dev and E2E. Only anvil's well-known keys appear here.
import type { Address, Hex } from "@/shared/types";
import type { FixtureReader } from "@/server/chain/fixture";
import type { FakeSafeService } from "@/server/safe/fake-service";

/** anvil key 1: the dev wallet (`NEXT_PUBLIC_MOCK_WALLET=1`). */
export const MOCK_OWNER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const MOCK_OWNER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/** anvil key 2: the co-signer. */
export const MOCK_COSIGNER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const MOCK_COSIGNER_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
/** anvil key 3: owns nothing. */
export const MOCK_STRANGER: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
export const MOCK_STRANGER_KEY: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
/** anvil key 5: the agent's proposer key in mock mode. */
export const MOCK_AGENT_KEY: Hex = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

/** 2-of-2 Safe with ETH: owner + co-signer. */
export const MOCK_SAFE: Address = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";
/** 1-of-1 Safe with nothing in it: the empty state. */
export const MOCK_EMPTY_SAFE: Address = "0x5afE5AFe5afE5AfE5afe5Afe5AfE5aFe5afE0002";

export function seedMockWorld(reader: FixtureReader, fake: FakeSafeService) {
  reader.setOwners(8453, MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  reader.setBalances(8453, MOCK_SAFE, { ETH: 2.5, wstETH: 0, USDC: 0 });
  fake.setOwners(MOCK_SAFE, [MOCK_OWNER, MOCK_COSIGNER], 2);
  reader.setOwners(8453, MOCK_EMPTY_SAFE, [MOCK_OWNER], 1);
  reader.setBalances(8453, MOCK_EMPTY_SAFE, { ETH: 0, wstETH: 0, USDC: 0 });
  fake.setOwners(MOCK_EMPTY_SAFE, [MOCK_OWNER], 1);
}
