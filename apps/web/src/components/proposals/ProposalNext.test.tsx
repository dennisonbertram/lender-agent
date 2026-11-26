// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProposalView } from "@/server/proposals/view";

const state: { proposal?: Partial<ProposalView>; loans: { id: string }[] } = { loans: [] };
vi.mock("@/client/proposals", () => ({ useProposal: () => ({ data: state.proposal }) }));
vi.mock("@/client/loans", () => ({ useLoans: () => ({ data: { loans: state.loans } }) }));
import { ProposalNext } from "./ProposalNext";

afterEach(cleanup);
const A = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";
const LOAN = `8453:${A.toLowerCase()}:morpho-blue`;
const show = (p: Partial<ProposalView>, loans: { id: string }[] = []) => {
  state.proposal = p; state.loans = loans;
  render(<QueryClientProvider client={new QueryClient()}><ProposalNext safeAddress={A} id="p1" /></QueryClientProvider>);
};

describe("ProposalNext", () => {
  it("executed: nothing here, the card carries View loan", () => {
    show({ stage: "executed", specKind: "open", loanId: LOAN }, [{ id: LOAN }]);
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("replaced: See the new proposal", () => {
    show({ stage: "replaced", replacedBy: "p9", specKind: "open" });
    expect(screen.getByRole("link", { name: "See the new proposal" }).getAttribute("href")).toBe(`/s/${A}/proposals/p9`);
  });
  it("failed open: Plan again", () => {
    show({ stage: "failed", specKind: "open" });
    expect(screen.getByRole("link", { name: "Plan again" }).getAttribute("href")).toBe(`/s/${A}/get-cash`);
  });
  it("stopped protect with the loan listed: Back to the loan; reserve: Back to Reserve", () => {
    show({ stage: "rejected", specKind: "protect", loanId: LOAN }, [{ id: LOAN }]);
    expect(screen.getByRole("link", { name: "Back to the loan" })).toBeTruthy();
    cleanup();
    show({ stage: "stopped", specKind: "reserve-off" });
    expect(screen.getByRole("link", { name: "Back to Reserve" }).getAttribute("href")).toBe(`/s/${A}/reserve`);
  });
  it("queued: nothing", () => {
    show({ stage: "queued", specKind: "open" });
    expect(screen.queryByRole("link")).toBeNull();
  });
});
