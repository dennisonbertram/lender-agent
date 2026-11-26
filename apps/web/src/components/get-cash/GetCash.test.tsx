// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Safe } from "@/lib/types";
import type { GetCashResponse } from "@/server/blocks/get-cash";
import type { QuoteResponse } from "@/server/quote";
import { ShellProvider } from "@/components/shell/ShellContext";
import { takeApproveIntent } from "@/client/approve-intent";
import { GetCash } from "./GetCash";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: () => "/s/0xabc/get-cash", useRouter: () => ({ push }) }));
vi.mock("@/components/chat/ProposalCardSlot", () => ({ ProposalCardSlot: (p: { proposalId: string }) => <div data-testid="slot">{p.proposalId}</div> }));
vi.mock("@/components/agent/AgentOffNotice", () => ({
  AddAgentAction: ({ only, onAdded }: { only?: number; onAdded?: () => void }) => (
    <button type="button" data-testid={`add-agent-${only}`} onClick={() => {
      if (cancelAgentGrant) return;
      agentNetworks = agentNetworks.map((n) => n.chainId === only ? { ...n, added: true } : n);
      onAdded?.();
    }}>
      Add Lender agent on {only === 42161 ? "Arbitrum" : "Base"}
    </button>
  ),
}));

const safe: Safe = { id: "s1", name: "Treasury", address: "0xabc", threshold: "2 of 3", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} };
const stamp = { blockNumber: 9, readAt: 1 };
const level = (idx: 0 | 1 | 2, title: string, hf: number, over = {}) => ({ idx, title, hf, feasible: true, collateral: 6 + idx, dropPct: 40 - idx * 10, ...over });
const row = (venueId: string, lender: string, over = {}) => ({ venueId, lender, feasible: true, apr: 3.4, yearly: 340, dropPct: 37, status: "healthy" as const, ...over });

const gc = (over: Partial<GetCashResponse> = {}): GetCashResponse => ({
  ...stamp, state: "ok", maxCash: 9000, chips: [{ label: "$5,000", amount: 5000 }], holdings: [{ asset: "ETH", balance: 8, usd: 24000 }, { asset: "WBTC", balance: 0.1, usd: 6000 }],
  asset: "ETH", balance: 8, levels: [level(0, "Extra safe", 2), level(1, "Balanced", 1.6), level(2, "Lean", 1.35)],
  lenders: [row("morpho", "Morpho Blue", { apr: 2.9, yearly: 290 }), row("aave-v3", "Aave v3"), row("spark", "Spark", { feasible: false, reason: "Can lend up to $6,000 against your ETH." })], best: "morpho",
  network: "base", chainId: 8453, networkName: "Base", otherFunded: [], unread: [], ...over,
});
const arbCashData = gc({ network: "arbitrum", chainId: 42161, networkName: "Arbitrum", otherFunded: [{ network: "base", chainId: 8453, name: "Base", maxCash: 9000 }] });
const quote = (over: Partial<QuoteResponse> = {}): QuoteResponse => ({
  status: "ok", chainId: 8453, network: "base", venueId: "morpho", ...stamp, cash: 5000, maxCash: 9000,
  quote: { kind: "ok", cash: 5000, borrowAsset: "USDC", asset: "ETH", collateral: 2.09, collateralUsd: 6270, price: 3000, liqPrice: 1930, dropPct: 36, adding: false, apr: 2.9, yearly: 145, feesLine: "One-time network fee: about $0.04 to set up the loan.", lender: "Morpho Blue", network: "Base" },
  costLine: "It costs about $145 a year at today's 2.9% rate.", testRun: { line: "Checked: this would work.", canSend: true }, draft: { live: true, draftKey: "k1" }, ...over,
});

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let cashData: GetCashResponse, arbitrumData: GetCashResponse, stage: string, open: unknown[], loansData: unknown[];
let agentNetworks: { chainId: number; deployed: boolean; added: boolean }[], failAgent: boolean, cancelAgentGrant: boolean;
let sendStage: string, proposalFacts: unknown, quoteDraft: Record<string, unknown>, slowCash: number | null, release: (() => void) | null, draftSending: boolean;
let proposalChain: number, holdGetCash: boolean, releaseGetCash: (() => void) | null, failArb: boolean, failBase: boolean;
const posted = () => f.mock.calls.filter(([u, i]) => String(u).endsWith("/proposals") && (i as RequestInit | undefined)?.method === "POST").map(([, i]) => JSON.parse(String((i as RequestInit).body)));
const facts = (cash: number, asset = "ETH") => ({ changes: [{ label: "You receive", amount: `+${cash.toLocaleString("en-US")} USDC`, tone: "in" }, { label: "You lock up", amount: `−2.09 ${asset}`, tone: "out" }], terms: [], sentence: "" });
const f = vi.fn();
beforeEach(() => {
  sendStage = "queued"; proposalFacts = facts(5000); quoteDraft = { live: true, draftKey: "k1" }; slowCash = null; release = null; draftSending = false;
  proposalChain = 8453; holdGetCash = false; releaseGetCash = null; failArb = false; failBase = false;
  agentNetworks = [{ chainId: 8453, deployed: true, added: true }, { chainId: 42161, deployed: true, added: true }];
  failAgent = false;
  cancelAgentGrant = false;
  cashData = gc(); arbitrumData = arbCashData; stage = "queued"; open = []; loansData = [{ id: "8453:0xabc:morpho" }]; push.mockReset(); sessionStorage.clear();
  f.mockReset();
  f.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/agent")) return failAgent ? json({ error: "Agent status unavailable." }, 503) : json({ agentAddress: "0x00000000000000000000000000000000000000a1", networks: agentNetworks, active: agentNetworks.some((n) => n.added), otherChainIds: [] });
    if (u.includes("/proposals/list")) return json({ proposals: open });
    if (u.includes("/get-cash")) {
      if (failArb && u.includes("network=arbitrum")) return json({ error: "Couldn't read." }, 500);
      if (failBase && u.includes("network=base")) return json({ error: "Couldn't read." }, 500);
      if (holdGetCash && u.includes("network=arbitrum")) return new Promise<Response>((res) => { releaseGetCash = () => res(new Response(JSON.stringify(arbCashData), { status: 200, headers: { "content-type": "application/json" } })); });
      return json(u.includes("network=arbitrum") ? arbitrumData : cashData);
    }
    if (u.endsWith("/quote")) {
      const b = JSON.parse(String(init?.body ?? "{}"));
      const v = b.venueId;
      const chainId = b.chainId ?? 8453;
      const network = chainId === 42161 ? "arbitrum" : "base";
      const networkName = chainId === 42161 ? "Arbitrum" : "Base";
      const withNetwork = (q: QuoteResponse): QuoteResponse => ({ ...q, chainId, network, quote: { ...q.quote, network: networkName } as QuoteResponse["quote"] });
      if (slowCash !== null && b.cash === slowCash) return new Promise<Response>((res) => { release = () => res(new Response(JSON.stringify(quote({ cash: b.cash, quote: { ...quote().quote, cash: b.cash } as QuoteResponse["quote"] })), { status: 200, headers: { "content-type": "application/json" } })); });
      if (v === "aave-v3") return json(withNetwork(quote({ venueId: "aave-v3", quote: { ...quote().quote, lender: "Aave v3", apr: 3.4, yearly: 170 } as QuoteResponse["quote"] })));
      return json(withNetwork(quote({ draft: quoteDraft as QuoteResponse["draft"] })));
    }
    if (u.endsWith("/proposals") && init?.method === "POST") { if (sendStage === "sending") quoteDraft = { live: true, draftKey: "k1", ...(draftSending ? { sendingId: "p1" } : { sentId: "p1" }) }; return json({ proposalId: "p1", stage: sendStage, receipt: "Sent to your Safe: borrow $5,000 from Morpho Blue." }, 201); }
    if (u.endsWith("/proposals/p1")) return json({ proposal: { id: "p1", stage, final: stage === "executed", chainId: proposalChain, facts: proposalFacts, ...(stage === "executed" ? { loanId: `${proposalChain}:0xabc:morpho` } : {}) } });
    if (u.endsWith("/loans")) return json({ loans: loansData, balancesByNetwork: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", f);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const show = (agentOn = true) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShellProvider safe={{ ...safe, networks: safe.networks.map((n) => ({ ...n, agent: agentOn })) }} safes={[safe]} loans={[]} agentOn={agentOn} watching={agentOn}><GetCash address="0xabc" /></ShellProvider>
  </QueryClientProvider>,
);
const input = () => screen.findByLabelText("Cash you need") as Promise<HTMLInputElement>;
const type = async (t: string) => fireEvent.change(await input(), { target: { value: t } });
/** Types $5,000; the plan appears under the amount on the same screen. */
async function toPlan() {
  await type("5000");
  await screen.findByText("You lock 2.09 ETH ($6,270).");
}
const approve = () => screen.getByRole("button", { name: /^Approve .*in your wallet/ }) as HTMLButtonElement;
const openOptions = () => fireEvent.click(screen.getByText(/^Options/));
/** Points the /proposals/p1 fetch at a given proposal for the sent view. */
const sentProposal = (over: Record<string, unknown>) => {
  const base = f.getMockImplementation()!;
  f.mockImplementation((url: string, init?: RequestInit) => String(url).endsWith("/proposals/p1")
    ? json({ proposal: { id: "p1", stage: "queued", final: false, chainId: 8453, facts: proposalFacts, links: { tx: null, queue: null }, createdAt: "2026-11-23T19:23:00Z", ...over } })
    : base(url, init));
};

describe("Get cash: VC-02 / VC-07 / VC-04", () => {
  it("shows the quote network monitor state and notes that checks can be delayed", async () => {
    agentNetworks = [{ chainId: 8453, deployed: true, added: false }, { chainId: 42161, deployed: true, added: false }];
    show(false);
    await toPlan();
    const planRows = screen.getAllByRole("listitem").map((row) => row.textContent ?? "").join(" ");
    expect(planRows).toContain("Monitoring on Base: not enabled.");
    expect(planRows).toContain("Safe status: Not watching this Safe.");
    expect(planRows).toContain("In-app alerts are available when monitoring is active.");
    expect(planRows).toContain("Checks may be delayed or unavailable.");
  });

  it("reports monitoring on the selected Arbitrum quote network without a Base label", async () => {
    const mixedNetworks = { ...safe, networks: [{ id: "base" as const, deployed: true, agent: false }, { id: "arbitrum" as const, deployed: true, agent: true }] };
    cashData = arbCashData;
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ShellProvider safe={mixedNetworks} safes={[mixedNetworks]} loans={[]} agentOn={true} watching={true}><GetCash address="0xabc" /></ShellProvider></QueryClientProvider>);
    await toPlan();
    const monitorRow = screen.getAllByRole("listitem").map((row) => row.textContent ?? "").find((row) => row.includes("Monitoring on Arbitrum")) ?? "";
    expect(monitorRow).toContain("Monitoring on Arbitrum: enabled.");
    expect(monitorRow).toContain("Safe status: Ready. No loans to watch yet.");
    expect(monitorRow).not.toContain("Base");
  });
  it("updates selected-network monitoring only after the delegate grant is confirmed", async () => {
    const mixedNetworks = { ...safe, networks: [{ id: "base" as const, deployed: true, agent: false }, { id: "arbitrum" as const, deployed: true, agent: false }] };
    cashData = arbCashData;
    agentNetworks = [{ chainId: 8453, deployed: true, added: false }, { chainId: 42161, deployed: true, added: false }];
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ShellProvider safe={mixedNetworks} safes={[mixedNetworks]} loans={[]} agentOn={false} watching={false}><GetCash address="0xabc" /></ShellProvider></QueryClientProvider>);
    await toPlan();
    const monitorLine = () => screen.getAllByRole("listitem").map((row) => row.textContent ?? "").find((row) => row.includes("Monitoring on Arbitrum")) ?? "";
    expect(monitorLine()).toContain("Monitoring on Arbitrum: not enabled.");
    cancelAgentGrant = true;
    fireEvent.click(screen.getByTestId("add-agent-42161"));
    expect(monitorLine()).toContain("Monitoring on Arbitrum: not enabled.");
    cancelAgentGrant = false;
    fireEvent.click(screen.getByTestId("add-agent-42161"));
    await waitFor(() => expect(monitorLine()).toContain("Monitoring on Arbitrum: enabled."));
    expect(monitorLine()).toContain("Safe status: Not watching this Safe.");
  });
  it("does not guess monitoring is disabled when the selected network is missing from a successful status read", async () => {
    const mixedNetworks = { ...safe, networks: [{ id: "base" as const, deployed: true, agent: false }, { id: "arbitrum" as const, deployed: true, agent: true }] };
    cashData = arbCashData;
    agentNetworks = [{ chainId: 8453, deployed: true, added: false }];
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ShellProvider safe={mixedNetworks} safes={[mixedNetworks]} loans={[]} agentOn={true} watching={true}><GetCash address="0xabc" /></ShellProvider></QueryClientProvider>);
    await toPlan();
    const monitorLine = screen.getAllByRole("listitem").map((row) => row.textContent ?? "").find((row) => row.includes("Monitoring on Arbitrum")) ?? "";
    expect(monitorLine).toContain("Monitoring on Arbitrum: could not check.");
  });
  it("placeholder never shows a number", async () => {
    show();
    expect((await input()).placeholder).toBe("Amount in dollars");
  });
  it("shows the Why line under the amount hint, from the server's sentence", async () => {
    cashData = gc({ why: "Why $9,000? It is the most you can borrow against your ETH at the Balanced safety level, from Morpho Blue, the lender that allows the most." });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Why $9,000?" }));
    expect(screen.getByText(/^It is the most you can borrow against your ETH/)).toBeTruthy();
  });
  it("no Why line when the server sends none", async () => {
    show();
    await input();
    expect(screen.queryByRole("button", { name: /^Why/ })).toBeNull();
  });
  it("switching lender shows one Was/now note; switching back removes it", async () => {
    show();
    await toPlan();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    expect(screen.queryByText(/^Was about/)).toBeNull();
    fireEvent.click(screen.getByText("Aave v3 · 3.4% · about $340 a year"));
    expect(await screen.findByText("Was about $145 a year at 2.9% with Morpho Blue; now about $170 a year at 3.4% with Aave v3.")).toBeTruthy();
    expect(screen.getAllByText(/^Was about/)).toHaveLength(1);
    fireEvent.click(await screen.findByText(/^Morpho Blue · 2.9%/));
    await waitFor(() => expect(screen.queryByText(/^Was about/)).toBeNull());
  });
  it("sent view has one heading and no separate sent line", async () => {
    show();
    await toPlan();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(approve());
    await screen.findByTestId("slot");
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Next: approve it here"]);
    expect(screen.getByRole("link", { name: "Next: approve it here" }).getAttribute("href")).toMatch(/\/proposals\/p1$/);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/^Sent to your Safe: borrow \$5,000/)).toBeTruthy();
  });
  it("sent view says who must sign and leaves the approval action in the embedded review", async () => {
    const base = f.getMockImplementation()!;
    f.mockImplementation((url: string, init?: RequestInit) => String(url).endsWith("/proposals/p1")
      ? json({ proposal: { id: "p1", stage: "queued", final: false, threshold: 2, needsSignatures: 2, inSafe: true, createdAt: "2026-11-23T19:23:00Z", links: { tx: "https://app.safe.global/tx", queue: "https://app.safe.global/queue" }, owners: [{ address: "0x1111111111111111111111111111111111111111", signed: false, isYou: true }, { address: "0x2222222222222222222222222222222222222222", signed: false, isYou: false }] } })
      : base(url, init));
    show();
    await toPlan();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(approve());
    const who = await screen.findByTestId("who-signs");
    expect(who.textContent).toMatch(/Waiting for 2 more approvals: You, 0x2222…2222/);
    expect(screen.queryByRole("link", { name: "Approve in your wallet" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open in Safe" })).toBeNull();
  });
  it("does not add a second approval CTA beside the embedded proposal review", async () => {
    sentProposal({ state: "needs_your_signature", signedCount: 1, needsSignatures: 1, canSign: true, threshold: 2, inSafe: true });
    show();
    await toPlan();
    fireEvent.click(approve());
    await screen.findByTestId("slot");
    expect(screen.queryByRole("link", { name: "Approve in your wallet" })).toBeNull();
  });
  it("shows the Safe address with a copy button above the amount", async () => {
    show();
    await input();
    expect(screen.getByTestId("safe-identity").textContent).toContain("Base");
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
  });
  it("a failed read uses StateMessage with Try again", async () => {
    f.mockImplementation(() => json({ error: "boom" }, 500));
    show();
    const alert = await screen.findByRole("alert");
    // useGetCash throws an ApiError, so a 500 reads as a server problem, not as offline.
    expect(alert.textContent).toMatch(/Something went wrong on our side/);
    expect(alert.textContent).toMatch(/Nothing on your Safe has changed\./);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("Get cash: amount", () => {
  it("hints, then holds back the plan with the amount rules' messages", async () => {
    show();
    expect(await screen.findByText("With what's in this Safe you can borrow $10 to $9,000.")).toBeTruthy();
    await type("abc");
    expect(screen.getByText("Use numbers only, for example $5,000.")).toBeTruthy();
    await type("5");
    expect(screen.getByText("The smallest loan is $10.")).toBeTruthy();
    expect(screen.queryByText(/^You lock/)).toBeNull();
    await type("20000");
    expect(screen.getByText("That's more than this Safe can safely borrow against. The most is $9,000.")).toBeTruthy();
    expect(screen.queryByText(/^You lock/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use $9,000" }));
    expect((await input()).value).toBe("$9,000");
    await screen.findByText("You lock 2.09 ETH ($6,270).");
  });
  it("offers only the server's chips, none above the maximum", async () => {
    show();
    await input();
    const chips = screen.getAllByRole("button").map((b) => b.textContent).filter((t) => /^\$/.test(t ?? ""));
    expect(chips).toEqual(["$5,000"]);
    fireEvent.click(screen.getByRole("button", { name: "$5,000" }));
    expect((await input()).value).toBe("$5,000");
  });
  it("over the maximum: one chip carries the maximum, not also the server's \"Up to\" chip", async () => {
    cashData = gc({ chips: [{ label: "$5,000", amount: 5000 }, { label: "Up to $9,000", amount: 9000 }] });
    show();
    await type("20000");
    await screen.findByText(/The most is \$9,000/);
    const chips = screen.getAllByRole("button").map((b) => b.textContent).filter((t) => /\$9,000/.test(t ?? ""));
    expect(chips).toEqual(["Use $9,000"]);
    expect(screen.getByRole("button", { name: "$5,000" })).toBeTruthy();
  });
  it("empty Safe: add funds and a way home", async () => {
    cashData = gc({ state: "empty", maxCash: 0, chips: [], holdings: [], asset: null, balance: 0, levels: [], lenders: [], best: null });
    show();
    expect(await screen.findByText("Add ETH or wstETH to this Safe first.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Safe home" }).getAttribute("href")).toBe("/s/0xabc");
    expect(screen.getByText(/Send ETH or wstETH on Base to this address/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
  });
  it("too little: says the Safe can't borrow the smallest loan", async () => {
    cashData = gc({ state: "tooLittle", maxCash: 100, chips: [], levels: [], lenders: [], best: null });
    show();
    expect(await screen.findByText("This Safe doesn't hold enough to borrow $10 safely.")).toBeTruthy();
  });
});

const waiting = (id: string, title: string, over = {}) => ({ id, title, stage: "queued", state: "needs_your_signature", final: false, createdAt: "2026-01-01T00:00:00.000Z", ...over });

describe("Get cash: a loan already waiting", () => {
  it("offers to finish the open request first and hides the planner", async () => {
    open = [waiting("p1", "Open a $1,000 Morpho loan")];
    show();
    const finish = await screen.findByRole("link", { name: "Finish your open request" });
    expect(finish.getAttribute("href")).toBe("/s/0xabc/proposals/p1");
    expect(screen.getByText("Open a $1,000 Morpho loan")).toBeTruthy();
    expect(screen.queryByLabelText("Cash you need")).toBeNull();
    expect(screen.getByText("Your open request stays until it is rejected. Both could be signed and run.")).toBeTruthy();
  });
  it("Start a different plan anyway reveals the planner", async () => {
    open = [waiting("p1", "Open a $1,000 Morpho loan")];
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Start a different plan anyway" }));
    await type("5000");
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    expect(screen.getByRole("link", { name: "Finish your open request" })).toBeTruthy();
  });
  it("shows nothing for drafts only", async () => {
    open = [waiting("p1", "Open a $1,000 Morpho loan", { stage: "draft" })];
    show();
    await input();
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes("/proposals/list"))).toBe(true));
    expect(screen.queryByRole("link", { name: "Finish your open request" })).toBeNull();
  });
  it("with several, the primary button is the newest and every one is listed", async () => {
    open = [waiting("p1", "Old one"), waiting("p2", "Newest one", { createdAt: "2026-02-01T00:00:00.000Z" }), waiting("p3", "Middle", { createdAt: "2026-01-15T00:00:00.000Z" })];
    show();
    expect((await screen.findByRole("link", { name: "Finish your open request" })).getAttribute("href")).toBe("/s/0xabc/proposals/p2");
    expect(screen.getByRole("link", { name: "Old one" }).getAttribute("href")).toBe("/s/0xabc/proposals/p1");
    expect(screen.getByRole("link", { name: "Middle" }).getAttribute("href")).toBe("/s/0xabc/proposals/p3");
  });
  it("a fully approved request says Ready to send, never 'waiting for signatures'", async () => {
    open = [waiting("p1", "Open a $1,000 Morpho loan", { state: "ready_to_send", signedCount: 2, needsSignatures: 0 })];
    show();
    expect(await screen.findByText("Both approved. Ready to send")).toBeTruthy();
    expect(screen.queryByText(/waiting for signatures/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Finish your open request" }).getAttribute("href")).toBe("/s/0xabc/proposals/p1");
  });
  it("a request waiting on the co-owner says who, not 'needs you'", async () => {
    open = [waiting("p1", "Open a $1,000 Morpho loan", { state: "waiting_for_others", signedCount: 1, needsSignatures: 1, viewerSigned: true })];
    show();
    expect(await screen.findByText("Waiting for your co-owner")).toBeTruthy();
    expect(screen.queryByText(/Your approval is needed|waiting for signatures/i)).toBeNull();
  });
});

describe("Get cash: one screen", () => {
  it("has no step bar and no Next button; the plan and one primary button sit under the amount", async () => {
    show();
    await toPlan();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByText("Amount")).toBeNull();
    expect(screen.queryByText("Plan")).toBeNull();
    expect(screen.getByRole("button", { name: "$5,000" })).toBeTruthy();
    expect(approve().textContent).toBe("Approve in your wallet");
    expect(screen.getByText("Sends this plan to your Safe, then your wallet asks for your free approval.")).toBeTruthy();
  });
  it("options are closed by default and the label sums up the choice", async () => {
    show();
    await toPlan();
    const d = screen.getByText(/^Options/).closest("details")!;
    expect(d.open).toBe(false);
    expect(screen.getByText(/^Options/).textContent).toMatch(/ETH.*balanced.*about a year.*best lender/i);
    expect(d.textContent).toContain("How careful should we be?");
  });
  it("says what the Safe already owes", async () => {
    loansData = [{ id: "a", debt: { asset: "USDC", amount: 1000, usd: 1000 } }, { id: "b", debt: { asset: "USDC", amount: 500, usd: 500 } }];
    show();
    expect(await screen.findByText(/On top of your \$1,500 loan/)).toBeTruthy();
  });
  it("no loan line without a loan", async () => {
    loansData = [];
    show();
    await input();
    expect(screen.queryByText(/On top of your/)).toBeNull();
  });
  it("the move plan names the two steps on the button", async () => {
    const q = quote();
    f.mockImplementation(((base) => (url: string, init?: RequestInit) => String(url).endsWith("/quote") ? json({ ...q, quote: { ...q.quote, move: { line: "First I move 1 ETH." } } }) : base(url, init))(f.getMockImplementation()!));
    show();
    await type("5000");
    expect(await screen.findByRole("button", { name: "Approve move in your wallet (step 1 of 2)" })).toBeTruthy();
  });
  it("after the send is queued: marks the approve intent and opens the proposal page", async () => {
    show();
    await toPlan();
    fireEvent.click(approve());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    expect(takeApproveIntent("p1")).toBe(true);
  });
});

describe("Get cash: plan", () => {
  it("prints the quote's figures, the safety cards (disabled one says what it needs) and the other lenders", async () => {
    cashData = gc({ levels: [level(0, "Extra safe", 2, { feasible: false, collateral: undefined, dropPct: undefined, needs: 9.5 }), level(1, "Balanced", 1.6), level(2, "Lean", 1.35)] });
    show();
    await toPlan();
    expect(await screen.findByText(/^You get \$5,000 as USDC, a digital dollar, in/)).toBeTruthy();
    expect(screen.getByText("You lock 2.09 ETH ($6,270).")).toBeTruthy();
    expect(screen.getByText(/^It costs about \$145 a year at today's 2.9% rate\. With Morpho Blue, the lowest rate that fits\. One-time network fee/)).toBeTruthy();
    expect(screen.getByText("Aave v3 · 3.4% · about $340 a year")).toBeTruthy();
    expect(screen.getByText("Spark · Can lend up to $6,000 against your ETH.")).toBeTruthy();
    openOptions();
    expect(screen.getByText("Needs 9.5 ETH, you have 8.")).toBeTruthy();
    expect((screen.getByLabelText(/Extra safe/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Locks 7.00 ETH of your 8.")).toBeTruthy();
    expect(screen.getByText(/Monitoring can be delayed or unavailable/)).toBeTruthy();
    // the summary is stated once: not repeated in the sticky bar
    expect(screen.getAllByText(/The lender could sell some of your ETH if its price falls to about \$1,930 \(36% below today's \$3,000\)\./)).toHaveLength(1);
  });
  it("choosing another lender and a safety level re-quotes the same draft", async () => {
    show();
    await toPlan();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(screen.getByText("Aave v3 · 3.4% · about $340 a year"));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u).endsWith("/quote") && JSON.parse(i.body).venueId === "aave-v3")).toBe(true));
    openOptions();
    fireEvent.click(screen.getByLabelText(/Lean/));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u).endsWith("/quote") && JSON.parse(i.body).hfIdx === 2 && /^get-cash-/.test(JSON.parse(i.body).messageId))).toBe(true));
  });
});

describe("Get cash: Send", () => {
  it("a capped quote is not sent until the owner clicks Use $X, which updates the input", async () => {
    const base = f.getMockImplementation()!;
    f.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/quote")) {
        const b = JSON.parse(String(init?.body ?? "{}"));
        const cash = Math.min(b.cash, 3000);
        return json(quote({ cash, quote: { ...quote().quote, cash } as QuoteResponse["quote"] }));
      }
      return base(url, init);
    });
    show();
    await type("5000");
    expect(await screen.findByText("Only $3,000 is possible with ETH")).toBeTruthy();
    expect(approve().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Use $3,000" }));
    await waitFor(() => expect((screen.getByLabelText("Cash you need") as HTMLInputElement).value).toBe("$3,000"));
    await waitFor(() => expect(approve().disabled).toBe(false));
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].cash).toBe(3000);
  });

  it("an explicit lender pick sends venueChosen with the quote and the send; the default sends none", async () => {
    show();
    await toPlan();
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].venueChosen).toBeUndefined();
    cleanup(); push.mockReset();
    show();
    await toPlan();
    fireEvent.click(screen.getByText("Aave v3 · 3.4% · about $340 a year"));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u).endsWith("/quote") && JSON.parse(i.body).venueId === "aave-v3" && JSON.parse(i.body).venueChosen === true)).toBe(true));
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    await waitFor(() => expect(approve().disabled).toBe(false));
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1]).toMatchObject({ venueId: "aave-v3", venueChosen: true });
  });

  it("shows the server's 409 when the chosen lender can no longer take the amount", async () => {
    const base = f.getMockImplementation()!;
    f.mockImplementation((url: string, init?: RequestInit) => String(url).endsWith("/proposals") && init?.method === "POST"
      ? json({ error: "Aave v3 can no longer lend $5,000. Pick another lender." }, 409)
      : base(url, init));
    show();
    await toPlan();
    fireEvent.click(approve());
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Aave v3 can no longer lend $5,000. Pick another lender.");
  });

  it("shows status only after Send, then where the money is with View loan and Get more cash", async () => {
    show();
    await toPlan();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(approve());
    expect(await screen.findByText(/^Sent to your Safe: borrow \$5,000/)).toBeTruthy();
    const post = f.mock.calls.find(([u, i]) => String(u).endsWith("/proposals") && i?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toMatchObject({ draftKey: "k1", cash: 5000, asset: "ETH", venueId: "morpho", hfIdx: 1, months: 12 });
    expect((await screen.findByTestId("slot")).textContent).toBe("p1");
    expect(screen.queryByRole("button", { name: /Send to Safe/ })).toBeNull();
    expect(screen.queryByText(/^You lock/)).toBeNull();
    expect(screen.queryByText(/Where the money is|is in Treasury/)).toBeNull();
  });
  it("when executed: the done line, a View loan link and Get more cash", async () => {
    stage = "executed";
    show();
    await toPlan();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(approve());
    expect(await screen.findByText("The 5,000 USDC is in Treasury. To pay someone or move it to your bank, send it from the Safe app.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("link", { name: "View loan" }).getAttribute("href")).toBe("/s/0xabc/loans/8453%3A0xabc%3Amorpho"));
    fireEvent.click(screen.getByRole("button", { name: "Get more cash" }));
    expect(await screen.findByText("How much cash do you need?")).toBeTruthy();
  });
  it("a fully approved sent plan says Ready to send — never 'waiting'", async () => {
    sentProposal({ state: "ready_to_send", signedCount: 2, needsSignatures: 0, canSend: true, threshold: 2, inSafe: true, links: { tx: "https://app.safe.global/tx", queue: "https://app.safe.global/queue" } });
    show();
    await toPlan();
    fireEvent.click(approve());
    expect(await screen.findByText("Both approved. Ready to send")).toBeTruthy();
    expect(screen.queryByText(/Waiting for|waiting for signatures/i)).toBeNull();
    expect(screen.getByTestId("slot")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Review and send" })).toBeNull();
  });
  it("a failed sent plan shows the failure and leaves recovery in the embedded proposal", async () => {
    sentProposal({ stage: "failed", state: "failed", final: true, failedReason: "The transaction reverted when it ran." });
    show();
    await toPlan();
    fireEvent.click(approve());
    expect(await screen.findByText("It didn't go through")).toBeTruthy();
    expect(screen.getByText(/reverted when it ran/)).toBeTruthy();
    expect(screen.getByTestId("slot")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "See why" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Approve in your wallet" })).toBeNull();
  });
  it("a sent plan whose nonce was passed leaves the next action to the embedded proposal", async () => {
    sentProposal({ stage: "stale", state: "out_of_date", final: true, inSafe: false });
    show();
    await toPlan();
    fireEvent.click(approve());
    expect(await screen.findByText("This plan is out of date")).toBeTruthy();
    expect(screen.getByTestId("slot")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make a new plan" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Make a new plan" })).toBeNull();
  });
  it("does not offer a new plan while a stale signed plan is still in the Safe queue", async () => {
    sentProposal({ stage: "stale", state: "out_of_date", final: false, inSafe: true, signedCount: 1, needsSignatures: 0 });
    show();
    await toPlan();
    fireEvent.click(approve());
    expect(await screen.findByText(/This plan may still be in your Safe queue/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make a new plan" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Make a new plan" })).toBeNull();
    expect(screen.getByText(/may still be approved and sent/i)).toBeTruthy();
  });
  it("an executed sent plan links the proposal's own loan, not the newest one", async () => {
    sentProposal({ stage: "executed", state: "executed", final: true, loanId: "8453:0xabc:morpho" });
    loansData = [{ id: "8453:0xabc:morpho" }, { id: "newer-loan" }];
    show();
    await toPlan();
    fireEvent.click(approve());
    expect(await screen.findByRole("link", { name: "View loan" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("link", { name: "View loan" }).getAttribute("href")).toBe("/s/0xabc/loans/8453%3A0xabc%3Amorpho"));
  });
  it("a sent plan confirming on the network says so", async () => {
    sentProposal({ state: "sending", signedCount: 2, needsSignatures: 0, pendingTxHash: `0x${"ab".repeat(32)}` });
    show();
    await toPlan();
    fireEvent.click(approve());
    expect(await screen.findByText(/Sending to Base/)).toBeTruthy();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
  });
  it("a real sending row uses the server's queue-check instruction and shows no approval count", async () => {
    sentProposal({ stage: "sending", state: null, signedCount: 0, threshold: undefined, needsSignatures: 0, sentence: "Safe submission outcome is being checked. Review your Safe queue; do not send this transaction again.", links: { tx: null, queue: "https://app.safe.global/queue" } });
    show();
    await toPlan();
    fireEvent.click(approve());
    expect(await screen.findByText(/submission outcome is being checked/)).toBeTruthy();
    expect(screen.queryByText(/0 of 0 approved|Waiting for .*approval/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Check Safe queue" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Make a new plan" })).toBeNull();
  });
  it("a new plan after Send uses a fresh message id, so it never reuses the frozen draft's key (BP-34)", async () => {
    stage = "executed";
    show();
    await toPlan();
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    const ids = () => f.mock.calls.filter(([u]) => String(u).endsWith("/quote")).map(([, i]) => JSON.parse(i.body).messageId as string);
    const before = new Set(ids());
    expect(before.size).toBe(1);
    fireEvent.click(approve());
    fireEvent.click(await screen.findByRole("button", { name: "Get more cash" }));
    await type("1500");
    await waitFor(() => expect(new Set(ids()).size).toBe(2));
    const after = ids().at(-1)!;
    expect(before.has(after)).toBe(false);
  });
});

describe("Get cash: one-click handoff safety", () => {
  it("sends the chain of the quote it shows", async () => {
    show();
    await toPlan();
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].chainId).toBe(8453);
    const q = f.mock.calls.filter(([u]) => String(u).endsWith("/quote")).map(([, i]) => JSON.parse(String((i as RequestInit).body)));
    expect(q.at(-1).chainId).toBe(8453);
  });
  it("Enter right after editing the amount sends nothing until the new quote has arrived", async () => {
    show();
    await toPlan();
    slowCash = 1000;
    await type("1000");
    await waitFor(() => expect(release).not.toBeNull());
    fireEvent.submit((await input()).closest("form")!);
    expect(posted()).toHaveLength(0);
    expect(approve().disabled).toBe(true);
    release!();
    await waitFor(() => expect(approve().disabled).toBe(false));
    fireEvent.submit((await input()).closest("form")!);
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].cash).toBe(1000);
  });
  it("does not auto-approve a proposal whose cash differs from the one clicked (shared draft in two tabs)", async () => {
    proposalFacts = facts(1000);
    show();
    await toPlan();
    fireEvent.click(approve());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    expect(takeApproveIntent("p1")).toBe(false);
  });
  it("does not auto-approve a proposal on another asset", async () => {
    proposalFacts = facts(5000, "WBTC");
    show();
    await toPlan();
    fireEvent.click(approve());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    expect(takeApproveIntent("p1")).toBe(false);
  });
  it("hands off when a send that returned 'sending' later becomes queued", async () => {
    sendStage = "sending";
    show();
    await toPlan();
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    expect(takeApproveIntent("p1")).toBe(true);
  });
  it("a plan already sent when the page opened never navigates or marks", async () => {
    quoteDraft = { live: true, draftKey: "k1", sentId: "p1" };
    show();
    await type("5000");
    await screen.findByTestId("slot");
    expect(push).not.toHaveBeenCalled();
    expect(takeApproveIntent("p1")).toBe(false);
  });
  it("says how many signatures are still needed, not the total threshold", async () => {
    const base = f.getMockImplementation()!;
    f.mockImplementation((url: string, init?: RequestInit) => String(url).endsWith("/proposals/p1")
      ? json({ proposal: { id: "p1", stage: "queued", final: false, threshold: 2, needsSignatures: 1, signedCount: 1, chainId: 8453, facts: proposalFacts, inSafe: false, links: {}, owners: [{ address: "0x1111111111111111111111111111111111111111", signed: true, isYou: false }, { address: "0x2222222222222222222222222222222222222222", signed: false, isYou: true }, { address: "0x3333333333333333333333333333333333333333", signed: false, isYou: false }] } })
      : base(url, init));
    show();
    await toPlan();
    fireEvent.click(approve());
    const who = await screen.findByTestId("who-signs");
    expect(who.textContent).toMatch(/Waiting for 1 more approval: You, 0x3333…3333/);
  });
});

describe("Get cash: funded source", () => {
  it("plans, quotes and sends on Arbitrum when the server picks it, and the queued Arbitrum proposal still matches", async () => {
    cashData = arbCashData;
    proposalChain = 42161;
    show();
    const identity = await screen.findByTestId("safe-identity");
    expect(identity.textContent).toContain("Arbitrum");
    expect(identity.querySelector('img[src="/network-marks/arbitrum-one.svg"]')).toBeTruthy();
    await toPlan();
    const quotes = f.mock.calls.filter(([u]) => String(u).endsWith("/quote")).map(([, i]) => JSON.parse(String((i as RequestInit).body)));
    expect(quotes[0]).toMatchObject({ network: "arbitrum", chainId: 42161 });
    expect(await screen.findByText(/\(Arbitrum\)/)).toBeTruthy();
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toMatchObject({ network: "arbitrum", chainId: 42161 });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/s/0xabc/proposals/p1"));
    expect(takeApproveIntent("p1")).toBe(true);
  });
  it("offers the other funded source and re-plans on it when you pick it", async () => {
    cashData = gc({ otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    show();
    const useArbitrum = await screen.findByRole("button", { name: "Use Arbitrum" });
    expect(useArbitrum.querySelector('img[src="/network-marks/arbitrum-one.svg"]')).toBeTruthy();
    fireEvent.click(useArbitrum);
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes("get-cash") && String(u).includes("network=arbitrum"))).toBe(true));
    await screen.findByTestId("safe-identity");
    const identity = await screen.findByTestId("safe-identity");
    expect(identity.textContent).toContain("Arbitrum");
    expect(identity.querySelector('img[src="/network-marks/arbitrum-one.svg"]')).toBeTruthy();
    await toPlan();
    const quotes = f.mock.calls.filter(([u]) => String(u).endsWith("/quote")).map(([, i]) => JSON.parse(String((i as RequestInit).body)));
    expect(quotes.at(-1)).toMatchObject({ network: "arbitrum", chainId: 42161 });
  });
  it("switching sources from a selected asset absent there quotes and sends the available asset", async () => {
    cashData = gc({ asset: "wstETH", balance: 4, holdings: [{ asset: "wstETH", balance: 4, usd: 12000 }, { asset: "ETH", balance: 0, usd: 0 }], otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    arbitrumData = gc({ asset: "ETH", balance: 8, holdings: [{ asset: "ETH", balance: 8, usd: 24000 }], network: "arbitrum", chainId: 42161, networkName: "Arbitrum", otherFunded: [{ network: "base", chainId: 8453, name: "Base", maxCash: 9000 }] });
    show();
    await toPlan();
    openOptions();
    const assetSelect = screen.getByRole("combobox", { name: /Use:/i });
    fireEvent.change(assetSelect, { target: { value: "wstETH" } });
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes("asset=wstETH"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Use Arbitrum" }));
    await waitFor(() => expect(screen.getByTestId("safe-identity").textContent).toContain("Arbitrum"));
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes("network=arbitrum") && String(u).includes("asset=wstETH"))).toBe(true));
    await screen.findByText("You lock 2.09 ETH ($6,270).");
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    const quotes = f.mock.calls.filter(([u]) => String(u).endsWith("/quote")).map(([, i]) => JSON.parse(String((i as RequestInit).body)));
    expect(quotes.at(-1)).toMatchObject({ network: "arbitrum", chainId: 42161, asset: "ETH" });
    expect(posted()[0]).toMatchObject({ network: "arbitrum", chainId: 42161, asset: "ETH" });
  });
  it("offers Arbitrum-specific agent setup instead of an approval when only Base has the agent", async () => {
    agentNetworks = [{ chainId: 8453, deployed: true, added: true }, { chainId: 42161, deployed: true, added: false }];
    cashData = gc({ otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    show();
    await toPlan();
    fireEvent.click(screen.getByRole("button", { name: "Use Arbitrum" }));
    await waitFor(() => expect(screen.getByTestId("safe-identity").textContent).toContain("Arbitrum"));
    await screen.findByText(/Before requesting a loan on Arbitrum, add the Lender agent to this Safe on Arbitrum/);
    expect(screen.getByTestId("add-agent-42161")).toBeTruthy();
    expect(approve().disabled).toBe(true);
    fireEvent.click(approve());
    expect(posted()).toHaveLength(0);
  });
  it("fails closed if network-specific agent status cannot be checked, then recovers on retry", async () => {
    failAgent = true;
    show();
    await toPlan();
    expect(await screen.findByText(/I couldn't check whether the Lender agent is set up on Base/)).toBeTruthy();
    const monitorLine = screen.getAllByRole("listitem").map((row) => row.textContent ?? "").find((row) => row.includes("Monitoring on Base")) ?? "";
    expect(monitorLine).toContain("Monitoring on Base: could not check.");
    expect(approve().disabled).toBe(true);
    failAgent = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(approve().disabled).toBe(false));
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toMatchObject({ network: "base", chainId: 8453 });
  });
  it("names Arbitrum when the plan is empty there", async () => {
    cashData = gc({ state: "empty", network: "arbitrum", chainId: 42161, networkName: "Arbitrum", maxCash: 0, holdings: [], levels: [], lenders: [] });
    show();
    expect(await screen.findByText(/Arbitrum/)).toBeTruthy();
    expect(screen.queryByText(/WBTC/)).toBeNull();
  });
  it("says when a network could not be checked and retries it", async () => {
    cashData = gc({ unread: [{ network: "base", chainId: 8453, name: "Base" }] });
    show();
    expect(await screen.findByText(/couldn'?t check Base/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(f.mock.calls.filter(([u]) => String(u).includes("get-cash")).length).toBeGreaterThan(1));
  });
  it("never sends a stale Base send while a source switch is in flight", async () => {
    cashData = gc({ otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    show();
    await toPlan();
    holdGetCash = true;
    fireEvent.click(screen.getByRole("button", { name: /Arbitrum/ }));
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes("network=arbitrum"))).toBe(true));
    fireEvent.click(approve());
    expect(posted()).toHaveLength(0);
    releaseGetCash!();
    await waitFor(() => expect(screen.getByTestId("safe-identity").textContent).toContain("Arbitrum"));
    expect(posted()).toHaveLength(0);
  });
  it("does not allow a source switch while the current proposal is still sending", async () => {
    cashData = gc({ otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    sendStage = "sending";
    draftSending = true;
    show();
    await toPlan();
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    const useArbitrum = screen.getByRole("button", { name: "Use Arbitrum" }) as HTMLButtonElement;
    expect(useArbitrum.disabled).toBe(true);
    fireEvent.click(useArbitrum);
    expect(posted()).toHaveLength(1);
    expect(f.mock.calls.some(([u]) => String(u).includes("get-cash") && String(u).includes("network=arbitrum"))).toBe(false);
  });
  it("keeps approval disabled when a fresh quote reports a send still pending after reload", async () => {
    quoteDraft = { live: true, draftKey: "fresh", pendingSend: true };
    show();
    await toPlan();
    expect(screen.getByRole("status").textContent).toMatch(/still being sent/i);
    expect(approve().disabled).toBe(true);
    fireEvent.click(approve());
    expect(posted()).toHaveLength(0);
  });
  it("a failed source switch keeps approval off until the picked network answers or the owner chooses to stay", async () => {
    cashData = gc({ otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    failArb = true;
    show();
    await toPlan();
    fireEvent.click(screen.getByRole("button", { name: /Arbitrum/ }));
    expect(await screen.findByText(/couldn'?t check Arbitrum/i)).toBeTruthy();
    // The stale Base quote stays visible but must not send while the picked source could not be read.
    fireEvent.click(approve());
    expect(posted()).toHaveLength(0);
    failArb = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByTestId("safe-identity").textContent).toContain("Arbitrum"));
  });
  it("staying on the shown network after a failed switch is an explicit choice that re-enables approval", async () => {
    cashData = gc({ otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    failArb = true;
    show();
    await toPlan();
    fireEvent.click(screen.getByRole("button", { name: /Arbitrum/ }));
    await screen.findByText(/couldn'?t check Arbitrum/i);
    fireEvent.click(approve());
    expect(posted()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /stay on Base/i }));
    fireEvent.click(approve());
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toMatchObject({ network: "base", chainId: 8453 });
  });
  it("an unchecked network is named, not mistaken for empty: no top-up instructions, a retry instead", async () => {
    cashData = gc({ state: "empty", maxCash: 0, holdings: [], levels: [], lenders: [], unread: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum" }] });
    show();
    expect(await screen.findByText(/couldn'?t check Arbitrum/i)).toBeTruthy();
    expect(screen.queryByText(/Send ETH/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(f.mock.calls.filter(([u]) => String(u).includes("get-cash")).length).toBeGreaterThan(1));
  });
  it("a chain short of the minimum with an unread funded network offers a retry, not transfer advice", async () => {
    cashData = gc({ state: "tooLittle", maxCash: 5, holdings: [{ asset: "ETH", balance: 0.001, usd: 3 }], levels: [], lenders: [], unread: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum" }] });
    show();
    expect(await screen.findByText(/couldn'?t check Arbitrum/i)).toBeTruthy();
    expect(screen.queryByText(/Send ETH/)).toBeNull();
  });
  it("keeps a switch back to the funded network available when the selected network is empty", async () => {
    cashData = gc({ otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    arbitrumData = gc({ state: "empty", maxCash: 0, holdings: [], asset: null, levels: [], lenders: [], best: null, network: "arbitrum", chainId: 42161, networkName: "Arbitrum", otherFunded: [{ network: "base", chainId: 8453, name: "Base", maxCash: 9000 }] });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Use Arbitrum" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use Base" }));
    await waitFor(() => expect(screen.getByTestId("safe-identity").textContent).toContain("Base"));
    expect(await input()).toBeTruthy();
  });
  it("shows Try again when a switch back to Base fails and keeps stale approval disabled", async () => {
    cashData = gc({ otherFunded: [{ network: "arbitrum", chainId: 42161, name: "Arbitrum", maxCash: 12000 }] });
    show();
    await toPlan();
    fireEvent.click(screen.getByRole("button", { name: "Use Arbitrum" }));
    await waitFor(() => expect(screen.getByTestId("safe-identity").textContent).toContain("Arbitrum"));
    failBase = true;
    fireEvent.click(screen.getByRole("button", { name: "Use Base" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't check Base/i);
    expect((approve()).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Try again/i })).toBeTruthy();
  });
});
