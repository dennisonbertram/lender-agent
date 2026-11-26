import { describe, expect, it } from "vitest";
import { policyErrors, reservePolicyCopy } from "./reserve-policy";

describe("reservePolicyCopy", () => {
  it("uses the live trigger, limit and Safe name", () => {
    expect(reservePolicyCopy({ emergencyHF: 1.1, dailyCapUsd: 15000 }, "Treasury Safe")).toEqual({
      can: ["Add collateral or repay debt on Treasury Safe loans", "Only when a loan is close to liquidation: health below 1.10 (1.00 is liquidation)", "Up to $15,000 per day"],
      cannot: ["Send money anywhere, even to Treasury Safe", "Borrow more", "Withdraw collateral from a loan"],
    });
    const c = reservePolicyCopy({ emergencyHF: 1.3, dailyCapUsd: 20000 }, "Treasury Safe");
    expect(c.can[1]).toContain("1.30");
    expect(c.can[2]).toContain("$20,000");
  });
});

describe("policyErrors", () => {
  it("blocks bad numbers and a limit under $1", () => {
    expect(policyErrors("0.5", "15000", 38725).hf).toBeTruthy();
    expect(policyErrors("2.5", "15000", 38725).hf).toBeTruthy();
    expect(policyErrors("", "15000", 38725).hf).toBeTruthy();
    expect(policyErrors("1.1", "", 38725).cap).toBeTruthy();
    expect(policyErrors("1.1", "-5", 38725).cap).toBeTruthy();
    const msg = "Enter at least $1. To stop the agent, turn off “Agent can use reserve”.";
    expect(policyErrors("1.1", "0", 38725).cap).toBe(msg);
    expect(policyErrors("1.1", "0.5", 38725).cap).toBe(msg);
    expect(policyErrors("1.10", "15000", 38725)).toEqual({});
  });
  it("checks the limit against the Reserve balance", () => {
    expect(policyErrors("1.1", "$40,000", 38725).cap).toBe("The Reserve Safe holds $38,725. The limit cannot be higher.");
    expect(policyErrors("1.1", "$15,000", 38725)).toEqual({});
    expect(policyErrors("1.1", "abc", 38725).cap).toBe("Use numbers only, for example $5,000.");
  });
});
