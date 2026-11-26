// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LoanCharts } from "./charts";

afterEach(cleanup);
const base = { loan: { collAsset: "ETH" as const, debt: 2000 }, hf: 2.4, t: { warn: 1.6, act: 1.35 }, price: 3000 };

describe("LoanCharts", () => {
  it("hides the 30-day history until it has two points, and keeps If ETH falls", () => {
    render(<LoanCharts {...base} history={[{ day: -0.5, hf: 2.4 }]} />);
    expect(screen.queryByText("Health factor · 30 days")).toBeNull();
    expect(screen.getByText("If ETH falls")).toBeTruthy();
  });
  it("puts If ETH falls before the history once there are two points", () => {
    render(<LoanCharts {...base} history={[{ day: -2, hf: 2.2 }, { day: -1, hf: 2.4 }]} />);
    const titles = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(titles.indexOf("If ETH falls")).toBeLessThan(titles.indexOf("Health factor · 30 days"));
  });
});
