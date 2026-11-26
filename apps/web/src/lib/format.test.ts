import { expect, it } from "vitest";
import { fmt, usd } from "./format";

it("keeps significant digits for a small non-zero amount", () => {
  expect(fmt(0.0015, 2)).toBe("0.0015");
  expect(fmt(0.00004, 2)).toBe("0.00004");
  expect(fmt(0, 2)).toBe("0.00");
});
it("leaves ordinary amounts as they were", () => {
  expect(fmt(1.5, 2)).toBe("1.50");
  expect(fmt(0.25, 2)).toBe("0.25");
  expect(fmt(12345.678, 2)).toBe("12,345.68");
  expect(fmt(3000)).toBe("3,000");
  expect(fmt(0.4)).toBe("0");
});
it("shows up to 4 significant digits below 1, trimmed", () => {
  expect(fmt(0.005, 2)).toBe("0.005");
  expect(fmt(0.0149, 2)).toBe("0.0149");
  expect(fmt(0.1234, 2)).toBe("0.1234");
  expect(fmt(0.123456, 2)).toBe("0.1235");
  expect(fmt(0.5, 2)).toBe("0.5");
  expect(fmt(-0.005, 2)).toBe("-0.005");
  expect(fmt(1, 2)).toBe("1.00");
});
it("dollars keep their decimals", () => {
  expect(usd(0.4)).toBe("$0");
  expect(usd(0.5, 2)).toBe("$0.50");
  expect(usd(1234.5, 2)).toBe("$1,234.50");
});
