// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StepBar } from "@/components/common";

afterEach(cleanup);

describe("onboarding progress", () => {
  it("names the journey and exposes the current action while marking completed actions", () => {
    render(<StepBar labels={["Choose Safe", "Add agent"]} step={1} />);
    expect(screen.getByRole("navigation", { name: "Onboarding progress" })).toBeTruthy();
    expect(screen.getByText("Choose Safe").getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("2 Add agent").getAttribute("aria-current")).toBe("step");
  });

  it("renders the compact picker progress with readable labels and step state", () => {
    render(<StepBar labels={["Name Safe", "Set approvals", "Review setup", "Add agent"]} step={1} variant="picker" />);
    const navigation = screen.getByRole("navigation", { name: "Onboarding progress" });
    expect(navigation.querySelectorAll("ol > li")).toHaveLength(4);
    expect(screen.getByText("Name Safe")).toBeTruthy();
    expect(screen.getByText("Set approvals").getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Review setup")).toBeTruthy();
  });
});
