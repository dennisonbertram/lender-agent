// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ENABLED_CHAIN_IDS } from "@/lib/safe-create";
import { createProgressKey } from "@/lib/create-progress";
import { CreateSafe, type CreateSafeApi, type Preview } from "./CreateSafe";

afterEach(cleanup);
beforeEach(() => localStorage.clear());
const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CO1 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CO2 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const ADDR = "0x60157EE8eA450d606F969acb7043DC2Fd6Aa50aA";

const sponsored: Preview = { address: ADDR, index: 0, message: "m", sponsored: true, cost: "Setup on Base is free: we pay the one-time setup fee.", chainId: 8453 };
const paid: Preview = { ...sponsored, sponsored: false, cost: "Setting up your Safe on Base costs a one-time network fee of less than $0.02. You pay it from your wallet." };

function fakeApi(pv: Preview, over: Partial<CreateSafeApi> = {}): CreateSafeApi {
  return {
    preview: vi.fn(async () => pv),
    create: vi.fn(async () => ({ address: pv.address })),
    setup: vi.fn(async () => ({ status: "ready" as const, indexed: true })),
    reconcile: vi.fn(async () => ({ status: "ready" as const, indexed: true })),
    payFee: vi.fn(async () => "0xhash"),
    indexed: vi.fn(async () => true),
    ...over,
  };
}
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
const setup = (api: CreateSafeApi, onCreated = vi.fn()) => { render(<CreateSafe wallet={ME} api={api} onCreated={onCreated} pollMs={1} />); return onCreated; };
const toApprovals = () => next();

describe("CreateSafe steps", () => {
  it("has three steps with Back, and Review lists every owner with Change", async () => {
    setup(fakeApi(sponsored));
    expect(screen.getByRole("heading", { name: "Name your Safe" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    toApprovals();
    expect(screen.getByRole("heading", { name: "Who approves transactions?" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Me and people I trust/));
    fireEvent.change(screen.getByLabelText("Co-signer 1"), { target: { value: CO1 } });
    fireEvent.click(screen.getByRole("button", { name: "Add another" }));
    fireEvent.change(screen.getByLabelText("Co-signer 2"), { target: { value: CO2 } });
    next();
    expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy();
    expect(screen.getByText("0x7099…79C8")).toBeTruthy();
    expect(screen.getByText("0x3C44…93BC")).toBeTruthy();
    expect(screen.getByText("0x90F7…b906")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change owners and approvals" }));
    expect(screen.getByRole("heading", { name: "Who approves transactions?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Name your Safe" })).toBeTruthy();
  });

  it("defaults to 1 of 2 with one co-signer and 2 of 3 with two, with the risk in the help text", () => {
    setup(fakeApi(sponsored));
    next();
    fireEvent.click(screen.getByLabelText(/Me and people I trust/));
    fireEvent.change(screen.getByLabelText("Co-signer 1"), { target: { value: CO1 } });
    const select = screen.getByLabelText("Approvals needed") as HTMLSelectElement;
    expect(select.value).toBe("1");
    expect(screen.getByText(/thief can move the money/)).toBeTruthy();
    fireEvent.change(select, { target: { value: "2" } });
    expect(screen.getByText(/nobody can move the money/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add another" }));
    fireEvent.change(screen.getByLabelText("Co-signer 2"), { target: { value: CO2 } });
    fireEvent.change(select, { target: { value: "2" } });
    expect(select.value).toBe("2");
  });

  it("two co-signers default to 2 of 3", () => {
    setup(fakeApi(sponsored));
    next();
    fireEvent.click(screen.getByLabelText(/Me and people I trust/));
    fireEvent.click(screen.getByRole("button", { name: "Add another" }));
    fireEvent.change(screen.getByLabelText("Co-signer 1"), { target: { value: CO1 } });
    fireEvent.change(screen.getByLabelText("Co-signer 2"), { target: { value: CO2 } });
    expect((screen.getByLabelText("Approvals needed") as HTMLSelectElement).value).toBe("2");
    expect(screen.getByText(/One stolen key cannot move the money/)).toBeTruthy();
  });

  it("stops on a bad co-signer address", () => {
    setup(fakeApi(sponsored));
    next();
    fireEvent.click(screen.getByLabelText(/Me and people I trust/));
    fireEvent.change(screen.getByLabelText("Co-signer 1"), { target: { value: "0x12" } });
    next();
    expect(screen.getByText(/^This is not a valid address/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Who approves transactions?" })).toBeTruthy();
  });
});

describe("CreateSafe Review and setup", () => {
  const toReview = () => { next(); next(); };

  it("the address on Review is the address created and handed on", async () => {
    const api = fakeApi(sponsored);
    const onCreated = setup(api);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address").textContent).toBe("0x6015…50aA"));
    expect(screen.getByTestId("safe-address").getAttribute("title")).toBe(ADDR);
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ address: ADDR, name: "My Safe", chainIds: [8453] }));
    expect(api.setup).toHaveBeenCalledWith(ADDR, 8453);
  });

  it("says setup is free only when the server says we pay", async () => {
    setup(fakeApi(sponsored));
    toReview();
    await waitFor(() => expect(screen.getByTestId("setup-cost").textContent).toMatch(/free/i));
    cleanup();
    setup(fakeApi(paid));
    toReview();
    await waitFor(() => expect(screen.getByTestId("setup-cost").textContent).toMatch(/one-time network fee/));
    expect(document.body.textContent).not.toMatch(/free/i);
  });

  it("when the user pays: shows the fee, no 'free', sends the user's transaction, then continues", async () => {
    const tx = { to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", data: "0x1688f0b9" } as const;
    const api = fakeApi(paid, {
      setup: vi.fn()
        .mockResolvedValueOnce({ status: "user_pays", cost: paid.cost, tx })
        .mockResolvedValueOnce({ status: "ready", indexed: true }),
    });
    const onCreated = setup(api);
    toReview();
    await waitFor(() => expect(screen.getByTestId("setup-cost")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    const payButton = await screen.findByRole("button", { name: "Pay the setup fee" });
    expect(document.body.textContent).not.toMatch(/free/i);
    expect(document.body.textContent!.split("one-time network fee").length - 1).toBe(1);
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(payButton);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.payFee).toHaveBeenCalledWith(tx, 8453, expect.any(Function), ME);
    expect(api.setup).toHaveBeenLastCalledWith(ADDR, 8453, "0xhash");
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("review 6: an indexing error after a paid deployment retries confirmation without paying again", async () => {
    const tx = { to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", data: "0x1688f0b9" } as const;
    const api = fakeApi(paid, {
      setup: vi.fn()
        .mockResolvedValueOnce({ status: "user_pays", cost: paid.cost, tx })
        .mockResolvedValue({ status: "ready", indexed: true }),
      indexed: vi.fn().mockRejectedValueOnce(new Error("index down")).mockResolvedValue(true),
    });
    const onCreated = setup(api);
    toReview();
    await waitFor(() => expect(screen.getByTestId("setup-cost")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee" }));
    await screen.findByText("index down");
    expect(screen.queryByRole("button", { name: "Pay the setup fee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check my payment" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.payFee).toHaveBeenCalledTimes(1);
    expect(api.setup).toHaveBeenLastCalledWith(ADDR, 8453, "0xhash");
  });

  it("review 6: a payment whose receipt wait failed keeps the hash it sent", async () => {
    const tx = { to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", data: "0x1688f0b9" } as const;
    const api = fakeApi(paid, {
      setup: vi.fn().mockResolvedValueOnce({ status: "user_pays", cost: paid.cost, tx }).mockResolvedValue({ status: "ready", indexed: true }),
      payFee: vi.fn(async (_tx, _chain, onSent) => { onSent?.("0xsent"); throw new Error("receipt timeout"); }),
    });
    const onCreated = setup(api);
    toReview();
    await waitFor(() => expect(screen.getByTestId("setup-cost")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee" }));
    await screen.findByText("receipt timeout");
    fireEvent.click(screen.getByRole("button", { name: "Check my payment" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.payFee).toHaveBeenCalledTimes(1);
    expect(api.setup).toHaveBeenLastCalledWith(ADDR, 8453, "0xsent");
  });

  it("waits until the Safe is indexed before handing on", async () => {
    let n = 0;
    const api = fakeApi(sponsored, { indexed: vi.fn(async () => ++n >= 3) });
    const onCreated = setup(api);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address").textContent).toContain("0x6015"));
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(n).toBe(3);
  });

  it("a failed setup shows the error and retry does not create the Safe twice", async () => {
    const api = fakeApi(sponsored, { setup: vi.fn().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue({ status: "ready", indexed: true }) });
    const onCreated = setup(api);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address").textContent).toContain("0x6015"));
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await screen.findByText("rpc down");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.create).toHaveBeenCalledTimes(1);
  });
});

describe("CreateSafe Review networks", () => {
  const toReview = (api = fakeApi(sponsored)) => { const onCreated = setup(api); next(); next(); return Object.assign(api, { onCreated }); };
  const pick = (name: string) => fireEvent.click(screen.getByLabelText(name));
  const tx = { to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", data: "0x1688f0b9" } as const;
  const cost = (n: string) => `Setting up your Safe on ${n} costs a one-time network fee of less than $0.02. You pay it from your wallet.`;
  const userPays = (n: string) => ({ status: "user_pays" as const, cost: cost(n), tx });

  it("shows the network picker on Review, all six enabled, Base checked by default", () => {
    toReview();
    expect(ENABLED_CHAIN_IDS).toHaveLength(6);
    for (const n of ["Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Gnosis"]) expect((screen.getByLabelText(n) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Base") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Ethereum") as HTMLInputElement).checked).toBe(false);
    for (const mark of ["ethereum", "base", "arbitrum-one", "optimism", "polygon", "gnosis"]) expect(document.querySelector(`img[src="/network-marks/${mark}.svg"]`)).toBeTruthy();
    expect(screen.getByText(/It starts on Base/)).toBeTruthy();
    expect(screen.queryByTestId("not-served")).toBeNull();
  });

  it("choosing networks re-previews them in order with one fee line each, and says loans are only on Base and Arbitrum", async () => {
    const api = toReview();
    pick("Ethereum"); pick("Polygon");
    await waitFor(() => expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ networks: [8453, 1, 137] })));
    expect(screen.getByTestId("fee-1").textContent).toMatch(/Ethereum: about \$0\.05.*can reach about \$5 to \$16/);
    expect(screen.getByTestId("fee-8453").textContent).toMatch(/Base: less than \$0\.02/);
    expect(screen.getByTestId("fee-137").textContent).toMatch(/Polygon/);
    expect(screen.getByTestId("not-served").textContent).toMatch(/Loans are on Base and Arbitrum today\. On other networks your Safe can hold funds, and the agent can help move them\./);
    pick("Ethereum"); pick("Polygon");
    expect(screen.queryByTestId("not-served")).toBeNull();
  });

  it("will not create with no network chosen", () => {
    const api = toReview();
    pick("Base");
    expect((screen.getByRole("button", { name: "Create Safe" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    expect(screen.getByRole("alert").textContent).toMatch(/at least one network/);
    expect(api.create).not.toHaveBeenCalled();
  });

  it("pays each network in turn: switch and pay happen per network, with status per network", async () => {
    const log: string[] = [];
    const api = fakeApi({ ...paid, networks: [{ chainId: 8453, sponsored: false, cost: paid.cost }, { chainId: 1, sponsored: false, cost: cost("Ethereum") }] }, {
      setup: vi.fn(async (_a: string, id: number, hash?: string) => {
        log.push(`setup:${id}:${hash ?? "-"}`);
        return hash ? { status: "ready" as const, indexed: true } : userPays(id === 1 ? "Ethereum" : "Base");
      }),
      payFee: vi.fn(async (_tx, id: number) => { log.push(`pay:${id}`); return `0xh${id}`; }),
    });
    toReview(api); const onCreated = (api as unknown as { onCreated: ReturnType<typeof vi.fn> }).onCreated;
    pick("Ethereum");
    await waitFor(() => expect(screen.getByTestId("fee-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee on Base" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee on Ethereum" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ address: ADDR, name: "My Safe", chainIds: [8453, 1] }));
    expect(log).toEqual(["setup:8453:-", "pay:8453", "setup:8453:0xh8453", "setup:1:-", "pay:1", "setup:1:0xh1"]);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("shows Waiting / Paying / Done per network, and the fee sentence only once", async () => {
    const api = fakeApi(paid, { setup: vi.fn(async (_a: string, id: number, hash?: string) => hash ? { status: "ready" as const, indexed: true } : userPays(id === 1 ? "Ethereum" : "Base")) });
    toReview(api);
    pick("Ethereum");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await screen.findByRole("button", { name: "Pay the setup fee on Base" });
    expect(screen.getByTestId("net-8453").textContent).toMatch(/Paying/);
    expect(screen.getByTestId("net-1").textContent).toMatch(/Waiting/);
    fireEvent.click(screen.getByRole("button", { name: "Pay the setup fee on Base" }));
    await screen.findByRole("button", { name: "Pay the setup fee on Ethereum" });
    expect(screen.getByTestId("net-8453").textContent).toMatch(/Done/);
    expect(document.body.textContent!.split("one-time network fee").length - 1).toBe(1);
    expect(screen.getByRole("status").textContent).toMatch(/Ethereum costs/);
  });

  it("a failed network can be retried and the paid ones are not paid again", async () => {
    let fail = true;
    const api = fakeApi(paid, {
      setup: vi.fn(async (_a: string, id: number, hash?: string) => hash ? { status: "ready" as const, indexed: true } : userPays(id === 1 ? "Ethereum" : "Base")),
      payFee: vi.fn(async (_tx, id: number) => { if (id === 1 && fail) { fail = false; throw new Error("User rejected"); } return `0xh${id}`; }),
    });
    toReview(api); const onCreated = (api as unknown as { onCreated: ReturnType<typeof vi.fn> }).onCreated;
    pick("Ethereum");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee on Base" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee on Ethereum" }));
    await screen.findByText("User rejected");
    expect(screen.getByTestId("net-1").textContent).toMatch(/Failed/);
    expect(screen.getByTestId("net-8453").textContent).toMatch(/Done/);
    fireEvent.click(screen.getByRole("button", { name: "Pay the setup fee on Ethereum" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect((api.payFee as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual([8453, 1, 1]);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("with only a network the app does not lend on, it does not wait for the index", async () => {
    const api = fakeApi(sponsored);
    toReview(api); const onCreated = (api as unknown as { onCreated: ReturnType<typeof vi.fn> }).onCreated;
    pick("Gnosis"); pick("Base");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ address: ADDR, name: "My Safe", chainIds: [100] }));
    expect(api.indexed).not.toHaveBeenCalled();
  });
});

describe("CreateSafe recovery", () => {
  const KEY = createProgressKey(ME, ADDR);
  const toReview = () => { next(); next(); };
  const tx = { to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", data: "0x1688f0b9" } as const;
  const userPays = () => ({ status: "user_pays" as const, cost: paid.cost, tx });

  it("an indexing service that keeps answering not-yet leaves a saved, resumable pending setup", async () => {
    let ready = false;
    const api = fakeApi(sponsored, { indexed: vi.fn(async () => ready) });
    const onCreated = vi.fn();
    render(<CreateSafe wallet={ME} api={api} onCreated={onCreated} onCancel={vi.fn()} pollMs={1} indexWaitMs={5} />);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address").textContent).toContain("0x6015"));
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await screen.findByRole("button", { name: "Check again" });
    // The record of what was set up: name and address, no claim that the Safe is listed.
    expect(screen.getByText(/My Safe/)).toBeTruthy();
    expect(screen.getByText(/0x6015…50aA/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave and finish later" })).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeTruthy();
    ready = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ address: ADDR, name: "My Safe", chainIds: [8453] }));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a paid setup that stalls on indexing keeps the payment hash, so resume re-checks instead of repaying", async () => {
    let ready = false;
    const api = fakeApi(paid, {
      setup: vi.fn().mockResolvedValueOnce(userPays()).mockResolvedValue({ status: "ready", indexed: true }),
      indexed: vi.fn(async () => ready),
      payFee: vi.fn(async (_t, _c, onSent) => { onSent?.("0xhash"); return "0xhash"; }),
    });
    const onCreated = vi.fn();
    render(<CreateSafe wallet={ME} api={api} onCreated={onCreated} pollMs={1} indexWaitMs={5} />);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee" }));
    await screen.findByRole("button", { name: "Check again" });
    const saved = JSON.parse(localStorage.getItem(KEY)!);
    expect(saved.hashes[8453]).toBe("0xhash");
    expect(saved.name).toBe("My Safe");
    ready = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.payFee).toHaveBeenCalledTimes(1);
  });

  it("Leave and finish later hands back to the picker with the setup still saved", async () => {
    const api = fakeApi(paid, { setup: vi.fn().mockResolvedValueOnce(userPays()).mockResolvedValue({ status: "ready", indexed: true }) });
    const onCancel = vi.fn();
    render(<CreateSafe wallet={ME} api={api} onCreated={vi.fn()} onCancel={onCancel} pollMs={1} />);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await screen.findByRole("button", { name: "Pay the setup fee" });
    fireEvent.click(screen.getByRole("button", { name: "Leave and finish later" }));
    expect(onCancel).toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeTruthy();
  });

  it("resume: continues a saved setup without signing again, and a stored payment hash is re-checked not repaid", async () => {
    localStorage.setItem(KEY, JSON.stringify({ address: ADDR, name: "Holiday", chainIds: [8453], hashes: { 8453: "0xhash" } }));
    const api = fakeApi(sponsored);
    const onCreated = vi.fn();
    render(<CreateSafe wallet={ME} api={api} resume={{ address: ADDR, name: "Holiday", chainIds: [8453] }} onCreated={onCreated} pollMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ address: ADDR, name: "Holiday", chainIds: [8453] }));
    expect(api.create).not.toHaveBeenCalled();
    expect(api.payFee).not.toHaveBeenCalled();
    expect(api.setup).toHaveBeenCalledWith(ADDR, 8453, "0xhash");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a rapid second submit while the wallet transaction is in flight does not start another", async () => {
    let release!: (h: string) => void;
    const api = fakeApi(paid, {
      setup: vi.fn().mockResolvedValueOnce(userPays()).mockResolvedValue({ status: "ready", indexed: true }),
      payFee: vi.fn(() => new Promise<string>((res) => { release = res; })),
    });
    const onCreated = vi.fn();
    render(<CreateSafe wallet={ME} api={api} onCreated={onCreated} pollMs={1} />);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    const pay = await screen.findByRole("button", { name: "Pay the setup fee" });
    fireEvent.click(pay);
    fireEvent.click(pay);
    expect(api.payFee).toHaveBeenCalledTimes(1);
    release("0xhash");
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("Leave during the indexing wait stops the flow: no navigation, the record survives", async () => {
    let ready = false;
    const api = fakeApi(sponsored, { indexed: vi.fn(async () => ready) });
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(<CreateSafe wallet={ME} api={api} onCreated={onCreated} onCancel={onCancel} pollMs={1} indexWaitMs={60_000} />);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave and finish later" }));
    expect(onCancel).toHaveBeenCalled();
    unmount();
    ready = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(onCreated).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeTruthy();
  });

  it("Leave while the next network is being set up stops the flow from finishing it", async () => {
    let releaseSetup!: () => void;
    const api = fakeApi({ ...paid, networks: [{ chainId: 8453, sponsored: false, cost: paid.cost }, { chainId: 1, sponsored: true, cost: "free" }] }, {
      setup: vi.fn(async (_a: string, id: number, hash?: string) => {
        if (hash) return { status: "ready" as const, indexed: true };
        if (id === 8453) return userPays();
        await new Promise<void>((r) => { releaseSetup = r; });
        return { status: "ready" as const, indexed: true };
      }),
      payFee: vi.fn(async () => "0xh8453"),
    });
    const onCreated = vi.fn();
    const { unmount } = render(<CreateSafe wallet={ME} api={api} onCreated={onCreated} onCancel={vi.fn()} pollMs={1} />);
    toReview();
    fireEvent.click(screen.getByLabelText("Ethereum"));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee on Base" }));
    await waitFor(() => expect(api.setup).toHaveBeenCalledWith(ADDR, 1));
    fireEvent.click(screen.getByRole("button", { name: "Leave and finish later" }));
    unmount();
    releaseSetup();
    await new Promise((r) => setTimeout(r, 30));
    expect(onCreated).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeTruthy();
  });

  it("a payment already sent still has its hash recorded when the user leaves mid-flight", async () => {
    let release!: (h: string) => void;
    const api = fakeApi(paid, {
      setup: vi.fn().mockResolvedValueOnce(userPays()).mockResolvedValue({ status: "ready", indexed: true }),
      payFee: vi.fn((_t, _c, onSent) => new Promise<string>((res) => { onSent?.("0xhash"); release = res; })),
    });
    const { unmount } = render(<CreateSafe wallet={ME} api={api} onCreated={vi.fn()} onCancel={vi.fn()} pollMs={1} />);
    toReview();
    await waitFor(() => expect(screen.getByTestId("safe-address")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee" }));
    await waitFor(() => expect(api.payFee).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Leave and finish later" }));
    unmount();
    release("0xhash");
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.parse(localStorage.getItem(KEY)!).hashes[8453]).toBe("0xhash");
  });

  it("resume without a stored payment re-asks the server and stops at the unpaid network", async () => {
    const api = fakeApi(sponsored, { setup: vi.fn().mockResolvedValueOnce(userPays()).mockResolvedValue({ status: "ready", indexed: true }) });
    const onCreated = vi.fn();
    render(<CreateSafe wallet={ME} api={api} resume={{ address: ADDR, name: "Holiday", chainIds: [8453] }} onCreated={onCreated} pollMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    await screen.findByRole("button", { name: "Pay the setup fee" });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.setup).toHaveBeenCalledWith(ADDR, 8453);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows a local nickname while resuming without changing the saved Safe name", async () => {
    const api = fakeApi(sponsored, { setup: vi.fn().mockResolvedValue({ status: "pending" }) });
    render(<CreateSafe wallet={ME} api={api} resume={{ address: ADDR, name: "Holiday", chainIds: [8453] }} resumeDisplayName="Holiday house" onCreated={vi.fn()} pollMs={1} />);
    expect(screen.getByRole("heading", { name: "Finish setting up Holiday house" })).toBeTruthy();
    expect(screen.getByText(/Holiday house ·/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    await waitFor(() => expect(api.setup).toHaveBeenCalledWith(ADDR, 8453));
    expect(JSON.parse(localStorage.getItem(createProgressKey(ME, ADDR))!).name).toBe("Holiday");
  });

  it("persists an unknown payment outcome and never offers a second payment after reload", async () => {
    const api = fakeApi(paid, {
      setup: vi.fn().mockResolvedValueOnce(userPays()),
      payFee: vi.fn(() => new Promise<string>(() => {})),
    });
    const { unmount } = render(<CreateSafe wallet={ME} api={api} onCreated={vi.fn()} pollMs={1} />);
    toReview();
    await screen.findByTestId("safe-address");
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay the setup fee" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!).paymentIntents?.[8453]).toBe("unknown"));
    unmount();
    const resumedApi = fakeApi(paid, { reconcile: vi.fn(async () => ({ status: "not_deployed" as const })) });
    render(<CreateSafe wallet={ME} api={resumedApi} resume={{ address: ADDR, name: "Holiday", chainIds: [8453] }} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    expect(await screen.findByRole("button", { name: "Check my payment" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pay the setup fee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check my payment" }));
    await waitFor(() => expect(resumedApi.reconcile).toHaveBeenCalledWith(ADDR, 8453));
    expect(resumedApi.payFee).not.toHaveBeenCalled();
    expect(resumedApi.setup).not.toHaveBeenCalled();
    expect(screen.getByText(/do not pay again until you confirm/i)).toBeTruthy();
    expect(screen.queryByText(/We do not know whether the wallet sent this payment/i)).toBeNull();
  });

  it("waits for every served selected network before completing", async () => {
    let base = false;
    let arbitrum = false;
    const api = fakeApi(sponsored, { indexed: vi.fn(async (_a, id) => id === 8453 ? base : arbitrum) });
    const onCreated = vi.fn();
    render(<CreateSafe wallet={ME} api={api} onCreated={onCreated} pollMs={1} indexWaitMs={8} />);
    toReview();
    fireEvent.click(screen.getByLabelText("Arbitrum"));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await screen.findByRole("button", { name: "Check again" });
    expect(api.indexed).toHaveBeenCalledWith(ADDR, 8453);
    expect(api.indexed).toHaveBeenCalledWith(ADDR, 42161);
    expect(onCreated).not.toHaveBeenCalled();
    base = arbitrum = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ address: ADDR, name: "My Safe", chainIds: [8453, 42161] }));
  });

  it("resume progress is on setup instead of the Name step", () => {
    const onProgress = vi.fn();
    render(<CreateSafe wallet={ME} api={fakeApi(sponsored)} resume={{ address: ADDR, name: "Holiday", chainIds: [8453] }} onCreated={vi.fn()} onProgress={onProgress} />);
    expect(onProgress).toHaveBeenLastCalledWith({ step: 2, busy: false });
  });

  it("runs a saved setup under React Strict Mode effect replay", async () => {
    const api = fakeApi(sponsored);
    const onCreated = vi.fn();
    render(<StrictMode><CreateSafe wallet={ME} api={api} resume={{ address: ADDR, name: "Holiday", chainIds: [8453] }} onCreated={onCreated} pollMs={1} /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    await waitFor(() => expect(api.setup).toHaveBeenCalledWith(ADDR, 8453));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("a retry that discovers a fee shows consent before opening the wallet", async () => {
    const api = fakeApi(paid, { setup: vi.fn().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValueOnce(userPays()).mockResolvedValue({ status: "ready", indexed: true }) });
    const onCreated = vi.fn();
    render(<CreateSafe wallet={ME} api={api} onCreated={onCreated} pollMs={1} />);
    toReview();
    await screen.findByTestId("safe-address");
    fireEvent.click(screen.getByRole("button", { name: "Create Safe" }));
    await screen.findByText("rpc down");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const pay = await screen.findByRole("button", { name: "Pay the setup fee" });
    expect(api.payFee).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("one-time network fee");
    fireEvent.click(pay);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});
