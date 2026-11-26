import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import type { Address } from "@/shared/types";
import { MANY_ROLES_ISSUE, readReserveChain } from "./read";

const RESERVE = "0x00000000000000000000000000000000000000a1" as Address;
const ROLES = "0x00000000000000000000000000000000000000b1" as Address;
const OLD = "0x00000000000000000000000000000000000000b2" as Address;
const OTHER = "0x00000000000000000000000000000000000000c3" as Address;
const MAIN = "0x00000000000000000000000000000000000000d1" as Address;
const EXEC = "0x00000000000000000000000000000000000000e1" as Address;

const clientWith = (modules: Address[], codes: Record<string, string>) => ({
  getBlock: async () => ({ number: 10n, timestamp: 1000n }),
  getCode: async ({ address }: { address: string }) => codes[address.toLowerCase()] ?? "0x",
  getLogs: async () => [],
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "getModulesPaginated") return [modules, "0x0000000000000000000000000000000000000001"];
    if (functionName === "isModuleEnabled") return true;
    if (functionName === "allowances") return [1n, 1n, 86_400n, 1n, 1n];
    return 0n;
  },
}) as unknown as PublicClient;

const read = (c: PublicClient) => readReserveChain(c, { chainId: 8453, reserve: RESERVE, roles: ROLES, mainSafe: MAIN, executor: EXEC, fromBlock: 1n });
const proxy = "0x363d3d373d3d3d363d73aa";

describe("readReserveChain: more than one Roles module", () => {
  it("reports a second enabled Roles proxy as an issue", async () => {
    const s = await read(clientWith([OLD, ROLES], { [ROLES.toLowerCase()]: proxy, [OLD.toLowerCase()]: proxy }));
    expect(s!.issues).toContain(MANY_ROLES_ISSUE);
  });
  it("ignores other kinds of modules and a single Roles module", async () => {
    const s = await read(clientWith([OTHER, ROLES], { [ROLES.toLowerCase()]: proxy, [OTHER.toLowerCase()]: "0x6080" }));
    expect(s!.issues).not.toContain(MANY_ROLES_ISSUE);
  });
});
