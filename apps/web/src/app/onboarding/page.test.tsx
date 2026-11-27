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
vi.mock("@/client/auth/useSession", () => ({
  useSession: () => ({ session: { address: wallet }, loading: false }),
  useSignOut: () => vi.fn(),
}));

let ownedData: object[] = [];
let mineData: object[] = [];
let mineLoading = false;
let mineError: Error | null = null;
const refetch = vi.fn();
vi.mock("@/client/safes", () => ({
  useOwnedSafes: () => ({ data: ownedData, isLoading: false, error: null, refetch }),
  useSafes: () => ({ data: mineData, isLoading: mineLoading, error: mineError, refetch }),
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

beforeEach(() => { localStorage.clear(); wallet = W1; mineLoading = false; mineError = null; });
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
    expect(screen.getByText("Approvals on Base: Only you approve transactions.")).toBeTruthy();
    expect(screen.getByText("Verified ownership on").parentElement?.textContent?.replace(/\s+/g, " ").trim()).toBe("Verified ownership on Base and Arbitrum");
    expect(screen.getByText("$4,500 found on Base. Other balances are unavailable.")).toBeTruthy();
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
    expect(screen.getByRole("listitem").textContent).toContain("$4,500 found on Base. Other balances are unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Address on Arbitrum" }));
    expect(screen.getByText("Approval details unavailable on Arbitrum.")).toBeTruthy();
    expect(screen.queryByText(/Approvals on Arbitrum/)).toBeNull();
    fireEvent.click(within(screen.getByRole("listitem")).getByRole("button", { name: `Open Safe Holiday ${shortAddress(SAFE_A)}` }));
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

  it("gives Safe selection a wide workspace while the create flow stays in the narrow card", () => {
    ownedData = [{ address: SAFE_A, name: "Holiday", threshold: 1, ownerCount: 1, chainIds: [8453] }];
    render(<OnboardingPage />);
    expect(document.querySelector(".max-w-7xl")).toBeTruthy();
    expect(document.querySelector(".max-w-md.bg-card")).toBeNull();
    fireEvent.click(screen.getByText("Other options"));
    fireEvent.click(screen.getByRole("button", { name: "Create a new Safe" }));
    expect(document.querySelector(".max-w-md.bg-card")).toBeTruthy();
    expect(document.querySelector(".max-w-7xl")).toBeNull();
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
});
