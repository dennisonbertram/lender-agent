import { describe, expect, it } from "vitest";
import { deriveSaltNonce, newSafeSetup, predictSafeAddress, setupCalldata } from "./setup";

// M0-5: owners 0x1111.., 0x2222.., threshold 2, creator 0x3333.., index 0 -> 0x60157EE8...50aA
describe("setup", () => {
  const owners = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"] as const;
  const saltNonce = deriveSaltNonce("0x3333333333333333333333333333333333333333", 0);
  const setup = newSafeSetup({ owners: [...owners], threshold: 2, saltNonce });

  it("reproduces the M0-5 spike address", () => {
    expect(predictSafeAddress(setup)).toBe("0x60157EE8eA450d606F969acb7043DC2Fd6Aa50aA");
  });
  it("uses only the stored setup: other owners give another address", () => {
    expect(predictSafeAddress({ ...setup, owners: [owners[1], owners[0]] })).not.toBe(predictSafeAddress(setup));
    expect(setupCalldata(setup)).toMatch(/^0xb63e800d/);
  });
});
