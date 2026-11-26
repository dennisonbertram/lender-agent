// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ApiError } from "@/client/safes";
import { AgentStepView } from "./AgentStepView";

const A = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0001";
const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push }) }));

let status: Record<string, unknown>;
let safes: { address: string; name: string }[];
vi.mock("@/client/agent", () => ({
  chainName: () => "Base",
  useAgentStatus: () => status,
  useAddNetwork: () => ({ addNetwork: vi.fn(), adding: false, error: null, reset: vi.fn() }),
  useAddAgent: () => ({ add: vi.fn(), adding: false, progress: null, error: null, reset: vi.fn() }),
}));
vi.mock("@/client/safes", async (orig) => ({ ...(await orig<typeof import("@/client/safes")>()), useSafes: () => ({ data: safes }), useAddSafe: () => ({ mutate: vi.fn(), error: null }) }));

const on = { active: true, networks: [{ chainId: 8453, deployed: true, added: true }] };
beforeEach(() => {
  replace.mockClear();
  push.mockClear();
  safes = [];
  status = { isPending: false, isFetchedAfterMount: true, data: on, error: null };
});
afterEach(cleanup);

describe("AgentStepView", () => {
  it("goes straight to the chat when the first fresh read shows the agent on", () => {
    render(<AgentStepView safeAddress={A} />);
    expect(replace).toHaveBeenCalledWith(`/s/${A}/chat`);
    expect(replace).toHaveBeenCalledTimes(1);
  });
  it("never redirects from cached data", () => {
    status = { ...status, isFetchedAfterMount: false };
    render(<AgentStepView safeAddress={A} />);
    expect(replace).not.toHaveBeenCalled();
  });
  it("shows a labelled loading status after a second and nothing else while the status loads", () => {
    vi.useFakeTimers();
    status = { isPending: true, isFetchedAfterMount: false, data: undefined, error: null };
    render(<AgentStepView safeAddress={A} />);
    expect(screen.queryByText("Loading this Safe…")).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    vi.useRealTimers();
    expect(screen.getByText("Loading this Safe…")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/no network yet/);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("a 403 says not an owner and offers the way back", () => {
    status = { isPending: false, isFetchedAfterMount: true, data: undefined, error: new ApiError(403, "Not allowed") };
    render(<AgentStepView safeAddress={A} />);
    expect(screen.getByText("You are not an owner of this Safe")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to your Safes" }).getAttribute("href")).toBe("/onboarding");
    expect(screen.queryByRole("button", { name: "Add Lender agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });
  it("a 404 says the Safe is not in the list, shows the address and offers Add it", () => {
    status = { isPending: false, isFetchedAfterMount: true, data: undefined, error: new ApiError(404, "Safe not found") };
    render(<AgentStepView safeAddress={A} />);
    expect(screen.getByRole("heading", { name: "This Safe is not in your list yet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add it" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to your Safes" })).toBeTruthy();
    expect(screen.getByTitle(/^0x5a[fF]e5/i)).toBeTruthy();
  });
  it("any other error says we could not load it", () => {
    status = { isPending: false, isFetchedAfterMount: true, data: undefined, error: new ApiError(500, "Boom") };
    render(<AgentStepView safeAddress={A} />);
    expect(screen.getByText("We could not load this Safe")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "We could not load this Safe" })).toBeTruthy();
    expect(screen.getByText("Check the address, or pick another Safe.")).toBeTruthy();
  });
  it("shows the name the user gave the Safe", () => {
    safes = [{ address: A.toLowerCase(), name: "Family Safe" }];
    status = { ...status, data: { active: false, networks: [{ chainId: 8453, deployed: true, added: false }] } };
    render(<AgentStepView safeAddress={A} />);
    expect(screen.getByText("Family Safe")).toBeTruthy();
  });
});
