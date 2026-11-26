// Pinned Safe 1.4.1 contract addresses (M0-5). Identical on every supported chain.
// Verified to have code on the Base fork in tests/integration/safe-fork.test.ts.
import type { Address } from "@/shared/types";

export const SAFE_VERSION = "1.4.1" as const;
export const SAFE_L2_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
export const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
export const COMPATIBILITY_FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
export const MULTISEND_CALL_ONLY: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

/** Canonical Safe singletons a verified Safe proxy may delegate to: 1.4.1 (L2 and L1) and the audited 1.x versions. Same addresses on every chain Safe supports. */
export const CANONICAL_SAFE_SINGLETONS: readonly Address[] = [
  SAFE_L2_SINGLETON, // 1.4.1 SafeL2 (the version the app deploys)
  "0x41675C099F32341bf84BFc5382aF534df5C7461a", // 1.4.1 Safe
  "0x3E5c63644E683549055b9Be8653de26E0B4CD36E", // 1.3.0 GnosisSafeL2
  "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552", // 1.3.0 GnosisSafe
  "0x6851D6fDFAfD08c0295C392436245E5bc78B0185", // 1.2.0 GnosisSafe
  "0x34CfAC646f301356fAa8B21e94227e3583Fe7F5F", // 1.1.1 GnosisSafe
];

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Transaction Service EIP-712 domain name and version (delegates and DeleteRequest). */
export const TX_SERVICE_DOMAIN = { name: "Safe Transaction Service", version: "1.0" } as const;
