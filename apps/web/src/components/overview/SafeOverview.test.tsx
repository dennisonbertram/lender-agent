// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getAddress } from "viem";
import { shortAddress } from "@/lib/address";
import type { Safe } from "@/lib/types";
import type { LoansResult } from "@/server/loans";
import { ShellProvider } from "@/components/shell/ShellContext";
import { SafeOverview } from "./SafeOverview";

vi.mock("next/navigation", () => ({ usePathname: () => `/s/${"0x5afE5aFE5Afe5afe5aFe5afE5afe5aFE5afe0001"}`, useRouter: () => ({ push() {} }) }));

const ADDR = "0x5afE5aFE5Afe5afe5aFe5afE5afe5aFE5afe0001";
const safe: Safe = { id: "s1", name: "Treasury", address: ADDR, threshold: "2 of 3", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} };

const loan = {
  id: "8453:0xabc:aave-v3", chainId: 8453, network: "base", lender: "Aave v3", status: "healthy", healthFactor: 2.49,
  rowLine: "Borrowed $2,000 · ETH can fall 60% before liquidation", canFallPct: "ETH can fall 60% before liquidation", debt: { asset: "USDC", amount: 2000, usd: 2000 }, collateral: [{ asset: "ETH", amount: 2, usd: 6000 }],
} as unknown as LoansResult["loans"][number];

const funds = [{ chainId: 8453, network: "base", totalUsd: 3000, blockNumber: 1, assets: [{ asset: "ETH", amount: 1, usd: 3000 }] }] as LoansResult["balancesByNetwork"];

function show(data: Partial<LoansResult>, agentOn = true, proposals: unknown[] = [], theSafe: Safe = safe) {
  const full: LoansResult = { loans: [], balancesByNetwork: [], loanReadsComplete: true, watched: agentOn, sentence: "", monitor: { state: "watching", lastCheckAt: null, source: null }, ...data };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(String(url).includes("/proposals/") ? { proposals } : full)));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ShellProvider safe={theSafe} safes={[theSafe]} loans={[]} agentOn={agentOn} watching={agentOn}><SafeOverview /></ShellProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SafeOverview", () => {
  it("shows the status sentence, the loan row copy and balances by network", async () => {
    show({ loans: [loan], sentence: "Your loan is fine.", balancesByNetwork: [{ chainId: 8453, network: "base", totalUsd: 3000, blockNumber: 1, assets: [{ asset: "ETH", amount: 1, usd: 3000 }] }] });
    expect(await screen.findByText("Your loan is fine.")).toBeTruthy();
    expect(screen.getByText("ETH can fall 60% before liquidation")).toBeTruthy();
    expect(screen.getByText("2.00 ETH locked · $2,000 USDC owed")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Health 2.49")).toBeTruthy();
    expect(screen.getByLabelText("Balances on Base")).toBeTruthy();
    expect(screen.queryByText("Not watched")).toBeNull();
    expect(screen.queryByText(/^Fix /)).toBeNull();
  });

  it("does not present borrowed money as wealth: In your Safe, You owe and what is left", async () => {
    show({ loans: [loan], sentence: "Your loan is fine.", balancesByNetwork: [{ chainId: 8453, network: "base", totalUsd: 3000, blockNumber: 1, assets: [{ asset: "USDC", amount: 3000, usd: 3000 }] }] });
    await screen.findByText("Your loan is fine.");
    expect(screen.getByText("In your Safe")).toBeTruthy();
    expect(screen.getByText("Spendable today")).toBeTruthy();
    const net = screen.getByTestId("net-position");
    expect(within(net).getByText("You owe").nextSibling?.textContent).toBe("$2,000");
    expect(within(net).getByText("Estimated after closing").nextSibling?.textContent).toBe("$7,000");
    expect(screen.getByText(/excludes fees and can change with market prices/)).toBeTruthy();
  });

  it("includes returned collateral in the $7,500 close estimate", async () => {
    const fundedLoan = { ...loan, collateral: [{ asset: "ETH", amount: 0.6202, usd: 1861 }], debt: { asset: "USDC", amount: 1000, usd: 1000 } } as unknown as LoansResult["loans"][number];
    show({ loans: [fundedLoan], sentence: "Your loan is fine.", balancesByNetwork: [{ chainId: 8453, network: "base", totalUsd: 6639, blockNumber: 1, assets: [{ asset: "USDC", amount: 6639, usd: 6639 }] }] });
    await screen.findByText("Spendable today");
    const net = screen.getByTestId("net-position");
    expect(within(net).getByText("Spendable today").nextSibling?.textContent).toBe("$6,639");
    expect(within(net).getByText("Collateral locked").nextSibling?.textContent).toBe("$1,861");
    expect(within(net).getByText("Estimated after closing").nextSibling?.textContent).toBe("$7,500");
  });

  it("does not show a balance total as zero when a token price is unavailable", async () => {
    show({ loans: [loan], sentence: "Your loan is fine.", balancesByNetwork: [{ chainId: 8453, network: "base", totalUsd: null, blockNumber: 1, assets: [{ asset: "ETH", amount: 1, usd: null }] }] as unknown as LoansResult["balancesByNetwork"] });
    expect(await screen.findByText("Spendable today")).toBeTruthy();
    expect(screen.getAllByText("Price unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("$0")).toBeNull();
  });

  it("does not show a zero debt or closing total when the debt price is unavailable", async () => {
    show({ loans: [{ ...loan, debt: { asset: "USD", amount: 0, usd: null } }], sentence: "Your loan is fine.", balancesByNetwork: funds });
    const net = await screen.findByTestId("net-position");
    expect(within(net).getByText("You owe").nextSibling?.textContent).toBe("Price unavailable");
    expect(within(net).getByText("Estimated after closing").nextSibling?.textContent).toBe("Price unavailable");
    expect(screen.queryByText("$0")).toBeNull();
  });

  it("opens Add funds when a positive balance is still below the loan debt", async () => {
    show({ loans: [loan], sentence: "Your loan is fine.", balancesByNetwork: [{ chainId: 8453, network: "base", totalUsd: 500, blockNumber: 1, assets: [{ asset: "USDC", amount: 500, usd: 500 }] }] });
    expect(await screen.findByTestId("repayment-funding")).toBeTruthy();
    expect(screen.getByText("Add funds for collateral").closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("guides repayment with the same-chain USDC shortfall, separate from collateral funding", async () => {
    show({ loans: [loan], sentence: "Your loan is fine.", balancesByNetwork: [{ chainId: 8453, network: "base", totalUsd: 500, blockNumber: 1, assets: [{ asset: "USDC", amount: 500, usd: 500 }] }] });
    expect(await screen.findByTestId("repayment-funding")).toBeTruthy();
    expect(screen.getByText(/About 1,500(?:\.00)? USDC more on Base/)).toBeTruthy();
    expect(screen.getByText(/Accrued interest and the signing buffer can make the amount higher/)).toBeTruthy();
    expect(screen.getByText("Add funds for collateral").closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Send USDC to this Safe").closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("sizes USDC repayment guidance in token units when its dollar price differs from one", async () => {
    const depegged = { ...loan, debt: { asset: "USDC", amount: 2000, usd: 1600 } } as unknown as LoansResult["loans"][number];
    show({ loans: [depegged], balancesByNetwork: [{ chainId: 8453, network: "base", totalUsd: 400, blockNumber: 1, assets: [{ asset: "USDC", amount: 500, usd: 400 }] }] });
    expect(await screen.findByTestId("repayment-funding")).toBeTruthy();
    expect(screen.getByText(/About 1,500(?:\.00)? USDC more on Base/)).toBeTruthy();
    expect(screen.queryByText(/About \$1,200 more/)).toBeNull();
  });

  it("does not recommend USDC transfers for mixed-asset debt the app cannot repay with USDC", async () => {
    const mixedDebt = { ...loan, debt: { asset: "USD", amount: 4000, usd: 4000 } } as unknown as LoansResult["loans"][number];
    show({ loans: [mixedDebt], balancesByNetwork: [{ chainId: 8453, network: "base", totalUsd: 500, blockNumber: 1, assets: [{ asset: "USDC", amount: 500, usd: 500 }] }] });
    await screen.findByText("Add funds for collateral");
    expect(screen.queryByTestId("repayment-funding")).toBeNull();
  });

  it("does not estimate a shortfall or offer a repayment transfer when that network balance is unknown", async () => {
    show({ loans: [loan], balancesByNetwork: [] });
    await screen.findByText("Add funds for collateral");
    expect(screen.getByText(/I can't confirm the Safe's USDC balance on Base, so I can't estimate how much more to add/)).toBeTruthy();
    expect(screen.getByText("Send USDC to this Safe").closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.queryByText(/more USDC on Base based on current balances/)).toBeNull();
  });

  it("keeps a known token debt visible when its USD value and health are unavailable", async () => {
    const unknownUsd = { ...loan, healthFactor: null, debt: { asset: "USDC", amount: 1000, usd: null } } as unknown as LoansResult["loans"][number];
    show({ loans: [unknownUsd] });
    expect(await screen.findByText(/1,000 USDC owed · value unavailable/)).toBeTruthy();
    expect(screen.getByText("Health unavailable")).toBeTruthy();
    expect(screen.queryByText("No debt")).toBeNull();
  });

  it("does not label mixed debt with missing prices as zero or debt-free", async () => {
    const unknownMixed = { ...loan, healthFactor: null, debt: { asset: "USD", amount: null, usd: null } } as unknown as LoansResult["loans"][number];
    show({ loans: [unknownMixed] });
    expect(await screen.findByText(/Debt value unavailable/)).toBeTruthy();
    expect(screen.getByText("Debt unavailable")).toBeTruthy();
    expect(screen.queryByText("No debt")).toBeNull();
  });

  it("marks retained figures as stale after a refresh fails", async () => {
    const stale: LoansResult = { loans: [loan], balancesByNetwork: funds, loanReadsComplete: true, watched: true, sentence: "Your loan is fine.", monitor: { state: "watching", lastCheckAt: null, source: null } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/proposals/")) return Response.json({ proposals: [] });
      throw new Error("RPC unavailable");
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["loans", ADDR.toLowerCase()], stale);
    render(<QueryClientProvider client={client}><ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn={true} watching={true}><SafeOverview /></ShellProvider></QueryClientProvider>);
    expect(await screen.findByText("Could not refresh loan data. The figures below may be out of date.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("Your loan is fine.")).toBeTruthy();
  });

  it("BP-35: balances on two networks are grouped by network, each with a chip and a subtotal, and the loan names its network", async () => {
    show({
      loans: [{ ...loan, chainId: 42161, network: "arbitrum" } as LoansResult["loans"][number]],
      sentence: "Your loan is fine.",
      balancesByNetwork: [
        { chainId: 8453, network: "base", totalUsd: 3000, blockNumber: 1, assets: [{ asset: "ETH", amount: 1, usd: 3000 }] },
        { chainId: 42161, network: "arbitrum", totalUsd: 1500, blockNumber: 1, assets: [{ asset: "USDC", amount: 1500, usd: 1500 }] },
      ],
    });
    const base = await screen.findByLabelText("Balances on Base");
    const arb = screen.getByLabelText("Balances on Arbitrum");
    expect(within(base).getAllByText("$3,000")).toHaveLength(2); // subtotal and the one asset row
    expect(within(base).getByText(/ETH/)).toBeTruthy();
    expect(within(base).queryByText(/USDC/)).toBeNull();
    expect(within(arb).getAllByText("$1,500")).toHaveLength(2);
    expect(within(arb).getByText(/1,500 USDC/)).toBeTruthy();
    expect(screen.getByTestId("in-safe").textContent).toBe("$4,500");
    expect(within(screen.getByRole("link", { name: /Aave v3/ })).getByText("Arbitrum")).toBeTruthy();
  });

  it("says Not watched, still shows status, and has no Fix button when the agent is off", async () => {
    show({ loans: [{ ...loan, status: "risk", healthFactor: 1.2 }], sentence: "1 loan needs action now." }, false);
    expect(await screen.findByText("Not watched")).toBeTruthy();
    expect(screen.getByText("1 loan needs action now.")).toBeTruthy();
    expect(screen.getByText("At risk")).toBeTruthy();
    expect(screen.getByText("Health 1.20")).toBeTruthy();
    expect(screen.queryByText(/Fix/)).toBeNull();
  });

  it("shows the empty states", async () => {
    show({});
    expect(await screen.findByText("Add funds")).toBeTruthy();
  });

  it("does not say No loans yet or suggest funding when a lender read failed", async () => {
    show({ loanReadsComplete: false, sentence: "Could not check every lending market; some loan balances may be missing." });
    expect(await screen.findByText("Loans could not be fully checked")).toBeTruthy();
    expect(screen.queryByText("No loans yet")).toBeNull();
    expect(screen.queryByText("Add funds")).toBeNull();
  });

  it("At risk with the agent on: See fix options comes first and opens the loan; no Get cash button (it is in the nav)", async () => {
    show({ loans: [{ ...loan, status: "risk", healthFactor: 1.2 }], sentence: "1 loan needs action now." });
    const fix = await screen.findByRole("link", { name: "See fix options" });
    expect(fix.getAttribute("href")).toMatch(new RegExp(`/loans/${encodeURIComponent(loan.id)}$`));
    expect(screen.queryByRole("link", { name: /Get cash/ })).toBeNull();
  });

  it("with a risk and a liquidatable loan, See fix options targets the liquidatable one", async () => {
    show({ loans: [{ ...loan, id: "r", status: "risk", healthFactor: 1.2 }, { ...loan, id: "l", status: "liquidatable", healthFactor: 0.9 }], sentence: "2 loans need action now." });
    expect((await screen.findByRole("link", { name: "See fix options" })).getAttribute("href")).toMatch(/\/loans\/l$/);
  });

  it("Healthy and Watch loans have no See fix options", async () => {
    show({ loans: [{ ...loan, status: "watch", healthFactor: 1.4 }], sentence: "Watch." });
    expect(await screen.findByText("Watch.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "See fix options" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Get cash/ })).toBeNull();
  });

  it("overview-01/04: the header shows the checksummed Safe with explorer and Safe links, the network chip and the threshold", async () => {
    show({});
    expect(await screen.findByText("Treasury")).toBeTruthy();
    expect(screen.getByTitle(getAddress(ADDR))).toBeTruthy();
    expect(screen.getByRole("link", { name: /View on Basescan/ }).getAttribute("href")).toBe(`https://basescan.org/address/${getAddress(ADDR)}`);
    expect(screen.getByRole("link", { name: "Open in Safe" })).toBeTruthy();
    expect(screen.getByText("2 of 3 owners must sign", { exact: false })).toBeTruthy();
    expect(screen.getAllByText("Base").length).toBeGreaterThan(0);
  });

  it("an unnamed Safe is titled Your Safe, not its own address", async () => {
    show({}, true, [], { ...safe, name: shortAddress(ADDR) });
    expect(await screen.findByRole("heading", { name: "Your Safe" })).toBeTruthy();
  });

  const waiting = { id: "p1", title: "Borrow $500 USDC", stage: "queued", state: "waiting_for_others", final: false, signedCount: 1, needsSignatures: 1, viewerSigned: true, links: { queue: "https://app.safe.global/transactions/queue?safe=base:x", tx: null } };

  it("no loan but a proposal waiting for a co-owner: lists it with Review, not 'No loans yet'", async () => {
    show({ balancesByNetwork: funds }, true, [waiting, { id: "p2", title: "A draft", stage: "draft" }]);
    expect(await screen.findByText("Waiting for your co-owner")).toBeTruthy();
    expect(screen.getByText("Borrow $500 USDC")).toBeTruthy();
    expect(screen.queryByText("A draft")).toBeNull();
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe(`/s/${ADDR}/proposals/p1`);
    expect(screen.getByText("1 of 2 approved · Waiting for your co-owner")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View in Safe{Wallet}" }).getAttribute("href")).toContain("app.safe.global");
    expect(screen.queryByText("No loans yet")).toBeNull();
    expect(screen.queryByText(/Tell me how much cash/)).toBeNull();
  });

  it("a fully approved request says Ready to send — never 'waiting for signatures' or 'needs Co-owner'", async () => {
    show({ balancesByNetwork: funds }, true, [{ ...waiting, state: "ready_to_send", signedCount: 2, needsSignatures: 0, canSend: true }]);
    expect(await screen.findByText("Ready to send")).toBeTruthy();
    expect(screen.getByText("2 of 2 approved · Ready to send")).toBeTruthy();
    expect(screen.queryByText(/needs Co-owner|Waiting for signatures/)).toBeNull();
    expect(screen.getByRole("link", { name: "Review and send" }).getAttribute("href")).toBe(`/s/${ADDR}/proposals/p1`);
  });

  it("a request that needs the viewer's approval says so (the co-owner sees this)", async () => {
    show({ balancesByNetwork: funds }, true, [{ ...waiting, state: "needs_your_signature", viewerSigned: false }]);
    expect(await screen.findByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText("1 of 2 approved · Needs your approval")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review and approve" }).getAttribute("href")).toBe(`/s/${ADDR}/proposals/p1`);
  });

  it("a blocked request says an earlier transaction has to go first", async () => {
    show({ balancesByNetwork: funds }, true, [{ ...waiting, state: "blocked", viewerSigned: false, blockedBy: [{ id: "p0", nonce: "6", title: "Send 150 USDC" }] }]);
    expect(await screen.findByText("Waiting on an earlier transaction")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See why" }).getAttribute("href")).toBe(`/s/${ADDR}/proposals/p1`);
  });

  it("a submitted request says the network is confirming, not 'ready'", async () => {
    show({ balancesByNetwork: funds }, true, [{ ...waiting, state: "sending", signedCount: 2, needsSignatures: 0, pendingTxHash: `0x${"ab".repeat(32)}` }]);
    expect(await screen.findByText("Sending")).toBeTruthy();
    expect(screen.queryByText(/Ready to send|Waiting for signatures/)).toBeNull();
  });

  it("overview-03: a waiting proposal shows above Loans even when a loan exists", async () => {
    show({ loans: [loan], sentence: "Your loan is fine.", balancesByNetwork: funds }, true, [waiting]);
    const w = await screen.findByText("Waiting for your co-owner");
    expect(w.compareDocumentPosition(screen.getByText("Loans")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("overview-05: a new loan says Getting ready, never Checks delayed", async () => {
    show({ loans: [loan], sentence: "Your loan is fine.", balancesByNetwork: funds });
    expect(await screen.findByText("Your loan is fine.")).toBeTruthy();
    expect(screen.queryByText(/delayed/i)).toBeNull();
  });

  it("no loan and no waiting proposal still says No loans yet", async () => {
    show({ balancesByNetwork: funds }, true, [{ id: "p2", title: "A draft", stage: "draft" }]);
    expect(await screen.findByText("No loans yet")).toBeTruthy();
    expect(screen.queryByText("Waiting for signatures")).toBeNull();
  });

  it("VC-04: a failed load is a StateMessage with a heading and a way out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><SafeOverview /></ShellProvider>
      </QueryClientProvider>,
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading").textContent).toMatch(/Something went wrong/);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("VC-03: an at-risk loan gets the same riskHeadline sentence as its loan page", async () => {
    const risky = { ...loan, status: "risk", healthFactor: 1.2, maxDrop: 0.12 } as unknown as LoansResult["loans"][number];
    show({ loans: [risky], balancesByNetwork: funds, sentence: "1 loan needs action now." });
    expect(await screen.findByText("This loan is below your safety level. If ETH drops 12% the lender can sell some of it.")).toBeTruthy();
  });
});
