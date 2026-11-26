import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_FORK_BLOCK, startBaseFork, type Fork } from "./anvil";

describe("Base fork helper", () => {
  let fork: Fork;
  beforeAll(async () => { fork = await startBaseFork(); });
  afterAll(async () => { await fork?.stop(); });

  it("forks Base at the pinned block with chain id 8453", async () => {
    expect(await fork.publicClient.getChainId()).toBe(8453);
    expect(await fork.publicClient.getBlockNumber()).toBe(BASE_FORK_BLOCK);
  });
});
