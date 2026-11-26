// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createProgressKey } from "@/lib/create-progress";
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
  it("keeps an owned Safe usable while also offering its unfinished setup", () => {
    ownedData = [{ address: SAFE_A, threshold: 1, ownerCount: 1, chainIds: [8453] }];
    mineData = [pendingSafe];
    render(<OnboardingPage />);
    expect(screen.getAllByText("Holiday")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Finish setting up" })).toBeTruthy();
    expect(screen.getByText("Only you approve transactions.")).toBeTruthy();
    expect(screen.getByText(/done on Base/)).toBeTruthy();
    expect(screen.getByText(/finish on Gnosis/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Only you approve/ }));
    expect(push).toHaveBeenCalledWith(`/onboarding/agent?safe=${SAFE_A}`);
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

  it("does not claim no Safe was saved while the saved list is loading", () => {
    mineLoading = true;
    render(<OnboardingPage />);
    expect(screen.getByText("Checking your saved Safes…")).toBeTruthy();
    expect(screen.queryByText(/No Safe found for/)).toBeNull();
    expect((screen.getByRole("button", { name: "Create a new Safe" }) as HTMLButtonElement).disabled).toBe(true);
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
