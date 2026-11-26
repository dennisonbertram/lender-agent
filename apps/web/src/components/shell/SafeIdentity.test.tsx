// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Safe } from "@/lib/types";
import { MinimalTopBar } from "./MinimalTopBar";
import { SafeIdentity } from "./Sidebar";

afterEach(cleanup);
const A = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe0001";
const safe: Safe = { id: A, name: "Ops", address: A, threshold: "", agent: true, networks: [], balances: {} };

describe("SafeIdentity", () => {
  it("shows the network chip, the checksummed short address, copy and explorer link", () => {
    render(<SafeIdentity safe={safe} chainId={84532} />);
    expect(screen.getByText("Base Sepolia")).toBeTruthy();
    expect(screen.getByTitle(/^0x5[aA][fF][eE]/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /View on Basescan/ })).toBeTruthy();
  });
  it("shows the address without links when the chain is unknown", () => {
    render(<SafeIdentity safe={safe} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
  });
  it("shows every deployed Safe network, including supported networks without lending", () => {
    const allNetworks: Safe = { ...safe, networks: ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"].map((id) => ({ id: id as Safe["networks"][number]["id"], deployed: true, agent: false })) };
    const { container } = render(<SafeIdentity safe={allNetworks} />);
    for (const [name, mark] of [["Ethereum", "ethereum"], ["Base", "base"], ["Arbitrum", "arbitrum-one"], ["Optimism", "optimism"], ["Polygon", "polygon"], ["Gnosis", "gnosis"]]) {
      expect(screen.getByText(name)).toBeTruthy();
      expect(container.querySelector(`img[src="/network-marks/${mark}.svg"]`)).toBeTruthy();
    }
  });
});

describe("MinimalTopBar", () => {
  it("keeps the Safe address, Pick another Safe and Sign out around loading and error", () => {
    const out = vi.fn();
    render(<MinimalTopBar address={A} onSignOut={out} />);
    expect(screen.getByRole("link", { name: "Pick another Safe" }).getAttribute("href")).toBe("/onboarding");
    screen.getByRole("button", { name: "Sign out" }).click();
    expect(out).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
  });
});
