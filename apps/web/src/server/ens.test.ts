import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnsResolver, DEFAULT_ENS_RPC, ensRpcUrl } from "./ens";

const A = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0001";
const B = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002";

describe("createEnsResolver", () => {
  it("resolves names by lowercase address and skips owners without one", async () => {
    const r = createEnsResolver(async (a) => (a === A.toLowerCase() ? "alice.eth" : null));
    expect(await r([A, B])).toEqual(new Map([[A.toLowerCase(), "alice.eth"]]));
  });
  it("serves the second call from the cache until the TTL passes", async () => {
    const lookup = vi.fn(async () => "alice.eth");
    let t = 0;
    const r = createEnsResolver(lookup, { ttlMs: 1000, now: () => t });
    await r([A]); await r([A]);
    expect(lookup).toHaveBeenCalledTimes(1);
    t = 1001;
    await r([A]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it("falls back to no name on a timeout and on an error, without throwing", async () => {
    const r = createEnsResolver((a) => (a === A.toLowerCase() ? new Promise(() => {}) : Promise.reject(new Error("rpc down"))), { timeoutMs: 20 });
    expect((await r([A, B])).size).toBe(0);
  });
  it("does not cache failures", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("alice.eth");
    const r = createEnsResolver(lookup);
    expect((await r([A])).size).toBe(0);
    expect((await r([A])).get(A.toLowerCase())).toBe("alice.eth");
  });
});

describe("ensRpcUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes only the first URL of a comma-separated RPC_URL_1", () => {
    vi.stubEnv("RPC_URL_1", "https://a.example/key1, https://b.example/key2");
    // The second provider must never end up inside the first provider's URL path.
    expect(ensRpcUrl()).toBe("https://a.example/key1");
  });

  it("uses the public default when RPC_URL_1 is blank", () => {
    vi.stubEnv("RPC_URL_1", " , ");
    expect(ensRpcUrl()).toBe(DEFAULT_ENS_RPC);
  });
});
