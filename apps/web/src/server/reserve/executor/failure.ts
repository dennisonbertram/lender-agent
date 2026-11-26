// Name a Roles v2 revert (NoMembership, ConditionViolation(AllowanceExceeded), ...) from a viem error, using the canonical ABI.
import { decodeErrorResult, type Hex } from "viem";
import { rolesAbi } from "../roles-abi";

const STATUS = ["Ok", "DelegateCallNotAllowed", "TargetAddressNotAllowed", "FunctionNotAllowed", "SendNotAllowed", "OrViolation", "NorViolation", "ParameterNotAllowed", "ParameterLessThanAllowed", "ParameterGreaterThanAllowed", "ParameterNotAMatch", "NotEveryArrayElementPasses", "NoArrayElementPasses", "ParameterNotSubsetOfAllowed", "BitmaskOverflow", "BitmaskNotAllowed", "CustomConditionViolation", "AllowanceExceeded", "CallAllowanceExceeded", "EtherAllowanceExceeded"];

export type RolesFailure = { name: string; detail: string | null; message: string };

/** Find revert data anywhere in a viem error and name the Roles error. Unknown errors keep their message. */
export function decodeRolesFailure(e: unknown): RolesFailure {
  const seen = new Set<unknown>();
  let data: Hex | null = null;
  let message = e instanceof Error ? e.message : String(e);
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && !seen.has(cur) && i < 8; i++) {
    seen.add(cur);
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) { data = d as Hex; break; }
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") { data = (d as { data: Hex }).data; break; }
    cur = (cur as { cause?: unknown }).cause;
  }
  data ??= (message.match(/0x[0-9a-fA-F]{8,}/)?.[0] as Hex | undefined) ?? null;
  if (data) {
    try {
      const r = decodeErrorResult({ abi: rolesAbi, data });
      if (r.errorName === "ConditionViolation") {
        const status = STATUS[Number((r.args as readonly [number, Hex])[0])] ?? "Unknown";
        return { name: "ConditionViolation", detail: status, message: `ConditionViolation(${status})` };
      }
      return { name: r.errorName, detail: null, message: r.errorName };
    } catch { /* not a Roles error */ }
  }
  return { name: "Unknown", detail: null, message: message.split("\n")[0]!.slice(0, 300) };
}
