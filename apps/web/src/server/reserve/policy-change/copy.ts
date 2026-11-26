// Words for turning the reserve off and changing its policy (BP-43). Off takes effect in the app first and on-chain
// only when the Reserve Safe's owners sign, so the page says which of the two is true now.
export const OFF_NOW = "The agent has stopped using the reserve.";
export const PERMISSION_STILL_ACTIVE = "The permission on-chain is still active until the Reserve Safe signs the removal.";
export const SIGN_TO_REMOVE = "Sign in Safe to remove the permission";
export const PERMISSION_REMOVED = "The permission on-chain is removed.";
export const SIGN_TO_TURN_OFF = "Sign to turn off";
export const SIGN_TO_CHANGE = "Sign to change the policy";

export type PermissionState = {
  /** What the app does now. */
  agent: "using" | "stopped";
  /** What the chain allows now. */
  chain: "active" | "removed";
  /** The sentence the page shows; null when nothing needs saying (on and active). */
  notice: string | null;
};

export const permissionNotice = (agent: PermissionState["agent"], chain: PermissionState["chain"]): string | null =>
  agent === "stopped" ? `${OFF_NOW} ${chain === "active" ? PERMISSION_STILL_ACTIVE : PERMISSION_REMOVED}` : chain === "removed" ? "The permission on-chain was removed, so the agent cannot use the reserve." : null;

/** The agent is stopped (the flag is set) but the Safe transaction that removes its permission could not be prepared. */
export const OFF_BUT_NOT_SENT = "The agent has stopped using the reserve. We could not prepare the Safe transaction that removes its permission on-chain. Try again.";

export const OFF_REPAY_PENDING = "A reserve repayment is pending. Retry turning the reserve off after it settles. Contact support if it remains pending.";
