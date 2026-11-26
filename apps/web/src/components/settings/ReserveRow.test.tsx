// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Safe } from "@/lib/types";
import { ShellProvider, type ShellLoan, type ShellReserve } from "@/components/shell/ShellContext";
import { ReserveRow } from "./ReserveRow";

afterEach(cleanup);
const safe: Safe = { id: "s1", name: "Treasury", address: "0xabc", threshold: "2/3", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} };
const loan = (venue: string): ShellLoan => ({ id: "l1", safeId: "s1", network: "base", venue, collAsset: "ETH", collAmount: 2, debtAsset: "USDC", debt: 3000, lt: 0.8, apr: 3.4, accrued: 0, hf: 1.5, status: "watch" });
const reserve: ShellReserve = { kind: "armed", label: "On", tone: "success", banner: "", balanceUsd: 10 };
const view = (loans: ShellLoan[], r: ShellReserve | null = null) => render(<ShellProvider safe={safe} safes={[safe]} loans={loans} agentOn watching reserve={r}><ReserveRow address="0xabc" /></ShellProvider>);

describe("Settings: Reserve row", () => {
  it("shows when the Reserve is not in the sidebar (no Aave loan, none linked), with a link to the page", () => {
    view([loan("Morpho Blue")]);
    expect(screen.getByText("Keeps a second Safe ready to repay your Aave loan. Works with Aave loans only.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Reserve" }).getAttribute("href")).toBe("/s/0xabc/reserve");
  });
  it("is absent when the sidebar already has the Reserve", () => {
    view([loan("Aave v3")]);
    expect(screen.queryByRole("link", { name: "Open Reserve" })).toBeNull();
    cleanup();
    view([], reserve);
    expect(screen.queryByRole("link", { name: "Open Reserve" })).toBeNull();
  });
});
