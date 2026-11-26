import { describe, expect, it } from "vitest";
import { onboardingBar, segmentState } from "./step-bar";

describe("segmentState", () => {
  it("marks done, current and todo", () => {
    expect(segmentState(0, 1, false)).toBe("done");
    expect(segmentState(1, 1, false)).toBe("current");
    expect(segmentState(2, 1, false)).toBe("todo");
    expect(segmentState(1, 1, true)).toBe("done");
  });
});

describe("onboardingBar", () => {
  it("has no bar on Connect", () => expect(onboardingBar({ screen: "connect", path: "create", createStep: 0 })).toBeNull());
  it("create path", () => {
    expect(onboardingBar({ screen: "safe", path: "create", createStep: 0 })).toEqual({ labels: ["Name", "Approvals", "Review", "Agent"], step: 0, complete: false });
    expect(onboardingBar({ screen: "safe", path: "create", createStep: 2 })?.step).toBe(2);
    expect(onboardingBar({ screen: "agent", path: "create", createStep: 2 })).toMatchObject({ step: 3, complete: false });
  });
  it("found path", () => {
    expect(onboardingBar({ screen: "safe", path: "found", createStep: 0 })).toEqual({ labels: ["Safe", "Agent"], step: 0, complete: false });
    expect(onboardingBar({ screen: "agent", path: "found", createStep: 0 })?.step).toBe(1);
  });
  it("is complete on done", () => {
    expect(onboardingBar({ screen: "done", path: "create", createStep: 2 })?.complete).toBe(true);
    expect(onboardingBar({ screen: "done", path: "found", createStep: 0 })?.complete).toBe(true);
  });
});
