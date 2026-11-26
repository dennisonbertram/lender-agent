import { describe, expect, it } from "vitest";
import { USER_FULL } from "@/data";
import { approvalsHelp, approvalsLabel, approvalsSummary, defaultApprovals, ownerErrors } from "./owners";

const c = "0x4a1c0000000000000000000000000000000e9e2f";
const upper = (a: string) => "0x" + a.slice(2).toUpperCase();
const OWN = "This is your address. Add someone else.";

describe("ownerErrors", () => {
  it("rejects the user's own address in any case", () => {
    for (const a of [USER_FULL.toLowerCase(), upper(USER_FULL), USER_FULL]) expect(ownerErrors([USER_FULL, a])[1]).toBe(OWN);
  });
  it("rejects case variants of another co-signer", () => {
    const e = ownerErrors([USER_FULL, c, upper(c)]);
    expect(e[0]).toBeNull();
    expect(e[1]).toBeNull();
    expect(e[2]).toBe("This owner is already listed.");
  });
  it("keeps the invalid-address message", () => expect(ownerErrors([USER_FULL, "0x12"])[1]).toMatch(/not a valid address/));
});

describe("approvals copy", () => {
  it("helps by k and n", () => {
    expect(approvalsHelp(1, 2)).toContain("thief");
    expect(approvalsHelp(2, 3)).toContain("does not lock you out");
    expect(approvalsHelp(2, 2)).toContain("nobody can move the money");
    expect(approvalsHelp(3, 3)).toContain("nobody can move the money");
  });
  it("labels options", () => {
    expect(approvalsLabel(1, 2)).toBe("Either of you (1 of 2)");
    expect(approvalsLabel(2, 2)).toBe("Both of you (2 of 2)");
    expect(approvalsLabel(2, 4)).toBe("2 of 4");
    expect(approvalsLabel(4, 4)).toBe("All 4 (4 of 4)");
    expect(approvalsLabel(1, 3)).toBe("Any one (1 of 3)");
  });
  it("summarises approvals in plain words", () => {
    expect(approvalsSummary(1, 1)).toBe("Only you approve transactions.");
    expect(approvalsSummary(1, 2)).toBe("Either of you can approve a transaction alone.");
    expect(approvalsSummary(2, 2)).toBe("Both of you must approve each transaction.");
    expect(approvalsSummary(1, 3)).toBe("Any one of the 3 owners can approve a transaction alone.");
    expect(approvalsSummary(3, 3)).toBe("All 3 owners must approve each transaction.");
    expect(approvalsSummary(2, 4)).toBe("2 of the 4 owners must approve each transaction.");
  });
  it("defaults", () => {
    expect([defaultApprovals(2), defaultApprovals(3), defaultApprovals(4)]).toEqual([1, 2, 2]);
  });
});
