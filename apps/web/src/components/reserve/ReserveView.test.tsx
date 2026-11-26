// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Safe } from "@/lib/types";
import { ShellProvider, type ShellLoan, type ShellReserve } from "@/components/shell/ShellContext";
import { Sidebar } from "@/components/shell/Sidebar";
import { AgentStatus } from "@/components/chat/ChatView";
import { OwnedChainsProvider } from "@/components/wallet/OwnedChains";
import type { LoanView } from "@/server/loans";
import { ReserveView } from "./ReserveView";

const loanHookState = vi.hoisted(() => ({ loans: [] as unknown[] }));
vi.mock("@/client/loans", () => ({ useLoans: () => ({ data: { loans: loanHookState.loans }, isPending: false, error: null }) }));

const safe: Safe = { id: "s1", name: "Treasury Safe", address: "0xabc", threshold: "2/3", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} };
const RESERVE = "0x62E792D80164fdc892237Ee4267552E6eeb1651a";
const API_SAFE = "0x0000000000000000000000000000000000000abc";
const copyOf = (dailyLimitUsd: number) => ({ can: ["Repay Treasury Safe's USDC debt on Aave (Base), from this Reserve Safe", "Only when a loan is close to liquidation: health below 1.15 (1.00 is liquidation)", `Request up to $${dailyLimitUsd.toLocaleString("en-US")} of USDC per day. The limit counts what the agent asks to repay, not what Aave takes`], cannot: ["Send money anywhere, even to Treasury Safe", "Borrow more, add collateral or withdraw collateral", "Repay anyone else's loan, use another token or another lender (Compound v3 is not covered)"], enforced: "The chain enforces what the agent may call, for whom and how much per day. The agent decides when: the health trigger is not checked on-chain." });

const aaveLoan: ShellLoan = { id: "l1", safeId: "s1", network: "base", venue: "Aave v3", collAsset: "ETH", collAmount: 2, debtAsset: "USDC", debt: 3000, lt: 0.8, apr: 3.4, accrued: 0, hf: 1.5, status: "watch" };
const liveAaveLoan = (changes: Partial<LoanView> = {}) => ({
  id: `8453:${API_SAFE}:aave-v3`, chainId: 8453, network: "base", lender: "Aave v3",
  collateral: [{ asset: "ETH", amount: 2, usd: 4000 }], debt: { asset: "USDC", amount: 3000, usd: 3000 },
  healthFactor: 1.5, status: "watch", levels: { warn: 1.45, act: 1.25 }, canFallPct: "ETH can fall 20%",
  rowLine: "Borrowed $3,000", maxDrop: 0.2, liquidationPrice: 1600, collateralPrice: 2000, apr: 3.4, yearlyInterest: 102,
  limit: { used: 50, fill: 50, tick: null, text: "50% used" },
  onchain: { market: { kind: "address", value: "0x0000000000000000000000000000000000000001" }, collateral: [{ symbol: "WETH", address: "0x0000000000000000000000000000000000000002" }], debt: [{ symbol: "USDC", address: "0x0000000000000000000000000000000000000003" }] },
  blockNumber: 1, readAt: 1, mixed: false, watched: true, shell: aaveLoan, ...changes,
} as unknown as LoanView);
const shellLoanView = (loan: ShellLoan) => liveAaveLoan({
  id: `8453:${API_SAFE}:${loan.venue === "Aave v3" ? "aave-v3" : loan.venue.toLowerCase().includes("compound") ? "compound-v3" : "morpho-blue"}`,
  chainId: loan.network === "base" ? 8453 : 42161,
  network: loan.network,
  lender: loan.venue,
  collateral: [{ asset: loan.collAsset, amount: loan.collAmount, usd: null }],
  debt: { asset: loan.debtAsset, amount: loan.debt, usd: null },
  healthFactor: loan.hf,
  shell: loan,
  onchain: { market: { kind: "id", value: "fixture" }, collateral: [{ symbol: loan.collAsset, address: "0x0000000000000000000000000000000000000002" }], debt: loan.debt === null || loan.debt > 0 ? [{ symbol: loan.debtAsset, address: "0x0000000000000000000000000000000000000003" }] : [] },
});
const status = (o: Partial<ShellReserve & { usedUsd: number; leftUsd: number; limitUsd: number; resetLabel: string | null }> = {}) => ({
  kind: "armed", label: "On", tone: "success", banner: "On: the agent can act on its own within these limits, without your signature.",
  balanceUsd: 4400, limitUsd: 1000, usedUsd: 0, leftUsd: 1000, resetLabel: null, ...o,
});
const linked = (s = status()) => ({
  chainId: 8453, available: true, linked: true, viewerIsReserveOwner: true, revocationConfirmed: false, setup: null, revoke: null, status: s,
  policy: { pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", reserve: RESERVE, roles: "0x00000000000000000000000000000000000000aa", executor: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", executorIsMember: true, dailyLimitUsd: 1000, periodHours: 24, triggerHf: 1.15, moduleEnabled: true, asDesigned: true, approved: true, issues: [], copy: copyOf(1000) },
});
const unlinked = { chainId: 8453, available: true, linked: false, status: null, policy: null, setup: null };

function mockApi(routes: { reserve: unknown; loans?: LoanView[]; check?: (body: any) => unknown; link?: (body: any) => unknown }) {
  const calls: { url: string; body?: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const json = url.endsWith("/loans") ? { loans: routes.loans ?? [] }
      : url.endsWith("/check") ? routes.check?.(body) : init?.method === "POST" ? routes.link?.(body) : routes.reserve;
    return new Response(JSON.stringify(json), { status: 200 });
  }));
  return calls;
}
let lastQueryClient: QueryClient;
const renderView = (reserve: ShellReserve | null = null, loans: ShellLoan[] = [], safes: Safe[] = [safe], ownedChainIds: readonly number[] = [8453], loanViews?: LoanView[]) => {
  loanHookState.loans = loanViews ?? loans.map(shellLoanView);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastQueryClient = qc;
  return render(<QueryClientProvider client={qc}><OwnedChainsProvider value={ownedChainIds}><ShellProvider safe={safe} safes={safes} loans={loans} agentOn watching reserve={reserve}><ReserveView address="0xabc" /></ShellProvider></OwnedChainsProvider></QueryClientProvider>);
};
const openAdvancedSetup = () => fireEvent.click(screen.getByText("Advanced setup: custom Safe address and health trigger"));

beforeEach(() => { Element.prototype.scrollTo = () => {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Reserve: addresses, header and disabled reason", () => {
  it("does not load or offer Reserve when this wallet only owns the Safe on another network", async () => {
    const calls = mockApi({ reserve: unlinked });
    renderView(null, [aaveLoan], [safe], [42161]);
    expect(await screen.findByText(/This Safe is not set up on Base/)).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/reserve"))).toBe(false);
    expect(screen.queryByLabelText("Daily limit (USDC)")).toBeNull();
  });

  it("unlinked: Safe address with network on top, what you will sign lists the addresses, and the disabled button says why", async () => {
    mockApi({ reserve: unlinked, check: (b) => ({ reserve: RESERVE, balanceUsd: 5000, errors: {}, copy: copyOf(b.dailyLimitUsd) }) });
    renderView();
    await screen.findByText(/A small second Safe holds USDC/);
    expect(screen.getByTestId("safe-identity").textContent).toContain("Base");
    expect(screen.getByText(/Add a Reserve Safe address to continue/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link Reserve Safe and sign" }).getAttribute("aria-describedby")).toBe("link-reason");
    fireEvent.click(screen.getByText(/What you will sign/));
    expect(screen.getByText("Aave v3 pool")).toBeTruthy();
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText(/not known before it/)).toBeTruthy();
  });
  it("linked: header shows the Reserve Safe address and the signed addresses include agent key, roles, pool and USDC", async () => {
    mockApi({ reserve: linked() });
    renderView();
    await screen.findByText("Agent's reserve key");
    expect(screen.getByTestId("safe-identity").textContent).toContain("Reserve Safe");
    for (const l of ["Roles modifier", "Aave v3 pool", "USDC"]) expect(screen.getByText(l)).toBeTruthy();
  });
});

describe("BP-39: link a Reserve Safe and sign the policy", () => {
  it("shows the intro, the can and cannot lists from the typed values, and signs nothing until the limits are valid", async () => {
    const calls = mockApi({
      reserve: unlinked,
      check: (b) => ({ reserve: RESERVE, balanceUsd: 5000, errors: {}, copy: copyOf(b.dailyLimitUsd) }),
      link: () => ({ proposalId: "p1", stage: "queued", receipt: null, reserve: RESERVE, roles: RESERVE, executor: RESERVE }),
    });
    renderView();
    expect(await screen.findByText(/A small second Safe holds USDC the agent can use, without asking you/)).toBeTruthy();
    expect(screen.getByText(/Compound v3 loans are not covered/)).toBeTruthy();
    expect(screen.getByText(/Request up to your daily limit of USDC per day/)).toBeTruthy();
    openAdvancedSetup();
    const sign = screen.getByRole("button", { name: "Link Reserve Safe and sign" }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);

    openAdvancedSetup();
    fireEvent.change(screen.getByLabelText("Reserve Safe address"), { target: { value: RESERVE } });
    fireEvent.change(screen.getByLabelText("Daily limit (USDC)"), { target: { value: "1000" } });
    expect(await screen.findByText(/Request up to \$1,000 of USDC per day/)).toBeTruthy();
    expect(screen.getByText(/health below 1.15 \(1.00 is liquidation\)/)).toBeTruthy();
    await waitFor(() => expect(sign.disabled).toBe(false));
    fireEvent.click(sign);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/reserve") && c.body?.dailyLimitUsd === 1000 && c.body?.triggerHf === 1.15 && c.body?.reserveSafe === RESERVE)).toBe(true));
    expect(await screen.findByText(/Sent to your Reserve Safe. Sign it in Safe/)).toBeTruthy();
  });

  it("blocks signing with the messages: limit above the balance, below $1, trigger outside 1.02 to 2.00", async () => {
    mockApi({ reserve: unlinked, check: (b) => ({ reserve: RESERVE, balanceUsd: 5000, errors: {}, copy: copyOf(b.dailyLimitUsd) }) });
    renderView();
    await screen.findByText(/A small second Safe holds USDC/);
    const sign = screen.getByRole("button", { name: "Link Reserve Safe and sign" }) as HTMLButtonElement;
    openAdvancedSetup();
    fireEvent.change(screen.getByLabelText("Reserve Safe address"), { target: { value: RESERVE } });
    fireEvent.change(screen.getByLabelText("Daily limit (USDC)"), { target: { value: "6000" } });
    expect(await screen.findByText("The Reserve Safe holds $5,000. The limit cannot be higher.")).toBeTruthy();
    expect(sign.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Daily limit (USDC)"), { target: { value: "0.5" } });
    expect(await screen.findByText(/Enter at least \$1\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Daily limit (USDC)"), { target: { value: "0" } });
    expect(await screen.findByText(/Enter at least \$1\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Daily limit (USDC)"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText(/Exact health trigger/), { target: { value: "1.01" } });
    expect(await screen.findByText("Use a number from 1.02 to 2.00")).toBeTruthy();
    expect(sign.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Exact health trigger/), { target: { value: "2.5" } });
    expect(await screen.findByText("Use a number from 1.02 to 2.00")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Exact health trigger/), { target: { value: "1.5" } });
    await waitFor(() => expect(sign.disabled).toBe(false));
  });

  it("shows the server's refusal (for example, the agent is not on the Reserve Safe)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/check")) return new Response(JSON.stringify({ reserve: RESERVE, balanceUsd: 5000, errors: {}, copy: copyOf(1000) }), { status: 200 });
      if (init?.method === "POST") return new Response(JSON.stringify({ error: "Add the Lender agent to the Reserve Safe first, then set up the reserve." }), { status: 409 });
      return new Response(JSON.stringify(unlinked), { status: 200 });
    }));
    renderView();
    await screen.findByText(/A small second Safe holds USDC/);
    openAdvancedSetup();
    fireEvent.change(screen.getByLabelText("Reserve Safe address"), { target: { value: RESERVE } });
    fireEvent.change(screen.getByLabelText("Daily limit (USDC)"), { target: { value: "1000" } });
    const sign = screen.getByRole("button", { name: "Link Reserve Safe and sign" }) as HTMLButtonElement;
    await waitFor(() => expect(sign.disabled).toBe(false));
    fireEvent.click(sign);
    expect((await screen.findByRole("alert")).textContent).toContain("Add the Lender agent to the Reserve Safe first");
  });
});

describe("BP-40: one status, from the on-chain allowance", () => {
  it("On: banner, policy from chain, '$X of $Y used today' and Resets in N h", async () => {
    mockApi({ reserve: linked(status({ usedUsd: 600, leftUsd: 400, resetLabel: "Resets in 5 h" })) });
    renderView();
    expect(await screen.findByText("On: the agent can act on its own within these limits, without your signature.")).toBeTruthy();
    expect(screen.getByText("$600 of $1,000 used today")).toBeTruthy();
    expect(screen.getByText("$400 left")).toBeTruthy();
    expect(screen.getByText("Resets in 5 h")).toBeTruthy();
    expect(screen.getByText(/the health trigger is not checked on-chain/)).toBeTruthy();
  });
  it("Limit reached and Off use the shared banners", async () => {
    mockApi({ reserve: linked(status({ kind: "limitReached", label: "Limit reached", tone: "warning", usedUsd: 1000, leftUsd: 0, resetLabel: "Resets in 3 h", banner: "Limit reached: today's $1,000 is used. Resets in 3 h. The agent only suggests until then." })) });
    renderView();
    expect(await screen.findByText(/^Limit reached: today's \$1,000 is used\. Resets in 3 h\./)).toBeTruthy();
    cleanup();
    mockApi({ reserve: linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Off: the agent only suggests. Nothing moves without your signature." })) });
    renderView();
    expect(await screen.findByText("Off: the agent only suggests. Nothing moves without your signature.")).toBeTruthy();
  });
  it("a Reserve whose chain scope is not as designed says so and lists why", async () => {
    const v = linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Off: the agent only suggests. Nothing moves without your signature." }));
    (v.policy as { asDesigned: boolean; issues: string[] }).asDesigned = false; (v.policy as { issues: string[] }).issues = ["The role can also call 0xabc."];
    mockApi({ reserve: v });
    renderView();
    expect(await screen.findByText(/not set up as designed/)).toBeTruthy();
    expect(screen.getByText("The role can also call 0xabc.")).toBeTruthy();
  });
  it("while the owners have not signed: waiting, with a link to the Reserve Safe queue", async () => {
    const v = { ...linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Off: the agent only suggests. Nothing moves without your signature." })), setup: { proposalId: "p1", stage: "queued", link: "https://app.safe.global/x", queueLink: "https://app.safe.global/q" } };
    mockApi({ reserve: v });
    renderView();
    expect(await screen.findByText(/Waiting for the Reserve Safe's owners to sign the setup/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Open in Safe/ }).map((a) => a.getAttribute("href"))).toContain("https://app.safe.global/x");
  });
  it("the sidebar and the chat header show the same one status", () => {
    const reserve: ShellReserve = { kind: "limitReached", label: "Limit reached", tone: "warning", banner: "", balanceUsd: 4400 };
    render(<ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching reserve={reserve}><Sidebar safe={safe} safes={[safe]} loans={[]} pathname="/s/0xabc/reserve" onNavigate={() => {}} reserve={reserve} /><AgentStatus /></ShellProvider>);
    expect(screen.getByRole("link", { name: /Reserve/ }).getAttribute("href")).toBe("/s/0xabc/reserve");
    expect(screen.getByText("$4,400")).toBeTruthy();
    expect(screen.getByText("Limit reached")).toBeTruthy();
    expect(screen.getByText("Reserve limit reached")).toBeTruthy();
  });
  it("the sidebar offers 'Set up reserve' when none is linked and the Safe has an Aave loan", () => {
    render(<Sidebar safe={safe} safes={[safe]} loans={[aaveLoan]} pathname="/s/0xabc" onNavigate={() => {}} reserve={null} />);
    expect(screen.getByText("Set up reserve")).toBeTruthy();
  });
  it("the sidebar has no Reserve item without an Aave loan or a linked Reserve", () => {
    const { rerender } = render(<Sidebar safe={safe} safes={[safe]} loans={[]} pathname="/s/0xabc" onNavigate={() => {}} reserve={null} />);
    expect(screen.queryByRole("link", { name: /Reserve/ })).toBeNull();
    rerender(<Sidebar safe={safe} safes={[safe]} loans={[{ ...aaveLoan, venue: "Morpho Blue" }]} pathname="/s/0xabc" onNavigate={() => {}} reserve={null} />);
    expect(screen.queryByRole("link", { name: /Reserve/ })).toBeNull();
    const linkedReserve: ShellReserve = { kind: "armed", label: "On", tone: "success", banner: "", balanceUsd: 10 };
    rerender(<Sidebar safe={safe} safes={[safe]} loans={[{ ...aaveLoan, venue: "Morpho Blue" }]} pathname="/s/0xabc" onNavigate={() => {}} reserve={linkedReserve} />);
    expect(screen.getByRole("link", { name: /Reserve/ })).toBeTruthy();
  });
  it("the sidebar does not repeat the Safe address under the picker", () => {
    render(<Sidebar safe={safe} safes={[safe]} loans={[]} pathname="/s/0xabc" onNavigate={() => {}} reserve={null} />);
    expect(screen.queryByTestId("safe-identity")).toBeNull();
  });
});

describe("Reserve for non-owners and without an Aave loan", () => {
  const ME = "0x1111111111111111111111111111111111111111";
  const OWNER = "0x5aFE3855358E112B5647B952709E6165e1c1eEEe";
  it("a viewer who does not own the Reserve Safe sees read-only fields and the owner list instead of the sign button", async () => {
    const cur = linked();
    mockApi({ reserve: { ...cur, reserveOwners: [OWNER], viewerIsReserveOwner: false } });
    renderView();
    await screen.findByText("Agent's reserve key");
    expect((screen.getByLabelText("Daily limit") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText("Agent uses the reserve when health drops below") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText("Only owners of the Reserve Safe can link it:")).toBeTruthy();
    expect(screen.getByTitle(OWNER)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign/ })).toBeNull();
  });
  it("an owner keeps editable fields", async () => {
    mockApi({ reserve: { ...linked(), reserveOwners: [ME], viewerIsReserveOwner: true } });
    renderView();
    await screen.findByText("Agent's reserve key");
    expect((screen.getByLabelText("Daily limit") as HTMLInputElement).readOnly).toBe(false);
    expect(screen.queryByText("Only owners of the Reserve Safe can link it:")).toBeNull();
  });
  it("fails closed when the owners could not be read: read-only, says so, offers retry", async () => {
    const { viewerIsReserveOwner: _omitted, ...unknownOwner } = linked();
    mockApi({ reserve: unknownOwner });
    renderView();
    await screen.findByText("Agent's reserve key");
    expect((screen.getByLabelText("Daily limit") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText(/owners of the Reserve Safe could not be checked/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign/ })).toBeNull();
  });
  it("the daily limit is not red before the user has typed or left the field", async () => {
    mockApi({ reserve: unlinked });
    renderView();
    await screen.findByText(/A small second Safe holds USDC/);
    expect(screen.queryByText(/Enter a daily limit/)).toBeNull();
    const cap = screen.getByLabelText("Daily limit (USDC)");
    expect(cap.getAttribute("aria-invalid")).not.toBe("true");
    fireEvent.blur(cap);
    expect(await screen.findByText(/Enter a daily limit/)).toBeTruthy();
  });
  it("the page starts with the Aave-only line when the Safe has no Aave loan, and not when it has one", async () => {
    mockApi({ reserve: unlinked });
    renderView();
    expect(await screen.findByText("Keeps a second Safe ready to repay your Aave loan. Works with Aave loans only.")).toBeTruthy();
    cleanup();
    mockApi({ reserve: unlinked, loans: [liveAaveLoan()] });
    loanHookState.loans = [liveAaveLoan()];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ShellProvider safe={safe} safes={[safe]} loans={[aaveLoan]} agentOn watching><ReserveView address="0xabc" /></ShellProvider></QueryClientProvider>);
    await screen.findByText(/A small second Safe holds USDC/);
    expect(screen.queryByText("Keeps a second Safe ready to repay your Aave loan. Works with Aave loans only.")).toBeNull();
    expect(screen.queryByText(/Your current Aave v3 position is not covered/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up for a future Aave loan" })).toBeNull();
  });

  it.each([
    ["mixed debt", liveAaveLoan({ mixed: true, debt: { asset: "USD", amount: 3001, usd: 3001 }, onchain: { market: { kind: "address", value: "0x0000000000000000000000000000000000000001" }, collateral: [{ symbol: "WETH", address: "0x0000000000000000000000000000000000000002" }], debt: [{ symbol: "USDC", address: "0x0000000000000000000000000000000000000003" }, { symbol: "DAI", address: "0x0000000000000000000000000000000000000004" }] } }), /It has mixed debt/],
    ["collateral-only", liveAaveLoan({ debt: { asset: "USD", amount: 0, usd: 0 }, healthFactor: null, onchain: { market: { kind: "address", value: "0x0000000000000000000000000000000000000001" }, collateral: [{ symbol: "WETH", address: "0x0000000000000000000000000000000000000002" }], debt: [] } }), /It has no debt to repay/],
    ["unknown debt amount", liveAaveLoan({ debt: { asset: "USDC", amount: null, usd: null } }), /Its debt amount could not be confirmed/],
  ])("does not treat a Base Aave %s position as Reserve-covered", async (_kind, position, reason) => {
    mockApi({ reserve: unlinked, loans: [position] });
    loanHookState.loans = [position];
    // The old sidebar shape still says Aave/USDC; eligibility must use the typed live loan view.
    renderView(null, [aaveLoan], [safe], [8453], [position]);
    expect(await screen.findByText(new RegExp(`not covered.*${String(reason).slice(1, -1)}.*Mixed-debt and collateral-only positions are not covered`, "i"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up for a future Aave loan" })).toBeTruthy();
    expect(screen.queryByLabelText("Daily limit (USDC)")).toBeNull();
  });
});

describe("r5 WP-B: the page says each thing once", () => {
  const sendable2 = (routes: Record<string, { status?: number; body: unknown }>) => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const hit = Object.entries(routes).find(([k]) => url.endsWith(k));
    const r = hit ? hit[1] : routes["/reserve"];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));

  it("the link form names both prerequisites and links to onboarding", async () => {
    mockApi({ reserve: unlinked });
    renderView();
    expect(await screen.findByText(/Before you start, the Reserve Safe needs USDC in it and the Lender agent added to it\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add the agent to a Safe" }).getAttribute("href")).toBe("/onboarding");
    openAdvancedSetup();
    expect(screen.getByText("A second Safe you own.")).toBeTruthy();
  });

  it("linked: no tiles, no developer title, the balance appears once in the panels", async () => {
    mockApi({ reserve: linked(status({ balanceUsd: 2500 })) });
    renderView();
    expect(await screen.findByText("What the agent may do")).toBeTruthy();
    expect(screen.queryByText("Policy (read from the chain)")).toBeNull();
    expect(screen.queryByText("Aave v3 on Base")).toBeNull();
    expect(screen.queryByText("Balance")).toBeNull();
    expect(screen.getByText("The Reserve Safe holds $2,500.", { selector: "span.text-xs" })).toBeTruthy();
    expect(screen.getAllByText(/\$2,500/).length).toBe(2); // the panel line and the field hint
  });

  it("editing shows what is signed now, only while the value differs", async () => {
    mockApi({ reserve: linked(status({ balanceUsd: 2500 })) });
    renderView();
    const limit = await screen.findByLabelText("Daily limit");
    expect(screen.queryByText(/Signed now/)).toBeNull();
    fireEvent.change(limit, { target: { value: "300" } });
    expect(screen.getByText("Signed now: $1,000 a day. The Reserve Safe holds $2,500.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Agent uses the reserve when health drops below"), { target: { value: "1.3" } });
    expect(screen.getByText("Signed now: 1.15. 1.00 is liquidation. Use 1.02 to 2.00.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText(/Signed now/)).toBeNull();
  });

  it("editing and discarding a fractional daily limit keeps the signed value exact", async () => {
    const v = linked();
    (v.policy as { dailyLimitUsd: number }).dailyLimitUsd = 1000.5;
    mockApi({ reserve: v });
    renderView();
    const limit = await screen.findByLabelText("Daily limit") as HTMLInputElement;
    expect(limit.value).toBe("1000.5");
    fireEvent.change(limit, { target: { value: "1200" } });
    expect(screen.getByText(/Signed now: \$1,000\.5 a day/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(limit.value).toBe("1000.5");
  });

  it("keeps exact stored trigger and limit values when fields lose focus", async () => {
    const v = linked();
    (v.policy as { dailyLimitUsd: number; triggerHf: number }).dailyLimitUsd = 1000.5;
    (v.policy as { dailyLimitUsd: number; triggerHf: number }).triggerHf = 1.234;
    mockApi({ reserve: v });
    renderView();
    const limit = await screen.findByLabelText("Daily limit") as HTMLInputElement;
    const trigger = screen.getByLabelText("Agent uses the reserve when health drops below") as HTMLInputElement;
    expect(limit.value).toBe("1000.5");
    expect(trigger.value).toBe("1.234");
    fireEvent.blur(limit);
    fireEvent.blur(trigger);
    expect(limit.value).toBe("1000.5");
    expect(trigger.value).toBe("1.234");
    expect(screen.queryByRole("button", { name: "Sign policy change" })).toBeNull();
  });

  it("warns when the chain refills the limit on a period other than a day", async () => {
    const v = linked(); v.policy.periodHours = 12;
    mockApi({ reserve: v });
    renderView();
    expect(await screen.findByText("On-chain, this limit refills every 12 h, not once a day.")).toBeTruthy();
    cleanup();
    mockApi({ reserve: linked() });
    renderView();
    await screen.findByText("What the agent may do");
    expect(screen.queryByText(/refills every/)).toBeNull();
  });

  it("a server error on a policy change says the limits are unchanged; on turn-off it shows the server's text", async () => {
    sendable2({ "/reserve": { body: linked() }, "/reserve/policy": { status: 500, body: { error: "Something went wrong" } }, "/reserve/off": { status: 500, body: { error: "Something went wrong" } } });
    renderView();
    fireEvent.change(await screen.findByLabelText("Daily limit"), { target: { value: "800" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign policy change" }));
    expect((await screen.findByRole("alert")).textContent).toBe("We could not send this change to the Reserve Safe. Your limits are unchanged. Try again.");
    cleanup();
    sendable2({ "/reserve": { body: linked() }, "/reserve/off": { status: 500, body: { error: "Something went wrong" } } });
    renderView();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Sign to turn off" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong");
  });
});

describe("BP-43: turn off and change the policy in the app", () => {
  const sendable = (routes: Record<string, unknown>) => {
    const calls: { url: string; body?: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = Object.entries(routes).find(([k]) => url.endsWith(k));
      return new Response(JSON.stringify(hit ? hit[1] : routes.reserve), { status: 200 });
    }));
    return calls;
  };

  it("Turn off calls the immediate-stop endpoint, then shows the revoke proposal link", async () => {
    const calls = sendable({
      "/reserve": linked(),
      "/reserve/off": { sentence: "The agent has stopped using the reserve. The permission on-chain is still active until the Reserve Safe signs the removal.", link: "https://app.safe.global/queue", changeId: "c1" },
    });
    renderView();
    fireEvent.click(await screen.findByRole("switch"));
    expect(screen.getByText("Needs a Reserve Safe signature")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign to turn off" }));
    expect(await screen.findByText(/The agent has stopped using the reserve\./)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/reserve/off") && c.body?.chainId === 8453)).toBe(true);
    expect(screen.getAllByRole("link", { name: /Open in Safe/ }).map((a) => a.getAttribute("href"))).toContain("https://app.safe.global/queue");
  });

  it("Change limit and trigger sends only what changed, as typed", async () => {
    const calls = sendable({
      "/reserve": linked(),
      "/reserve/policy": { summary: "Sign in the Reserve Safe to change the limit to 800 USDC per day. Nothing changes until it executes.", link: "https://app.safe.global/queue", changeId: "c2" },
    });
    renderView();
    const limit = await screen.findByLabelText("Daily limit");
    fireEvent.change(limit, { target: { value: "800" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign policy change" }));
    expect(await screen.findByText(/Nothing changes until it executes/)).toBeTruthy();
    const post = calls.find((c) => c.url.endsWith("/reserve/policy"))!;
    expect(post.body).toEqual({ chainId: 8453, dailyLimitUsd: "800" });
  });

  it("blocks an invalid trigger and has no controls to turn a Reserve that is off back on", async () => {
    sendable({ "/reserve": linked() });
    renderView();
    fireEvent.change(await screen.findByLabelText("Agent uses the reserve when health drops below"), { target: { value: "1.01" } });
    expect((screen.getByRole("button", { name: "Sign policy change" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    sendable({ "/reserve": linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Turning off: waiting for the owners to revoke the role in Safe" })) });
    renderView();
    expect(await screen.findByText("Turning off: waiting for the owners to revoke the role in Safe")).toBeTruthy();
    expect(screen.getByRole("switch").hasAttribute("disabled") || screen.getByRole("switch").getAttribute("data-disabled") !== null).toBe(true);
  });

  it("a failed read shows a titled error with Try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    renderView();
    expect(await screen.findByRole("heading", { name: "Something went wrong on our side" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Nothing on your Safe has changed.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("reserve eligibility and restoration", () => {
  it("does not query the Base-only reserve endpoint for an Arbitrum-only Safe", async () => {
    const calls = mockApi({ reserve: unlinked });
    const arbSafe = { ...safe, networks: [{ id: "arbitrum" as const, deployed: true, agent: true }] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ShellProvider safe={arbSafe} safes={[arbSafe]} loans={[]} agentOn watching><ReserveView address="0xabc" /></ShellProvider></QueryClientProvider>);
    expect(await screen.findByText(/Reserve protection works only for Aave loans on Base/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("explains Morpho coverage first and requires an explicit future-loan setup choice", async () => {
    mockApi({ reserve: unlinked });
    const known: Safe = { ...safe, id: "s2", name: "Savings Safe", address: RESERVE };
    renderView(null, [{ ...aaveLoan, venue: "Morpho Blue" }], [safe, known]);
    expect(await screen.findByText(/Your current Morpho Blue position is not covered. It is not a Base Aave loan. Reserve protection only covers Base Aave loans with one USDC debt and collateral./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up for a future Aave loan" })).toBeTruthy();
    expect(screen.queryByLabelText("Daily limit (USDC)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up for a future Aave loan" }));
    expect(await screen.findByLabelText("Daily limit (USDC)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Savings Safe" })).toBeTruthy();
    expect((screen.getByLabelText("Reserve Safe address").closest("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("lets the borrower choose a known Base Safe while keeping address entry available", async () => {
    mockApi({ reserve: unlinked });
    const known: Safe = { ...safe, id: "s2", name: "Savings Safe", address: RESERVE };
    renderView(null, [aaveLoan], [safe, known]);
    await screen.findByText(/A small second Safe holds USDC/);
    expect(screen.getByRole("button", { name: "Savings Safe" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Savings Safe" }));
    expect(screen.getByLabelText("Daily limit (USDC)")).toBeTruthy();
    expect((screen.getByLabelText("Exact health trigger (default 1.15)").closest("details") as HTMLDetailsElement).open).toBe(false);
    openAdvancedSetup();
    expect((screen.getByLabelText("Reserve Safe address") as HTMLInputElement).value).toBe(RESERVE);
    expect(screen.getByLabelText("Exact health trigger (default 1.15)")).toBeTruthy();
    expect(screen.getByText(/By default, the agent waits until your Aave loan is close to liquidation/)).toBeTruthy();
  });

  it("keeps manual Safe address entry available when the account list is empty", async () => {
    mockApi({ reserve: unlinked });
    renderView(null, [aaveLoan]);
    expect(await screen.findByText(/No other Base Safe is available here/)).toBeTruthy();
    expect((screen.getByLabelText("Reserve Safe address").closest("details") as HTMLDetailsElement).open).toBe(false);
    openAdvancedSetup();
    expect(screen.getByLabelText("Reserve Safe address")).toBeTruthy();
  });

  it("shows why a selected Reserve Safe cannot be used without opening advanced setup", async () => {
    mockApi({
      reserve: unlinked,
      check: () => ({ reserve: RESERVE, balanceUsd: 5000, errors: { reserve: "Add the Lender agent to this Safe before linking it." }, copy: copyOf(1000) }),
    });
    const known: Safe = { ...safe, id: "s2", name: "Savings Safe", address: RESERVE };
    renderView(null, [aaveLoan], [safe, known]);
    await screen.findByText(/A small second Safe holds USDC/);
    fireEvent.click(screen.getByRole("button", { name: "Savings Safe" }));
    expect(await screen.findByText("Add the Lender agent to this Safe before linking it.")).toBeTruthy();
    expect((screen.getByLabelText("Reserve Safe address").closest("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("offers fresh setup after the role is confirmed removed and keeps the old values for review", async () => {
    const off = linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Off: the agent only suggests. Nothing moves without your signature." }));
    (off.policy as { dailyLimitUsd: number }).dailyLimitUsd = 1000.5;
    (off.policy as { executorIsMember: boolean }).executorIsMember = false;
    off.revocationConfirmed = true;
    const calls = mockApi({
      reserve: off,
      check: (b) => ({ reserve: RESERVE, balanceUsd: 5000, errors: {}, copy: copyOf(b.dailyLimitUsd) }),
      link: () => ({ proposalId: "p2", stage: "queued", receipt: null, reserve: RESERVE, roles: RESERVE, executor: RESERVE }),
    });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Set up protection again" }));
    openAdvancedSetup();
    expect((await screen.findByLabelText("Reserve Safe address") as HTMLInputElement).value).toBe(RESERVE);
    expect((screen.getByLabelText("Daily limit (USDC)") as HTMLInputElement).value).toBe("1000.5");
    expect((screen.getByLabelText("Exact health trigger (default 1.15)") as HTMLInputElement).value).toBe("1.15");
    expect(screen.getByText(/Protection stays off until the new setup executes/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/reserve") && c.body).length).toBe(0);
  });

  it("does not offer a new setup while revoke is pending or to a non-owner", async () => {
    const pending = { ...linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Turning off: waiting for the owners to revoke the role in Safe" })), revoke: { text: "Sign to remove", link: "https://app.safe.global/queue" } };
    // Use a fresh query client to replace the API result for each state.
    mockApi({ reserve: pending });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><ReserveView address="0xabc" /></ShellProvider></QueryClientProvider>);
    await screen.findByText("Sign to remove");
    expect(screen.queryByRole("button", { name: "Set up protection again" })).toBeNull();
    cleanup();
    const confirmed = linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Off: the agent only suggests. Nothing moves without your signature." }));
    (confirmed.policy as { executorIsMember: boolean }).executorIsMember = false;
    confirmed.revocationConfirmed = true;
    confirmed.viewerIsReserveOwner = false;
    mockApi({ reserve: confirmed });
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc2}><ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><ReserveView address="0xabc" /></ShellProvider></QueryClientProvider>);
    await screen.findByText("Agent's reserve key");
    expect(screen.queryByRole("button", { name: "Set up protection again" })).toBeNull();
  });

  it("offers a fresh restore after the previous replacement setup was rejected", async () => {
    const rejected = {
      ...linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Off: the agent only suggests. Nothing moves without your signature." })),
      revocationConfirmed: true,
      setup: { proposalId: "p-rejected", stage: "rejected", link: "https://app.safe.global/queue", queueLink: "https://app.safe.global/queue" },
    };
    mockApi({ reserve: rejected });
    renderView();
    expect(await screen.findByRole("button", { name: "Set up protection again" })).toBeTruthy();
  });

  it("updates the switch when a policy becomes active while the page stays open", async () => {
    const off = linked(status({ kind: "paused", label: "Off", tone: "muted", banner: "Off: the agent only suggests. Nothing moves without your signature." }));
    off.policy.executorIsMember = false;
    mockApi({ reserve: off });
    renderView();
    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const active = linked();
    lastQueryClient.setQueryData(["reserve", "0xabc"], active);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });
});
