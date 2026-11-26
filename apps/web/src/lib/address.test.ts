import { expect, it } from "vitest";
import { safeLabel, shortAddress, validateAddress } from "./address";

const ok = "0x4a1c6b7e0d2f93a58c1b4e7d90a3f6c2b85e9e2f";

it("validates addresses", () => {
  expect(validateAddress(ok)).toBeNull();
  const bad = "This is not a valid address. Addresses start with 0x and are 42 characters long.";
  expect(validateAddress("")).toBe("Enter an address.");
  expect(validateAddress("hello")).toBe(bad);
  expect(validateAddress(ok.slice(0, -1))).toBe(bad); // wrong length
  expect(validateAddress(ok.slice(2))).toBe(bad); // missing 0x
  expect(validateAddress("0x" + "g".repeat(40))).toBe(bad); // non-hex
  expect(validateAddress(ok.toUpperCase().replace("0X", "0x"), [ok])).toBe("You already added this Safe.");
});

it("labels a Safe by name, or by its short address when unnamed", () => {
  expect(safeLabel({ name: "", address: ok })).toBe(shortAddress(ok));
  expect(safeLabel({ name: null, address: ok })).toBe(shortAddress(ok));
  expect(safeLabel({ name: "Ops", address: ok })).toBe("Ops");
});

it("shortens a checksummed address", () => {
  expect(shortAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe("0xd8dA…6045");
});
