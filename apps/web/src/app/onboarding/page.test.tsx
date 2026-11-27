// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createProgressKey } from "@/lib/create-progress";
import { shortAddress } from "@/lib/address";
import type { ListedSafe } from "@/server/auth/access";
import OnboardingPage from "./page";

const W1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const W2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const SAFE_A = "0x60157EE8eA450d606F969acb7043DC2Fd6Aa50aA";
const TX = { to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", data: "0x1688f0b9" } as const;

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

let wallet = W1;
let sessionLoading = false;
vi.mock("@/client/auth/useSession", () => ({
  useSession: () => ({ session: sessionLoading ? null : { address: wallet }, loading: sessionLoading }),
  useSignOut: () => vi.fn(),
}));

let ownedData: object[] = [];
let ownedFetching = false;
let ownedStaleAddresses: string[] = [];
let ownedPendingAddresses: string[] = [];
let mineData: object[] | undefined = [];
let mineLoading = false;
let mineFetching = false;
let mineError: Error | null = null;
const refetch = vi.fn();
const ownedWalletArgs: (string | undefined)[] = [];
const mineWalletArgs: (string | undefined)[] = [];
vi.mock("@/client/safes", () => ({
  useOwnedSafes: (w?: string) => { ownedWalletArgs.push(w); return { data: ownedData, isLoading: false, isFetching: ownedFetching, pending: false, pendingAddresses: ownedPendingAddresses, staleAddresses: ownedStaleAddresses, freshnessByChainId: {}, error: null, refetch }; },
  useSafes: (w?: string) => { mineWalletArgs.push(w); return { data: mineData, isLoading: mineLoading, isFetching: mineLoading || mineFetching, isPending: mineData === undefined, error: mineError, refetch }; },
  useAddSafe: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

const api = {
  preview: vi.fn(),
  create: vi.fn(),
  setup: vi.fn(async (_a: string, id: number, hash?: string) =>
    hash ? { status: "ready" as const, indexed: true }
      : id === 8453 ? { status: "user_pays" as const, cost: "fee", tx: TX }
        : { status: "ready" as const, indexed: true }),
  payFee: vi.fn(),
  indexed: vi.fn(async () => true),
};
vi.mock("@/client/create-safe", () => ({ useCreateSafeApi: () => api }));

const pendingSafe: ListedSafe = {
  id: 1, address: SAFE_A, name: "Holiday", networks: [8453], ownedChainIds: [8453], ownersDiffer: false, agent: false,
  pendingSetup: true, createdChainIds: [8453, 100], recordedChainIds: [8453, 100, 42161], deployedChainIds: [8453],
};

beforeEach(() => { localStorage.clear(); wallet = W1; sessionLoading = false; mineLoading = false; mineFetching = false; mineError = null; ownedFetching = false; ownedStaleAddresses = []; ownedPendingAddresses = []; ownedWalletArgs.length = 0; mineWalletArgs.length = 0; });
afterEach(() => {
  cleanup();
  ownedData = [];
  mineData = [];
  push.mockClear();
  api.preview.mockClear();
  api.create.mockClear();
  api.payFee.mockClear();
  api.indexed.mockClear();
  api.setup.mockClear();
});

describe("onboarding page: a saved Safe whose setup stopped", () => {
  it("offers one setup recovery action instead of a second selectable row for a partly deployed Safe", () => {
    ownedData = [{ address: SAFE_A, threshold: 1, ownerCount: 1, chainIds: [8453], balanceUsd: 4500, balanceChainIds: [8453], networkDetails: [{ chainId: 8453, threshold: 1, ownerCount: 1, owners: [{ address: W1 }] }] }];
    mineData = [{ ...pendingSafe, verifiedChainIds: [8453, 42161] }];
    render(<OnboardingPage />);
    expect(screen.getAllByText("Holiday")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Finish setting up" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Address and signers on Base" }));
    expect(screen.getByText("Approvals on Base: Only you approve transactions.")).toBeTruthy();
    expect(screen.getByText("Verified ownership on").parentElement?.textContent?.replace(/\s+/g, " ").trim()).toBe("Verified ownership on Base and Arbitrum");
    expect(within(screen.getByRole("list", { name: "Your Safes" })).getByRole("listitem").textContent).toContain("$4,500");
    expect(screen.getByText("Supported balance")).toBeTruthy();
    expect(screen.getByText(/done on Base/)).toBeTruthy();
    expect(screen.getByText(/finish on Gnosis/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Open Safe Holiday ${shortAddress(SAFE_A)}` }));
    expect(push).toHaveBeenCalledWith(`/onboarding/agent?safe=${SAFE_A}`);
  });

  it("filters saved-only Safes using their owned network inventory", () => {
    mineData = [
      { ...pendingSafe, name: "Base saved", pendingSetup: false, createdChainIds: [], ownedChainIds: [8453], networks: [8453] },
      { ...pendingSafe, id: 2, address: "0x60157EE8eA450d606F969acb7043DC2Fd6Aa50aB", name: "Arbitrum saved", pendingSetup: false, createdChainIds: [], ownedChainIds: [42161], networks: [42161] },
    ];
    render(<OnboardingPage />);
    expect(screen.getByText("Base saved")).toBeTruthy();
    expect(screen.getByText("Arbitrum saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Base" }));
    expect(screen.getByText("Base saved")).toBeTruthy();
    expect(screen.queryByText("Arbitrum saved")).toBeNull();
  });

  it("merges verified saved memberships with discovery without relabeling balance or approval coverage", () => {
    ownedData = [{
      address: SAFE_A, threshold: 1, ownerCount: 1, chainIds: [8453], balanceUsd: 4500,
      balanceChainIds: [8453], networkDetails: [{ chainId: 8453, threshold: 1, ownerCount: 1, owners: [{ address: W1 }] }],
    }];
    mineData = [{ ...pendingSafe, pendingSetup: false, createdChainIds: [], ownedChainIds: [8453, 42161], verifiedChainIds: [8453, 42161], networks: [8453, 42161] }];
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Arbitrum" }));
    expect(screen.getByText("Holiday")).toBeTruthy();
    expect(screen.getByText("Verified ownership on").parentElement?.textContent?.replace(/\s+/g, " ").trim()).toBe("Verified ownership on Base and Arbitrum");
    // The balance's real coverage is on the tile face before expanding — under the Arbitrum filter it is not relabeled.
    const safeList = screen.getByRole("list", { name: "Your Safes" });
    const tileText = within(safeList).getByRole("listitem").textContent ?? "";
    expect(tileText).toContain("$4,500 found on Base. Other balances are unavailable.");
    expect(tileText).toContain("Supported balance");
    fireEvent.click(screen.getByRole("button", { name: "Address on Arbitrum" }));
    expect(screen.getByText("Approval details unavailable on Arbitrum.")).toBeTruthy();
    expect(screen.queryByText(/Approvals on Arbitrum/)).toBeNull();
    fireEvent.click(within(within(safeList).getByRole("listitem")).getByRole("button", { name: `Open Safe Holiday ${shortAddress(SAFE_A)}` }));
    expect(push).toHaveBeenCalledWith(`/onboarding/agent?safe=${SAFE_A}`);
  });

  it("keeps a verified off-lending network in memberships without inventing approval details", () => {
    mineData = [{ ...pendingSafe, pendingSetup: false, createdChainIds: [], ownedChainIds: [], verifiedChainIds: [10], networks: [] }];
    render(<OnboardingPage />);
    expect(screen.getByText("Verified ownership on").parentElement?.textContent?.replace(/\s+/g, " ").trim()).toBe("Verified ownership on Optimism");
    fireEvent.click(screen.getByRole("button", { name: "Address" }));
    expect(screen.getByText("Approval details unavailable on Optimism.")).toBeTruthy();
  });

  it("does not offer Open Safe when only off-lending ownership is verified and a tracked network is unowned", () => {
    mineData = [{ ...pendingSafe, ownedChainIds: [], verifiedChainIds: [1], networks: [42161] }];
    render(<OnboardingPage />);
    expect(screen.getByRole("button", { name: "Finish setting up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open Safe/ })).toBeNull();
  });

  it("keeps a pending-only Safe on the recovery path without an Open Safe action", () => {
    mineData = [{ ...pendingSafe, ownedChainIds: [], verifiedChainIds: [], networks: [] }];
    render(<OnboardingPage />);
    expect(screen.getByRole("button", { name: "Finish setting up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open Safe/ })).toBeNull();
  });

  it("is still offered when the wallet lookup found nothing, and resume re-checks the stored hash instead of paying again", async () => {
    mineData = [pendingSafe];
    localStorage.setItem(createProgressKey(W1, SAFE_A), JSON.stringify({ address: SAFE_A, name: "Holiday", chainIds: [8453, 100], hashes: { 8453: "0xhash" } }));
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/onboarding/agent?safe=${SAFE_A}&path=create`));
    expect(api.setup).toHaveBeenCalledWith(SAFE_A, 8453, "0xhash");
    expect(api.setup).toHaveBeenCalledWith(SAFE_A, 100);
    expect(api.setup).not.toHaveBeenCalledWith(SAFE_A, 42161);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.payFee).not.toHaveBeenCalled();
  });

  it("after a wallet switch the same Safe has no stored payment for the new wallet, so it is asked again", async () => {
    mineData = [pendingSafe];
    localStorage.setItem(createProgressKey(W1, SAFE_A), JSON.stringify({ address: SAFE_A, name: "Holiday", chainIds: [8453, 100], hashes: { 8453: "0xhash" } }));
    const { rerender } = render(<OnboardingPage />);
    wallet = W2;
    rerender(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    await screen.findByRole("button", { name: "Pay the setup fee on Base" });
    expect(api.setup).toHaveBeenCalledWith(SAFE_A, 8453);
    expect(api.setup).not.toHaveBeenCalledWith(SAFE_A, 8453, "0xhash");
    expect(api.payFee).not.toHaveBeenCalled();
  });

  it("shows a local Safe nickname in onboarding only for its owning wallet", async () => {
    mineData = [{ ...pendingSafe, pendingSetup: false, createdChainIds: [], ownedChainIds: [8453], networks: [8453] }];
    const key = `la:safeNickname:${W1.toLowerCase()}:${SAFE_A.toLowerCase()}`;
    localStorage.setItem(key, JSON.stringify("Holiday house"));
    const { rerender } = render(<OnboardingPage />);
    expect(await screen.findByText("Holiday house")).toBeTruthy();
    expect(screen.queryByText("Holiday", { exact: true })).toBeNull();
    wallet = W2;
    rerender(<OnboardingPage />);
    await waitFor(() => expect(screen.queryByText("Holiday house")).toBeNull());
    expect(screen.getByText("Holiday", { exact: true })).toBeTruthy();
  });

  it("does not claim no Safe was saved while the saved list is loading", () => {
    mineLoading = true;
    render(<OnboardingPage />);
    expect(screen.getByText("Checking your saved Safes…")).toBeTruthy();
    expect(screen.queryByText(/No Safe found for/)).toBeNull();
    expect((screen.getByRole("button", { name: "Create a new Safe" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives Safe selection a full-viewport workspace while the create flow stays in the narrow card", () => {
    ownedData = [{ address: SAFE_A, name: "Holiday", threshold: 1, ownerCount: 1, chainIds: [8453] }];
    render(<OnboardingPage />);
    // Full-viewport shell: the progress bar sits in a page header that carries an
    // edge-to-edge divider over fluid content — no centered max-width column.
    const header = document.querySelector("header");
    expect(header?.className).toMatch(/border-b/);
    expect(header?.querySelector('nav[aria-label="Onboarding progress"]')).toBeTruthy();
    expect(document.querySelector("main")).toBeTruthy();
    expect(document.querySelector(".max-w-7xl")).toBeNull();
    expect(document.querySelector(".max-w-md.bg-card")).toBeNull();
    fireEvent.click(screen.getByText("Other options"));
    fireEvent.click(screen.getByRole("button", { name: "Create a new Safe" }));
    expect(document.querySelector("header")).toBeNull();
    expect(document.querySelector(".max-w-md.bg-card")).toBeTruthy();
  });

  it("lets the borrower retry a failed saved-Safe lookup instead of treating it as an empty list", () => {
    mineError = new Error("saved list unavailable");
    render(<OnboardingPage />);
    expect(screen.getByText(/We could not load your saved Safes/)).toBeTruthy();
    expect(screen.queryByText(/No Safe found for/)).toBeNull();
    expect((screen.getByRole("button", { name: "Create a new Safe" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("keeps a verified live tile mounted and focused through first saved-list failure, retry, and recovery classification", () => {
    mineData = undefined;
    mineError = new Error("saved list unavailable");
    ownedData = [{ address: SAFE_A, name: "Holiday", threshold: 1, ownerCount: 1, chainIds: [8453] }];
    const { rerender } = render(<OnboardingPage />);
    expect(screen.getByText(/We could not load your saved Safes/)).toBeTruthy();
    const list = screen.getByRole("list", { name: "Your Safes" });
    const tile = within(list).getByRole("listitem");
    const details = within(tile).getByRole("button", { name: "Address and approvals" });
    fireEvent.click(details);
    details.focus();
    expect(screen.getByRole("button", { name: "Add by address" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    mineError = null;
    mineFetching = true;
    rerender(<OnboardingPage />);
    expect(within(screen.getByRole("list", { name: "Your Safes" })).getByRole("listitem")).toBe(tile);
    expect(document.activeElement).toBe(details);
    expect(screen.getByText(/Checking your saved Safes/)).toBeTruthy();

    mineFetching = false;
    mineData = [pendingSafe];
    rerender(<OnboardingPage />);
    expect(within(screen.getByRole("list", { name: "Your Safes" })).getByRole("listitem")).toBe(tile);
    expect(within(tile).getByRole("button", { name: "Finish setting up" })).toBeTruthy();
    expect(within(tile).getByRole("button", { name: "Address and approvals" })).toBe(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(details);
  });

  it("preserves a live tile disclosure and focus during a saved-list refetch after classification", () => {
    ownedData = [{ address: SAFE_A, name: "Holiday", threshold: 1, ownerCount: 1, chainIds: [8453] }];
    mineData = [];
    const { rerender } = render(<OnboardingPage />);
    const list = screen.getByRole("list", { name: "Your Safes" });
    const tile = within(list).getByRole("listitem");
    const details = within(tile).getByRole("button", { name: "Address and approvals" });
    fireEvent.click(details);
    details.focus();
    mineFetching = true;
    rerender(<OnboardingPage />);
    expect(within(screen.getByRole("list", { name: "Your Safes" })).getByRole("listitem")).toBe(tile);
    expect(within(tile).getByRole("button", { name: "Address and approvals" })).toBe(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(details);
  });

  it("does not call cached saved-only network membership verified after a failed refresh", () => {
    mineData = [{ ...pendingSafe, pendingSetup: false, createdChainIds: [], ownedChainIds: [8453], verifiedChainIds: [8453], networks: [8453] }];
    mineError = new Error("saved list unavailable");
    render(<OnboardingPage />);
    const tile = within(screen.getByRole("list", { name: "Your Safes" })).getByRole("listitem");
    expect(within(tile).queryByText("Verified ownership on")).toBeNull();
    expect(within(tile).getByText(/Saved ownership was last checked on Base/)).toBeTruthy();
    expect(within(tile).getByText(/saved Safe list refresh failed/)).toBeTruthy();
  });

  it("shows an indeterminate live row as last known and keeps it in place", () => {
    ownedData = [{ address: SAFE_A, name: "Holiday", threshold: 2, ownerCount: 3, chainIds: [8453], balanceUsd: 0 }];
    ownedStaleAddresses = [SAFE_A.toLowerCase()];
    mineData = [];
    render(<OnboardingPage />);
    const tile = within(screen.getByRole("list", { name: "Your Safes" })).getByRole("listitem");
    expect(within(tile).getByText(/Last known ownership details/)).toBeTruthy();
    expect(within(tile).queryByText("Verified ownership on")).toBeNull();
    expect(within(tile).queryByText("No supported funds found.")).toBeNull();
  });

  it("scopes the wallet lookups to the signed-in wallet", () => {
    render(<OnboardingPage />);
    expect(ownedWalletArgs).toContain(W1);
    expect(mineWalletArgs).toContain(W1);
  });

  it("checks the session inside the wide picker shell, not the narrow card", () => {
    sessionLoading = true;
    render(<OnboardingPage />);
    expect(document.querySelector("header")?.className).toMatch(/border-b/);
    expect(document.querySelector("main")).toBeTruthy();
    expect(screen.getByText(/Checking your session/)).toBeTruthy();
    expect(document.querySelector(".max-w-md.bg-card")).toBeNull();
    // The destination is not settled yet: no guide during the transient session check.
    expect(document.querySelector("[data-guide-button]")).toBeNull();
  });

  it("does not offer picks or creation while the saved list is still loading", () => {
    mineLoading = true;
    ownedData = [{ address: SAFE_A, name: "Holiday", threshold: 1, ownerCount: 1, chainIds: [8453] }];
    render(<OnboardingPage />);
    expect((screen.getByRole("button", { name: `Open Safe ${shortAddress(SAFE_A)}` }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Other options"));
    expect((screen.getByRole("button", { name: "Create a new Safe" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps showing results as arriving instead of done while discovery still fetches", () => {
    ownedFetching = true;
    render(<OnboardingPage />);
    expect(screen.getByText("Looking for your Safes…")).toBeTruthy();
    expect(screen.queryByText(/No Safe found for/)).toBeNull();
  });

  it("waits to classify live-only Safes until the first saved-list response", () => {
    mineData = undefined;
    ownedData = [{ address: SAFE_A, name: "Holiday", threshold: 1, ownerCount: 1, chainIds: [8453] }];
    render(<OnboardingPage />);
    expect(screen.queryByRole("button", { name: `Open Safe Holiday ${shortAddress(SAFE_A)}` })).toBeNull();
    expect(screen.getByText(/Checking your saved Safes/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create a new Safe" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
