// Lender adapters (BP-32): one shape for every offered lender, and the market allowlist.
import { aaveAdapter } from "./aave";
import { compoundAdapter } from "./compound";
import { morphoAdapter } from "./morpho";
import type { LenderAdapter, LenderId } from "./types";

export const ADAPTERS: Record<LenderId, LenderAdapter> = { "aave-v3": aaveAdapter, "compound-v3": compoundAdapter, "morpho-blue": morphoAdapter };
export const adapterFor = (id: LenderId): LenderAdapter => ADAPTERS[id];

export * from "./types";
export * from "./allowlist";
export * from "./abis";
export { canOpen, planAvailable, type Feasibility } from "./common";
