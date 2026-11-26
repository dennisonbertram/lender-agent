// What the executor (BP-41..43) needs about one linked Reserve. Built from the canonical `reserve_links` row
// (BP-39) by `loadReserveLink`; nothing here is stored twice. Limit, role and scope are read from the chain.
import type { Address, ChainId, Hex } from "@/shared/types";

export type ExecLink = {
  safeId: number;
  chainId: ChainId;
  /** The loan owner's Safe: `onBehalfOf` of every repay. */
  mainSafe: Address;
  /** The Reserve Safe: holds the stablecoin and the Roles modifier. */
  reserveSafe: Address;
  /** The Roles v2 modifier proxy enabled on the Reserve Safe. */
  roles: Address;
  /** The executor key's address (never the proposer key). */
  executor: Address;
  /** The loan's stablecoin the reserve holds and uses (D-01). */
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  /** The trigger: act when health is below this (D-02: enforced by software, not the chain). */
  trigger: number;
  /** The link generation from `reserve_links.attempt`: re-linking bumps it, so a request claimed under one generation can never spend under another (BP-52). */
  attempt: number;
  /** The server flag (`reserve_links.state` is not "off"). Off means the executor never calls, whatever the chain still allows. */
  active: boolean;
  /** Block at link time: where logs of the modifier start. */
  fromBlock: bigint;
};
