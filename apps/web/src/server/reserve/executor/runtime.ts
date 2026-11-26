// Who the executor talks to: the chain, its own signer, and the operator alert. Tests and MOCK replace them.
import type { Services } from "@/server/services";
import { createViemReserveChain, type ReserveChain } from "./chain";
import { createFixtureReserveChain } from "./fixture-chain";
import { getExecutorSigner, type ExecutorSigner } from "../signer";
import { ANVIL_DEV_KEYS } from "@/server/signer/dev";

export type ReserveRuntime = {
  chain: ReserveChain;
  signer: ExecutorSigner;
  /** Tell the operator (not the owners) that the executor failed. */
  operatorAlert: (message: string, detail?: unknown) => void;
};

/** Keep the runtime signer aligned with `executorFor()` and the mock Reserve setup. */
const MOCK_EXECUTOR_KEY = ANVIL_DEV_KEYS[2];

const g = globalThis as unknown as { __reserveRuntime?: Partial<ReserveRuntime>; __reserveMockChain?: ReserveChain; __reserveRealChain?: ReserveChain };

/** Tests only. */
export function setReserveRuntimeForTests(r: Partial<ReserveRuntime> | undefined) {
  g.__reserveRuntime = r;
}

export function mockReserveChain(services: Pick<Services, "fixture">): ReserveChain {
  g.__reserveMockChain ??= createFixtureReserveChain(services.fixture!);
  return g.__reserveMockChain;
}

export function resetMockReserveChain() {
  g.__reserveMockChain = undefined;
}

export function getReserveRuntime(services: Pick<Services, "mock" | "fixture">, log: (m: string, d?: unknown) => void): ReserveRuntime {
  const o = g.__reserveRuntime ?? {};
  const mock = services.mock && !!services.fixture;
  let signer = o.signer;
  return {
    chain: o.chain ?? (mock ? mockReserveChain(services) : (g.__reserveRealChain ??= createViemReserveChain())),
    // Relaying committed bytes needs no signing key.
    get signer() {
      return signer ??= mock
        ? getExecutorSigner({ EXECUTOR_SIGNER: "dev", DEV_EXECUTOR_KEY: process.env.DEV_EXECUTOR_KEY || MOCK_EXECUTOR_KEY, DEV_PROPOSER_KEY: process.env.DEV_PROPOSER_KEY || undefined })
        : getExecutorSigner();
    },
    operatorAlert: o.operatorAlert ?? ((m, d) => log(`OPERATOR ALERT: ${m}`, d)),
  };
}
