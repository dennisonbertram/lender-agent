// @vitest-environment jsdom
// Guide entry integration: locks the surfaces the shared guide hangs off — the
// sign-in control, the Safe picker and create actions, the chat composer, the
// wallet menu, the activity table, the settings panels, and where GuideProvider,
// GuideButton and GuideIntro mount. The guide module itself is stubbed so these
// tests pin our integration contract, not the guide's own UI or topic catalog.
import { createContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  path: "/s/0xabc",
  mine: [] as object[],
  mediaMatch: (_query: string): boolean => false,
  shell: {} as Record<string, unknown>,
}));

vi.mock("@/components/guide/Guide", () => ({
  GuideProvider: ({ children }: { children: ReactNode }) => <div data-guide-provider>{children}</div>,
  GuideButton: () => <button type="button" data-guide-button>Guide</button>,
  GuideIntro: ({ topicId }: { topicId: string }) => <div data-guide-intro={topicId} />,
}));

vi.mock("wagmi", () => ({
  WagmiContext: createContext({}),
  useAccount: () => ({ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", isConnected: true }),
  useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false, error: null }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
}));

vi.mock("@/client/auth/useSession", () => ({
  useSession: () => ({ session: { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }, loading: false, signIn: vi.fn(), signingIn: false, signInError: null }),
  useSignOut: () => vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => state.path,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/shell/ShellContext", () => ({
  useShell: () => state.shell,
  useSafeNickname: () => ({ safeName: (a: string, n?: string) => n ?? a, safeNickname: () => undefined, setSafeNickname: vi.fn() }),
  primaryChain: (ids?: number[]) => ids?.[0],
}));

vi.mock("@/client/wallet/WalletProvider", () => ({ WalletProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/wallet/TxToasts", () => ({ TxToastProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

vi.mock("@/client/safes", () => ({
  useOwnedSafes: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
  useSafes: () => ({ data: state.mine, isLoading: false, error: null, refetch: vi.fn() }),
  useAddSafe: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  ApiError: class extends Error {},
}));
vi.mock("@/client/create-safe", () => ({ useCreateSafeApi: () => ({}) }));
vi.mock("@/client/agent", () => ({
  useAgentStatus: () => ({ data: { networks: [], eligibleChainIds: [], canChat: false, otherChainIds: [] }, isPending: false, error: null, isFetchedAfterMount: false }),
  useAddAgent: () => ({ add: vi.fn(), adding: false, progress: null, error: null }),
  useAddNetwork: () => ({ addNetwork: vi.fn(), adding: false }),
  chainName: () => "Base",
}));
vi.mock("@/client/proposals", () => ({ PROPOSAL_SENT_EVENT: "proposal-sent" }));
vi.mock("@/client/activity", () => ({ useActivity: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isPending: false, isError: false, data: [] }), useQueryClient: () => ({ clear: vi.fn() }) }));
vi.mock("@ai-sdk/react", () => ({ useChat: () => ({ messages: [], sendMessage: vi.fn(), setMessages: vi.fn(), status: "ready", error: undefined }) }));
vi.mock("ai", () => ({ DefaultChatTransport: class {} }));
vi.mock("@/components/agent/AgentWatchStatus", () => ({ AgentWatchStatus: () => null, useWatchStatus: () => ({ state: "ok", line: "" }) }));
vi.mock("@/components/agent/AgentOffNotice", () => ({ AgentOffNotice: () => null, AddAgentAction: () => null }));
vi.mock("@/components/chat/MessageList", () => ({ MessageList: () => null }));
vi.mock("@/components/chat/SafeLine", () => ({ SafeLine: () => null }));
vi.mock("@/components/onboarding/CreateSafe", () => ({ CreateSafe: () => <div data-create-stub /> }));
vi.mock("@/components/onboarding/useSafeNicknameNames", () => ({ useSafeNicknameNames: () => ({}) }));

import { Providers } from "@/app/providers";
import OnboardingPage from "@/app/onboarding/page";
import { BorrowerHome } from "@/components/home/BorrowerHome";
import { AgentStepView } from "@/components/onboarding/AgentStepView";
import { SignInCard } from "@/components/auth/SignInCard";
import { Composer } from "@/components/chat/Composer";
import { ChatView } from "@/components/chat/ChatView";
import { ActivityLog } from "@/components/activity/ActivityLog";
import { SafeStep } from "@/components/onboarding/SafeStep";
import { AppShell } from "@/components/shell/AppShell";
import { WrongWallet } from "@/components/proposals/WrongWallet";
import { MinimalTopBar } from "@/components/shell/MinimalTopBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { WalletMenu } from "@/components/wallet/WalletMenu";
import { EmailPanel } from "@/components/settings/EmailPanel";
import { NetworksPanel } from "@/components/settings/NetworksPanel";
import { SafeNicknameEditor } from "@/components/settings/SafeNicknameEditor";

const foundSafe = { address: "0x60157EE8eA450d606F969acb7043DC2Fd6Aa50aA", name: "Holiday", threshold: 1, ownerCount: 1, chainIds: [8453] };
const shellSafe = { id: "0xabc", name: "Home", address: "0xabc", threshold: "1 of 1", agent: true, networks: [], balances: {} };

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  state.mine = [];
  state.mediaMatch = () => false;
  state.shell = {};
  window.matchMedia = ((q: string) => ({
    matches: state.mediaMatch(q), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});
afterEach(cleanup);

describe("guide entry points", () => {
  it("mounts GuideProvider once around the app", () => {
    const { container } = render(<Providers><p>app</p></Providers>);
    expect(container.querySelectorAll("[data-guide-provider]")).toHaveLength(1);
  });

  it("keeps the sign-in control highlighted and the guide button on the returning card", () => {
    const { container } = render(<SignInCard returning />);
    expect(container.querySelector('[data-guide-target="sign-in"]')).toBeTruthy();
    expect(container.querySelectorAll("[data-guide-button]")).toHaveLength(1);
  });

  it("keeps the guide button off the homepage hero's own card (the page carries it)", () => {
    const { container } = render(<SignInCard presentation="hero" />);
    expect(container.querySelector('[data-guide-target="sign-in"]')).toBeTruthy();
    expect(container.querySelector("[data-guide-button]")).toBeNull();
  });

  it("keeps the guide button on the Safe shell's loading and error bar", () => {
    const { container } = render(<MinimalTopBar address="0xabc" />);
    expect(container.querySelectorAll("[data-guide-button]")).toHaveLength(1);
  });

  it("keeps exactly one guide button in the sidebar, with the wallet menu target", () => {
    const { container } = render(<Sidebar safe={shellSafe} safes={[]} loans={[]} pathname="/s/0xabc" onNavigate={() => {}} userLabel="0x7099…79C8" />);
    expect(container.querySelectorAll("[data-guide-button]")).toHaveLength(1);
    expect(container.querySelector('[data-guide-target="wallet-menu"]')).toBeTruthy();
  });

  it.each([
    ["phone", () => false],
    ["desktop", (q: string) => q === "(min-width: 768px)"],
  ])("keeps exactly one guide button in the Safe shell on %s", (_name, match) => {
    state.mediaMatch = match;
    state.shell = { safe: shellSafe, safes: [shellSafe], loans: [], loansError: false, reserve: null, chainIds: [] };
    const { container } = render(<AppShell>content</AppShell>);
    expect(container.querySelectorAll("[data-guide-button]")).toHaveLength(1);
  });

  it("keeps the guide button out of the phone menu sheet — the header carries it", async () => {
    state.mediaMatch = () => false;
    state.shell = { safe: shellSafe, safes: [shellSafe], loans: [], loansError: false, reserve: null, chainIds: [] };
    render(<AppShell>content</AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    // A Guide button inside the menu sheet would open a second sheet over the page's controls.
    await waitFor(() => expect(document.querySelector('[data-slot="sheet-content"]')).toBeTruthy());
    expect(document.querySelector('[data-slot="sheet-content"] [data-guide-button]')).toBeNull();
    expect(document.querySelectorAll("[data-guide-button]")).toHaveLength(1);
  });

  it("keeps the guide reachable on the wrong-wallet screen", () => {
    const { container } = render(<WrongWallet returnTo="/s/0xabc/proposals/p1" />);
    expect(container.querySelectorAll("[data-guide-button]")).toHaveLength(1);
  });
});

describe("guide intro topics", () => {
  it("starts onboarding on choose-safe and follows the create flow", () => {
    const { container, getByRole } = render(<OnboardingPage />);
    expect(container.querySelector('[data-guide-intro="choose-safe"]')).toBeTruthy();
    expect(container.querySelector('[data-guide-intro="create-safe"]')).toBeNull();
    expect(container.querySelectorAll("[data-guide-button]")).toHaveLength(1);
    fireEvent.click(getByRole("button", { name: "Create a new Safe" }));
    expect(container.querySelector('[data-guide-intro="create-safe"]')).toBeTruthy();
    expect(container.querySelector('[data-guide-intro="choose-safe"]')).toBeNull();
    expect(container.querySelector("[data-create-stub]")).toBeTruthy();
  });

  it("carries the welcome topic and the guide button on the marketing homepage", () => {
    const { container } = render(<BorrowerHome />);
    expect(container.querySelector('[data-guide-intro="welcome"]')).toBeTruthy();
    expect(container.querySelectorAll("[data-guide-button]")).toHaveLength(1);
    expect(container.querySelector('[data-guide-target="sign-in"]')).toBeTruthy();
  });

  it("marks the agent step of onboarding", () => {
    const { container } = render(<AgentStepView safeAddress="0xabc" />);
    expect(container.querySelector('[data-guide-intro="agent"]')).toBeTruthy();
  });

  it("marks the chat screen with its topic and composer", () => {
    state.shell = { agentOn: true };
    const { container } = render(<ChatView address="0xabc" />);
    expect(container.querySelector('[data-guide-intro="chat"]')).toBeTruthy();
    expect(container.querySelector('[data-guide-target="chat-compose"]')).toBeTruthy();
  });

  it("marks the activity screen with its topic and list", () => {
    state.shell = { safe: shellSafe };
    const { container } = render(<ActivityLog />);
    expect(container.querySelector('[data-guide-intro="activity"]')).toBeTruthy();
    expect(container.querySelector('[data-guide-target="activity-list"]')).toBeTruthy();
  });
});

describe("guide step targets stay on the real controls", () => {
  it("choose-safe marks the Safe list; the picker's create launchers stay unmarked", () => {
    const found = render(
      <SafeStep found={[foundSafe]} busy={false} onPick={() => {}} onAdd={() => {}} onCreate={() => {}} existing={[]} />,
    );
    expect(found.container.querySelector('[data-guide-target="choose-safe"]')).toBeTruthy();
    // "Create a new Safe" only starts the flow — the review step's own marker must not sit
    // on the launcher, or "Show on page" would highlight a button with no review behind it.
    const launcher = [...found.container.querySelectorAll("button")].find((b) => b.textContent === "Create a new Safe");
    expect(launcher).toBeTruthy();
    expect(launcher!.getAttribute("data-guide-target")).toBeNull();
    expect(found.container.querySelector('[data-guide-target="create-safe"]')).toBeNull();
    found.unmount();
    const empty = render(
      <SafeStep found={[]} busy={false} onPick={() => {}} onAdd={() => {}} onCreate={() => {}} existing={[]} />,
    );
    expect(empty.getByRole("button", { name: "Create a new Safe" }).getAttribute("data-guide-target")).toBeNull();
    expect(empty.container.querySelector('[data-guide-target="create-safe"]')).toBeNull();
  });

  it("create-safe marks only the review step's submit inside the create flow", async () => {
    // The real component, not the stub above: the contract is that its marker reaches the
    // DOM only on the final "Create Safe" confirmation.
    const { CreateSafe } = await vi.importActual<typeof import("@/components/onboarding/CreateSafe")>(
      "@/components/onboarding/CreateSafe",
    );
    const api = {
      preview: vi.fn(async () => ({ address: foundSafe.address, index: 0, message: "m", sponsored: true, cost: "free", chainId: 8453 })),
      create: vi.fn(async () => ({ address: foundSafe.address })),
      setup: vi.fn(async () => ({ status: "ready" as const, indexed: true })),
      reconcile: vi.fn(async () => ({ status: "ready" as const, indexed: true })),
      payFee: vi.fn(async () => "0xhash"),
      indexed: vi.fn(async () => true),
    };
    const { container } = render(
      <CreateSafe wallet="0x70997970C51812dc3A010C7d01b50e0d17dc79C8" api={api} onCreated={vi.fn()} />,
    );
    // One submit serves Name, Approvals and Review: before Review it is "Next", unmarked.
    expect(container.querySelector('[data-guide-target="create-safe"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(container.querySelector('[data-guide-target="create-safe"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const marked = container.querySelectorAll('[data-guide-target="create-safe"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(screen.getByRole("button", { name: "Create Safe" }));
  });

  it("the email, networks and nickname panels keep their targets", () => {
    const email = render(<EmailPanel value={{ email: null, enabled: false }} onSave={async () => {}} />);
    expect(email.container.querySelector('[data-guide-target="settings-email"]')).toBeTruthy();
    const nets = render(<NetworksPanel safeName="Home" rows={[]} progress={null} busy={false} onAddAgent={() => {}} onAddNetwork={() => {}} />);
    expect(nets.container.querySelector('[data-guide-target="settings-networks"]')).toBeTruthy();
    const nick = render(<SafeNicknameEditor address="0xabc" safeName="Home" setSafeNickname={() => true} />);
    expect(nick.container.querySelector('[data-guide-target="settings-nickname"]')).toBeTruthy();
  });
});
