// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NetworkChip } from "@/components/common";

afterEach(cleanup);

describe("NetworkChip", () => {
  it("shows a local Base mark beside Base Sepolia's distinct name", () => {
    const { container } = render(<NetworkChip id={84532} />);
    expect(screen.getByText("Base Sepolia")).toBeTruthy();
    expect(container.querySelector('img[src="/network-marks/base.svg"][alt=""]')).toBeTruthy();
  });

  it("shows known supported network marks by id", () => {
    const { container } = render(<><NetworkChip id={1} /><NetworkChip id={10} /><NetworkChip id={100} /><NetworkChip id={137} /><NetworkChip id={42161} /></>);
    for (const mark of ["ethereum", "optimism", "gnosis", "polygon", "arbitrum-one"]) {
      expect(container.querySelector(`img[src="/network-marks/${mark}.svg"]`)).toBeTruthy();
    }
  });

  it("keeps an unsupported chain truthful without borrowing a supported logo", () => {
    const { container } = render(<NetworkChip id={99999} />);
    expect(screen.getByText("Chain 99999")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
