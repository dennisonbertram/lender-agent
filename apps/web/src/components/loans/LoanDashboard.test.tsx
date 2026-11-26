// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Safe } from "@/lib/types";
import type { LoanDetail } from "@/server/loans";
import { ShellProvider } from "@/components/shell/ShellContext";
import { LoanDashboard } from "./LoanDashboard";

vi.mock("@/components/charts", () => ({ LoanCharts: () => <div data-testid="charts" /> }));
vi.mock("@/components/chat/ProposalCardSlot", () => ({ ProposalCardSlot: ({ proposalId }: { proposalId: string }) => <div data-testid="proposal">{proposalId}</div> }));

const safe: Safe = { id: "s1", name: "Treasury", address: "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001", threshold: "2 of 3", agent: true, networks: [], balances: {} };

const detail = (openProposalIds: string[] = []): LoanDetail => ({
  price: 3000, openedTx: null, history: [{ day: -1, hf: 2.4 }], openProposalIds, monitor: { state: "watching", lastCheckAt: "2026-01-01T12:00:00Z", source: "Aave v3 on Base" },
  loan: {
    id: "8453:0xabc:aave-v3", chainId: 8453, network: "base", lender: "Aave v3",
    collateral: [{ asset: "ETH", amount: 2, usd: 6000 }], debt: { asset: "USDC", amount: 2000, usd: 2000 },
    healthFactor: 2.49, status: "healthy", levels: { warn: 1.6, act: 1.35 }, canFallPct: "ETH can fall 60% before liquidation", rowLine: "", maxDrop: 0.6,
    repaymentEligible: true,
    liquidationPrice: 1204.82, collateralPrice: 3000, apr: 5.5, yearlyInterest: 110,
    onchain: { market: { kind: "address", value: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" }, collateral: [{ symbol: "WETH", address: "0x4200000000000000000000000000000000000006" }], debt: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }] },
    limit: { used: 40, fill: 40, tick: null, text: "40% used · liquidated at 100%" }, blockNumber: 57172000, readAt: 0, mixed: false, watched: true,
    shell: {} as never,
  },
} as LoanDetail);

function show(d: LoanDetail, onClose?: () => Response, onRepay?: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/close") && onClose) return onClose();
    if (u.endsWith("/repay") && onRepay) return onRepay();
    return Response.json(d);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><LoanDashboard address="0xabc" loanId="8453:0xabc:aave-v3" /></ShellProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("LoanDashboard", () => {
  it("shows the last check time and the data source (BP-18)", async () => {
    show(detail());
    const line = await screen.findByTestId("monitor-line");
    expect(line.textContent).toMatch(/^Checked .+ · block 57,172,000$/);
    expect(within(line).getByRole("link", { name: "57,172,000" }).getAttribute("href")).toBe("https://basescan.org/block/57172000");
    expect(screen.queryByText(/Read from/)).toBeNull();
  });

  it("does not claim a check when the monitor is failing or the agent is off", async () => {
    const d = detail();
    d.monitor = { state: "failing", lastCheckAt: null, source: null };
    show(d);
    expect((await screen.findByTestId("monitor-line")).textContent).toBe("Not checked yet · block 57,172,000");
    cleanup();
    d.monitor = { state: "not_watched", lastCheckAt: null, source: null };
    show(d);
    expect((await screen.findByTestId("monitor-line")).textContent).toBe("Not watched · block 57,172,000");
  });

  it("says 'Not checked yet' when no check ran and the shell says checks are failing, like the chat header", async () => {
    const d = detail();
    d.monitor = { state: "starting", lastCheckAt: null, source: null };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(d)));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching={false} failing><LoanDashboard address="0xabc" loanId="8453:0xabc:aave-v3" /></ShellProvider>
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId("monitor-line")).textContent).toBe("Not checked yet · block 57,172,000");
  });

  it("a healthy worker with no check yet says the first check is coming", async () => {
    const d = detail();
    d.monitor = { state: "failing", lastCheckAt: null, source: null, firstCheckDue: true };
    show(d);
    expect((await screen.findByTestId("monitor-line")).textContent).toBe("Checking your loans… first check within a minute · block 57,172,000");
  });

  describe("watch line and health tile (r3 WP-1)", () => {
    const watchDetail = (state: "watching" | "starting" | "failing" | "not_watched" = "watching", watched = true) => {
      const d = detail();
      d.loan.status = "watch"; d.loan.healthFactor = 1.5; d.loan.levels = { warn: 1.6, act: 1.4 }; d.loan.watched = watched;
      d.monitor = { state, lastCheckAt: null, source: null };
      return d;
    };
    it("says what Watch means, with the loan's own At-risk level", async () => {
      show(watchDetail());
      expect((await screen.findByTestId("watch-line")).textContent).toBe("Nothing to do yet. If health falls below your At-risk level (1.4), you get an alert with ways to fix it.");
    });
    it("also shows while the monitor is starting", async () => {
      show(watchDetail("starting"));
      expect(await screen.findByTestId("watch-line")).toBeTruthy();
    });
    it("is hidden when no alert would come: failing monitor, or agent off", async () => {
      show(watchDetail("failing"));
      await screen.findByTestId("monitor-line");
      expect(screen.queryByTestId("watch-line")).toBeNull();
      cleanup();
      show(watchDetail("watching", false));
      await screen.findByTestId("monitor-line");
      expect(screen.queryByTestId("watch-line")).toBeNull();
    });
    it("is hidden at Healthy and At risk", async () => {
      show(detail());
      await screen.findByTestId("monitor-line");
      expect(screen.queryByTestId("watch-line")).toBeNull();
      cleanup();
      const d = watchDetail(); d.loan.status = "risk"; d.loan.healthFactor = 1.2;
      show(d);
      await screen.findByTestId("monitor-line");
      expect(screen.queryByTestId("watch-line")).toBeNull();
    });
    it("explains the health factor tile in an info button, not a sub-line", async () => {
      show(detail());
      const b = await screen.findByRole("button", { name: "Higher is safer. Below 1.0 the lender can sell your ETH." });
      expect(b.getAttribute("title")).toBe("Higher is safer. Below 1.0 the lender can sell your ETH.");
      expect(screen.queryByText("Higher is safer. Below 1.0 the lender can sell your ETH.")).toBeNull();
    });
  });

  it("renders a debt-free loan (health factor null) as No debt", async () => {
    const d = detail();
    d.loan.healthFactor = null;
    d.loan.debt = { asset: "USDC", amount: 0, usd: 0 };
    show(d);
    expect(await screen.findByText("No debt")).toBeTruthy();
  });
  it("keeps known token debt visible when its USD value and health are unavailable", async () => {
    const d = detail();
    d.loan.healthFactor = null;
    d.loan.debt = { asset: "USDC", amount: 1000, usd: null };
    show(d);
    expect(await screen.findByText("1,000 USDC")).toBeTruthy();
    expect(screen.getByText("Health unavailable")).toBeTruthy();
    expect(screen.queryByText("No debt")).toBeNull();
  });
  it("does not offer repayment controls when the debt token amount is unknown", async () => {
    const d = detail();
    d.loan.healthFactor = null;
    d.loan.debt = { asset: "USD", amount: null, usd: null };
    d.loan.mixed = false;
    show(d);
    expect(await screen.findByText("Debt value unavailable")).toBeTruthy();
    expect(screen.queryByLabelText("Amount to repay")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close this loan" })).toBeNull();
    expect(screen.getByText("Repayment controls are unavailable because the debt value could not be confirmed.")).toBeTruthy();
  });
  it("shows the tiles and the limit bar text", async () => {
    show(detail());
    expect(await screen.findByText("Health details")).toBeTruthy();
    expect((screen.getByText("Health details").closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByText("Health details"));
    expect(await screen.findByText("2.49")).toBeTruthy();
    expect(screen.getByText("Borrowed")).toBeTruthy();
    expect(screen.getByText("2,000 USDC")).toBeTruthy();
    expect(screen.getByText("Collateral")).toBeTruthy();
    expect(screen.getByText("2.00 ETH")).toBeTruthy();
    expect(screen.getByText("Interest")).toBeTruthy();
    expect(screen.getByText("5.5% a year")).toBeTruthy();
    expect(screen.queryByText("Loan limit")).toBeNull();
    expect(screen.queryByText("40% used · liquidated at 100%")).toBeNull();
    expect(screen.getByText("$2,000")).toBeTruthy();
    expect(screen.getByText("If ETH drops below $1,205, the lender can sell some collateral.")).toBeTruthy();
    expect(screen.queryByTestId("proposal")).toBeNull();
  });

  it("explains Compound v3 whole-account liquidation", async () => {
    const d = detail();
    d.loan = { ...d.loan, lender: "Compound v3" };
    show(d);
    expect(await screen.findByText("If this loan is liquidated, Compound takes all collateral from the account and credits any remainder in USDC.")).toBeTruthy();
    expect(screen.queryByText(/Compound can sell some collateral/)).toBeNull();
  });

  it("renders open proposals only when there are some, and hides the liquidation price when mixed", async () => {
    const d = detail(["p1"]);
    d.loan = { ...d.loan, mixed: true, liquidationPrice: null, collateralPrice: null };
    show(d);
    expect((await screen.findByTestId("proposal")).textContent).toBe("p1");
    expect(screen.queryByText(/Liquidation price/)).toBeNull();
    expect(screen.queryByText("Loan limit")).toBeNull();
    expect(screen.queryByText("40% used · liquidated at 100%")).toBeNull();
    expect(screen.getByText("$2,000")).toBeTruthy();
  });

  it("Close this loan drafts the close and shows its card; a blocked close shows the agent's sentence and no card (BP-26)", async () => {
    show(detail(), () => Response.json({ proposalId: "c1", stage: "queued" }));
    fireEvent.click(await screen.findByText("Close this loan"));
    expect((await screen.findByTestId("proposal")).textContent).toBe("c1");
    cleanup();
    show(detail(), () => Response.json({ error: "x", line: "To close this loan I need $2,000 USDC in the Safe. Add $500 more. Nothing was sent." }, { status: 422 }));
    fireEvent.click(await screen.findByText("Close this loan"));
    expect((await screen.findByRole("alert")).textContent).toContain("Add $500 more");
    expect(screen.queryByTestId("proposal")).toBeNull();
  });

  it("offers a repay form beside Close this loan, and the chat link", async () => {
    show(detail());
    await screen.findByText("Close this loan");
    expect(screen.getByLabelText("Amount to repay")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review repayment" })).toBeTruthy();
    expect(screen.getByText("Ask the agent").closest("a")?.getAttribute("href")).toBe("/s/0xabc/chat");
  });

  it("typing $200 sends one partial repayment and locks conflicting loan actions while queued", async () => {
    let loanData = detail();
    const post = vi.fn(async (_url: string, init?: RequestInit) => {
      loanData = detail(["r1"]);
      return Response.json({ proposalId: "r1", stage: "queued" });
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/repay")) return post(String(url), init);
      return Response.json(loanData);
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><LoanDashboard address="0xabc" loanId="8453:0xabc:aave-v3" /></ShellProvider>
      </QueryClientProvider>,
    );
    const input = await screen.findByLabelText("Amount to repay");
    const repayButton = screen.getByRole("button", { name: "Review repayment" }) as HTMLButtonElement;
    expect(repayButton.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "200" } });
    expect(repayButton.disabled).toBe(false);
    fireEvent.click(repayButton);
    expect((await screen.findByTestId("proposal")).textContent).toBe("r1");
    await waitFor(() => expect(screen.getAllByTestId("proposal")).toHaveLength(1));
    const body = JSON.parse(post.mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({ amount: 200 });
    expect(body.idempotencyKey).toEqual(expect.any(String));
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(repayButton.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close this loan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("proposal").textContent).toBe("r1");
  });

  it("does not show a network threshold from another Safe network", async () => {
    show(detail());
    const hint = await screen.findByTestId("close-hint");
    expect(hint.textContent).toMatch(/owners approve in Safe/);
    expect(hint.textContent).not.toMatch(/\d of \d/);
  });

  it("cents are allowed but a third decimal disables Repay with a cents hint", async () => {
    show(detail());
    const input = await screen.findByLabelText("Amount to repay");
    const repayButton = screen.getByRole("button", { name: "Review repayment" }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "200.51" } });
    expect(repayButton.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "200.512" } });
    expect(repayButton.disabled).toBe(true);
    expect((await screen.findByTestId("repay-hint")).textContent).toContain("cents");
  });

  it("keeps the same request key after a lost response, and recovers the queued proposal after remount", async () => {
    const calls: string[] = [];
    let failFirst = true;
    const mount = (d = detail()) => {
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/repay")) {
          calls.push(String(JSON.parse(String(init?.body)).idempotencyKey));
          if (failFirst) { failFirst = false; throw new TypeError("connection lost"); }
          return Response.json({ proposalId: "r-recovered", stage: "queued" });
        }
        return Response.json(d);
      }));
      return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><LoanDashboard address="0xabc" loanId="8453:0xabc:aave-v3" /></ShellProvider>
        </QueryClientProvider>,
      );
    };
    mount();
    const input = await screen.findByLabelText("Amount to repay");
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Review repayment" }));
    const retry = await screen.findByRole("button", { name: "Check repayment status" });
    expect((screen.getByLabelText("Amount to repay") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(retry);
    await screen.findByTestId("proposal");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);

    cleanup();
    mount(detail(["r-recovered"]));
    expect((await screen.findByLabelText("Amount to repay") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Review repayment" }) as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByTestId("proposal")).textContent).toBe("r-recovered");
  });

  it("recovers the original request after debt falls below its amount", async () => {
    const calls: { amount: number; idempotencyKey: string }[] = [];
    let failFirst = true;
    const mount = (d: LoanDetail) => {
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/repay")) {
          calls.push(JSON.parse(String(init?.body)));
          if (failFirst) { failFirst = false; throw new TypeError("connection lost"); }
          return Response.json({ proposalId: "r-after-debt-change", stage: "queued" });
        }
        return Response.json(d);
      }));
      return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><LoanDashboard address="0xabc" loanId="8453:0xabc:aave-v3" /></ShellProvider>
        </QueryClientProvider>,
      );
    };
    mount(detail());
    fireEvent.change(await screen.findByLabelText("Amount to repay"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Review repayment" }));
    await screen.findByRole("button", { name: "Check repayment status" });

    cleanup();
    const reduced = detail();
    reduced.loan.debt.amount = 150;
    reduced.loan.debt.usd = 150;
    mount(reduced);
    const check = await screen.findByRole("button", { name: "Check repayment status" }) as HTMLButtonElement;
    expect((screen.getByLabelText("Amount to repay") as HTMLInputElement).disabled).toBe(true);
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect((await screen.findByTestId("proposal")).textContent).toBe("r-after-debt-change");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("unlocks the form after a structured definitive refusal and uses a new key for a corrected amount", async () => {
    const calls: { amount: number; idempotencyKey: string }[] = [];
    let refuse = true;
    show(detail(), undefined, () => Response.json({ proposalId: "r-refused", stage: "not_sent", error: "Safe refused the proposal." }, { status: 502 }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/repay")) {
        calls.push(JSON.parse(String(init?.body)));
        if (refuse) {
          refuse = false;
          return Response.json({ proposalId: "r-refused", stage: "not_sent", error: "Safe refused the proposal." }, { status: 502 });
        }
        return Response.json({ proposalId: "r-corrected", stage: "queued" });
      }
      return Response.json(detail());
    }));
    fireEvent.change(await screen.findByLabelText("Amount to repay"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Review repayment" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Safe refused");
    const input = await screen.findByLabelText("Amount to repay") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Review repayment" }));
    expect((await screen.findByTestId("proposal")).textContent).toBe("r-corrected");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.idempotencyKey).not.toBe(calls[1]?.idempotencyKey);
    expect(calls[1]?.amount).toBe(100);
  });

  it("does not offer partial repayment when the selected lender cannot safely cap it", async () => {
    const d = detail();
    d.loan.repaymentEligible = false;
    d.loan.repaymentUnavailableReason = "Compound v3 partial repayment is unavailable.";
    show(d);
    const input = await screen.findByLabelText("Amount to repay");
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Review repayment" }) as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByTestId("repay-unavailable")).textContent).toContain("Compound v3");
  });

  it("a valid amount previews funding source and the debt left before anything is sent", async () => {
    show(detail());
    const input = await screen.findByLabelText("Amount to repay");
    fireEvent.change(input, { target: { value: "200" } });
    const preview = await screen.findByTestId("repay-review");
    expect(preview.textContent).toBe("Use $200 in digital dollars from Treasury. About $1,800 will still be owed. Your collateral stays locked.");
    fireEvent.change(input, { target: { value: "200.51" } });
    expect(preview.textContent).toBe("Use $200.51 in digital dollars from Treasury. About $1,799.49 will still be owed. Your collateral stays locked.");
  });

  it.each(["1e3", "0x10", "lots", "Infinity", "-5"])("non-decimal input (%s) is a hint, never a draft", async (bad) => {
    show(detail());
    const input = await screen.findByLabelText("Amount to repay");
    const repayButton = screen.getByRole("button", { name: "Review repayment" }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: bad } });
    expect(repayButton.disabled).toBe(true);
    expect(screen.queryByTestId("repay-review")).toBeNull();
    expect((await screen.findByTestId("repay-hint")).textContent).toMatch(/dollars|cents/i);
  });

  it("a blocked repay shows the agent's sentence and no card", async () => {
    show(detail(), undefined, () => Response.json({ error: "x", line: "To repay $2,000 USDC I need that much in the Safe. It holds $500. Add $1,500 more USDC and ask again. Nothing was sent." }, { status: 422 }));
    const input = await screen.findByLabelText("Amount to repay");
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Review repayment" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Add $1,500 more USDC");
    expect(screen.queryByTestId("proposal")).toBeNull();
  });

  it("links to Activity when the server says an earlier repayment may still be queued", async () => {
    show(detail(), undefined, () => Response.json({ error: "An earlier repayment may still be executable from Safe." }, { status: 409 }));
    fireEvent.change(await screen.findByLabelText("Amount to repay"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Review repayment" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("An earlier repayment may still be executable");
    expect(within(alert).getByRole("link", { name: "open Activity" }).getAttribute("href")).toBe("/s/0xabc/activity");
  });

  it("shows the Safe address with copy, explorer and Open in Safe links under the title", async () => {
    show(detail());
    fireEvent.click(await screen.findByText("Health details"));
    await screen.findByText("Health factor");
    expect(screen.getByTitle("0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001")).toBeTruthy();
    expect(screen.getAllByLabelText("Copy address").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open in Safe" }).getAttribute("href")).toContain("base:0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001");
  });

  it("explains that Safe owners approve without borrowing another network's threshold", async () => {
    show(detail());
    const hint = await screen.findByTestId("close-hint");
    expect(hint.textContent).toBe("Your Safe owners approve in Safe before the repayment runs.");
    expect(hint.textContent).not.toMatch(/\d of \d/);
  });

  it("lists on-chain details, collapsed: pool, ETH (WETH), USDC and the opening tx when known", async () => {
    show(detail());
    const box = await screen.findByTestId("onchain-details");
    expect((box as HTMLDetailsElement).open).toBe(false);
    expect(within(box).getByText("Lending contract")).toBeTruthy();
    expect(within(box).getByTitle("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5")).toBeTruthy();
    expect(within(box).getByText("ETH (WETH)")).toBeTruthy();
    expect(within(box).getByText("USDC")).toBeTruthy();
    expect(within(box).queryByText("Opened in")).toBeNull();
    cleanup();
    const d = detail(); d.openedTx = `0x${"ab".repeat(32)}`;
    show(d);
    expect(within(await screen.findByTestId("onchain-details")).getByText("Opened in")).toBeTruthy();
  });

  it("offers no close on a mixed account", async () => {
    const d = detail();
    d.loan = { ...d.loan, mixed: true, liquidationPrice: null, collateralPrice: null };
    show(d);
    await screen.findByText("Collateral");
    expect(screen.queryByText("Close this loan")).toBeNull();
  });

  describe("VC-03 / VC-04", () => {
    const risky = () => {
      const d = detail();
      d.loan.status = "risk"; d.loan.healthFactor = 1.2; d.loan.maxDrop = 0.12; d.loan.canFallPct = "ETH can fall 12% before liquidation";
      return d;
    };
    const showRisk = (d: LoanDetail) => {
      const fix = { options: { loanId: d.loan.id, lender: "Aave v3", options: [{ k: "coll", label: "Add ETH", sub: "From Safe", short: false, recommended: true }], note: "" }, state: { fix: "none", replaced: [] }, draft: null, safeLink: null };
      vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(String(url).includes("/fixes") ? fix : d)));
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><LoanDashboard address="0xabc" loanId={d.loan.id} /></ShellProvider>
        </QueryClientProvider>,
      );
    };
    it("at risk: one red block holding the alert, the headline replaces the before-liquidation line", async () => {
      showRisk(risky());
      const block = await screen.findByTestId("loan-risk");
      expect(block.className).toContain("bg-destructive/10");
      expect(within(block).getByRole("alert").textContent).toMatch(/Below your At-risk level/);
      await screen.findByRole("button", { name: /Add ETH/ });
      expect(block.querySelectorAll("[data-testid=fix-options]").length).toBe(1);
      expect(document.querySelectorAll("[class*='bg-destructive/10']").length).toBe(1);
      expect(screen.getByText("This loan is below your safety level. If ETH drops 12% the lender can sell some of it.")).toBeTruthy();
      expect(screen.queryByText(/before liquidation/)).toBeNull();
    });
    it("a failed load is a StateMessage with a heading and a way out", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching><LoanDashboard address="0xabc" loanId="x" /></ShellProvider>
        </QueryClientProvider>,
      );
      const alert = await screen.findByRole("alert");
      expect(within(alert).getByRole("heading").textContent).toMatch(/could not find this loan/);
      expect(within(alert).getAllByRole("link", { name: /Overview/ }).length + within(alert).queryAllByRole("button").length).toBeGreaterThan(0);
    });
  });
});
