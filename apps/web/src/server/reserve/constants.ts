// Reserve Safe addresses and keys (architecture 8.4, spike M0-6). Roles v2 only; Roles v3 is not for production.
// Checked with eth_getCode on Base (8453) on 2026-11-14 against https://mainnet.base.org:
//   Roles v2 mastercopy 24,409 bytes, ModuleProxyFactory 2,046 bytes, MultiSendCallOnly 1.4.1 411 bytes,
//   Aave v3 Pool and USDC (native) present. Libraries Integrity 0x6a6Af4b1... and Packer 0x869718C9... present.
import { stringToHex, type Hex } from "viem";
import type { Address, ChainId } from "@/shared/types";
import { AAVE, MULTISEND_CALL_ONLY } from "@/server/chain/config";

export const ROLES_V2_MASTERCOPY: Address = "0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5";
export const MODULE_PROXY_FACTORY: Address = "0x000000000000aDdB49795b0f9bA5BC298cDda236";
export { MULTISEND_CALL_ONLY };

/** The one role the executor key is a member of. */
export const ROLE_KEY: Hex = stringToHex("reserve-executor", { size: 32 });
/** The one allowance key: USDC units the role may request in `repay` per period. */
export const ALLOWANCE_KEY: Hex = stringToHex("daily-repay", { size: 32 });
export const ALLOWANCE_PERIOD_SEC = 86_400;

/** Networks where the Reserve is offered in this build (D-16: Base first). */
export const RESERVE_CHAINS: readonly ChainId[] = [8453];

/** What a Reserve on a network may touch: the Aave v3 Pool, repaying this stablecoin. */
export const RESERVE_ASSET: Partial<Record<ChainId, { pool: Address; usdc: Address; decimals: 6; symbol: "USDC" }>> = {
  8453: { pool: AAVE[8453]!.pool as Address, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
};

/** Aave v3 `repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf)`. */
export const REPAY_SELECTOR: Hex = "0x573ade81";
export const VARIABLE_RATE_MODE = 2n;
