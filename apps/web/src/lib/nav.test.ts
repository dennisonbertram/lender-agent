import { describe, expect, it } from "vitest";
import { nextViewOnSwitch } from "./nav";

describe("nextViewOnSwitch", () => {
  it.each(["activity", "offers", "settings", "reserve", "cash", "home", "chat"] as const)("goes to the chat from %s", (name) => {
    expect(nextViewOnSwitch({ name })).toEqual({ name: "chat" });
  });
  it("goes to the chat from a loan", () => {
    expect(nextViewOnSwitch({ name: "loan", id: "aave" })).toEqual({ name: "chat" });
  });
  it("does not leave onboarding", () => {
    expect(nextViewOnSwitch({ name: "onboarding" })).toEqual({ name: "onboarding" });
  });
});
