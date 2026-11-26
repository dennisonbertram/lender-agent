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
});
