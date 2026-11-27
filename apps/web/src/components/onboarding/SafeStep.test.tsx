// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { shortAddress } from "@/lib/address";
import { SafeStep } from "./SafeStep";

afterEach(cleanup);
const A = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0001";

describe("SafeStep", () => {
  it("lists found Safes with the approvals line behind details and picks one", () => {
    const onPick = vi.fn();
    render(<SafeStep found={[{ address: A, threshold: 2, ownerCount: 3, chainIds: [8453] }]} existing={[]} onPick={onPick} onAdd={() => {}} />);
    const tile = screen.getByRole("listitem");
    fireEvent.click(within(tile).getByRole("button", { name: "Address and approvals" }));
    expect(within(tile).getByText("2 of 3 owners must approve each transaction")).toBeTruthy();
    // The same short address also titles an unnamed Safe — the disclosed row carries the full address as its title.
    expect(within(tile).getByText(/^0x5a.{2}…0001$/i, { selector: "[title]" })).toBeTruthy();
    fireEvent.click(within(tile).getByRole("button", { name: `Open Safe ${shortAddress(A)}` }));
    expect(onPick).toHaveBeenCalledWith(A);
  });
  it("filters discovered Safes by network, defaults to all, and keeps pending recovery visible", () => {
    render(<SafeStep found={[
      { address: A, name: "Base Safe", threshold: 1, ownerCount: 1, chainIds: [8453] },
      { address: "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002", name: "Arbitrum Safe", threshold: 1, ownerCount: 1, chainIds: [42161] },
      { address: "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0004", name: "Unreported Safe", threshold: 1, ownerCount: 1, chainIds: [] },
    ]} known={[{ address: "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0003", name: "Pending Safe", pendingSetup: true, chainIds: [8453] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByRole("button", { name: "All networks" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Base" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Arbitrum" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Base" }).querySelector("img")?.getAttribute("alt")).toBe("");
    expect(screen.getByText("Base Safe")).toBeTruthy();
    expect(screen.getByText("Arbitrum Safe")).toBeTruthy();
    expect(screen.getByText("Unreported Safe")).toBeTruthy();
    expect(screen.getAllByText("Network unavailable.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Base" }));
    expect(screen.getByText("Base Safe")).toBeTruthy();
    expect(screen.queryByText("Arbitrum Safe")).toBeNull();
    expect(screen.queryByText("Unreported Safe")).toBeNull();
    expect(screen.getByText("Pending Safe")).toBeTruthy();
  });
  it("keeps an All networks reset available if refreshed results remove the selected network", () => {
    const { rerender } = render(<SafeStep found={[
      { address: A, name: "Base Safe", threshold: 1, ownerCount: 1, chainIds: [8453] },
      { address: "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002", name: "Arbitrum Safe", threshold: 1, ownerCount: 1, chainIds: [42161] },
    ]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Arbitrum" }));
    rerender(<SafeStep found={[{ address: A, name: "Base Safe", threshold: 1, ownerCount: 1, chainIds: [8453] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByRole("button", { name: "All networks" })).toBeTruthy();
    expect(screen.queryByText("Base Safe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All networks" }));
    expect(screen.getByText("Base Safe")).toBeTruthy();
  });
  it("keeps a multi-network Safe selectable under each of its verified networks", () => {
    render(<SafeStep found={[{ address: A, name: "Shared Safe", threshold: 2, ownerCount: 3, chainIds: [8453, 42161] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Base" }));
    expect(screen.getByText("Shared Safe")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Arbitrum" }));
    expect(screen.getByText("Shared Safe")).toBeTruthy();
  });
  it("uses a verified recovery network for details when the recovery row is shown outside a filter", () => {
    const wallet = "0x00000000000000000000000000000000000000a1";
    render(<SafeStep wallet={wallet} found={[
      { address: A, name: "Arbitrum Safe", threshold: 2, ownerCount: 2, chainIds: [42161], owners: [{ address: wallet }, { address: "0x00000000000000000000000000000000000000b2" }] },
    ]} known={[{
      address: "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002", name: "Pending Safe", pendingSetup: true,
      chainIds: [8453, 100], pendingChainIds: [100], availableChainIds: [8453],
      discovery: { address: "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002", name: "Pending Safe", threshold: 1, ownerCount: 1, chainIds: [8453], balanceUsd: 4500, balanceChainIds: [8453], networkDetails: [{ chainId: 8453, threshold: 1, ownerCount: 1, owners: [{ address: wallet }] }] },
    }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Arbitrum" }));
    expect(screen.getByText(/Setup recovery is shown even though this Safe does not match/)).toBeTruthy();
    expect(screen.getByText("$4,500 on Base")).toBeTruthy();
    fireEvent.click(screen.getByText("Address and signers on Base"));
    expect(screen.getByRole("link", { name: "View on Basescan" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "View on Arbiscan" })).toBeNull();
  });
  it("uses approval, signer and explorer details from the selected network", () => {
    const wallet = "0x00000000000000000000000000000000000000a1";
    const coowner = "0x00000000000000000000000000000000000000b2";
    render(<SafeStep wallet={wallet} found={[{
      address: A, name: "Shared Safe", threshold: 1, ownerCount: 1, chainIds: [8453, 42161], balanceUsd: 9000,
      balanceChainIds: [8453, 42161],
      networkDetails: [
        { chainId: 8453, threshold: 1, ownerCount: 1, owners: [{ address: wallet }] },
        { chainId: 42161, threshold: 2, ownerCount: 2, owners: [{ address: wallet }, { address: coowner }] },
      ],
    }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    // The combined total carries its networks on the tile face before anything is expanded,
    // so it never reads as a single-network amount.
    expect(screen.getByText("Total across Base and Arbitrum")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Address and signers on Base" }));
    expect(screen.getByText("Approvals on Base: Only you approve transactions.")).toBeTruthy();
    // The face carries the qualifier; the disclosure does not repeat it.
    expect(screen.getAllByText("Total across Base and Arbitrum")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Arbitrum" }));
    expect(screen.getByText("Total across Base and Arbitrum")).toBeTruthy();
    expect(screen.getByText("Approvals on Arbitrum: 2 of 2 owners must approve each transaction")).toBeTruthy();
    // The disclosure stays open and follows the selected network.
    expect(screen.getByRole("link", { name: "View on Arbiscan" })).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.queryByText("Only you approve transactions.")).toBeNull();
  });
  it("does not call a partially measured zero balance empty", () => {
    render(<SafeStep found={[{
      address: A, threshold: 1, ownerCount: 1, chainIds: [8453, 42161], balanceUsd: 0, balanceChainIds: [8453],
    }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByRole("listitem").textContent).toContain("$0 found on Base. Other balances are unavailable.");
    expect(screen.queryByText("Empty. Add funds before borrowing.")).toBeNull();
  });
  it("replaces a discovered partial setup with its single recovery action and suppresses the saved duplicate", () => {
    render(<SafeStep found={[{ address: A, name: "Holiday", threshold: 2, ownerCount: 3, chainIds: [8453, 42161] }]} known={[
      { address: A.toLowerCase(), name: "Holiday saved", chainIds: [8453, 42161] },
      { address: A.toLowerCase(), name: "Holiday setup", pendingSetup: true, chainIds: [8453], pendingChainIds: [42161] },
    ]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.queryByRole("button", { name: /Open Safe/ })).toBeNull();
    expect(screen.queryByText("Holiday saved")).toBeNull();
    expect(screen.getByText("Holiday setup")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finish setting up" })).toBeTruthy();
  });
  it("shows the r21 errors in Add by address", () => {
    const onAdd = vi.fn();
    render(<SafeStep found={[]} existing={[A]} onPick={() => {}} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: "Add by address" }));
    fireEvent.click(screen.getByRole("button", { name: "Add this Safe" }));
    expect(screen.getByText("Enter an address.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Safe address/), { target: { value: "0x12" } });
    expect(screen.getByText(/^This is not a valid address/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Safe address/), { target: { value: A.toLowerCase() } });
    expect(screen.getByText("You already added this Safe.")).toBeTruthy();
    expect(onAdd).not.toHaveBeenCalled();
  });
  it("offers Create a new Safe when the flow is wired", () => {
    const onCreate = vi.fn();
    render(<SafeStep found={[]} existing={[]} onPick={() => {}} onAdd={() => {}} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a new Safe" }));
    expect(onCreate).toHaveBeenCalled();
  });
  it("an empty wallet names the wallet, asks if it is the right one and leads with Use another wallet", () => {
    const other = vi.fn();
    render(<SafeStep wallet="0x90F79bf6EB2c4f870365E785982E1f101E93b906" found={[]} loading={false} existing={[]} onPick={() => {}} onAdd={() => {}} onCreate={() => {}} onUseAnotherWallet={other} />);
    expect(screen.getByText(/No Safe found for/).textContent).toContain("0x90F7…b906");
    expect(screen.getByText(/Is this the wallet you use for your Safe\?/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a new Safe" }).className).not.toContain("bg-primary");
    expect(screen.getByRole("button", { name: "Add by address" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use another wallet" }));
    expect(other).toHaveBeenCalled();
  });
  it("shows name or the short address, Empty for $0, and keeps the address with copy behind Account details", () => {
    render(<SafeStep found={[{ address: A, threshold: 1, ownerCount: 1, chainIds: [8453], balanceUsd: 0 }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByText(shortAddress(A))).toBeTruthy();
    expect(screen.getByText("Empty. Add funds before borrowing.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
    fireEvent.click(screen.getByText("Address and approvals"));
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View on Basescan" })).toBeTruthy();
  });
  it("titles an unnamed Safe by its short address, so identical accounts stay distinct", () => {
    render(<SafeStep found={[{ address: A, threshold: 1, ownerCount: 1, chainIds: [8453], balanceUsd: 7500 }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByText(shortAddress(A))).toBeTruthy();
    expect(screen.getAllByText(/\$7,500/)).toHaveLength(1);
  });
  it("lays found Safes out as an equal-width tile grid, each tile carrying the pick action and its disclosure", () => {
    render(<SafeStep found={[
      { address: A, name: "Base Safe", threshold: 1, ownerCount: 1, chainIds: [8453], balanceUsd: 7500, balanceChainIds: [8453] },
      { address: "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002", name: "Arbitrum Safe", threshold: 1, ownerCount: 1, chainIds: [42161] },
    ]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    const grid = screen.getByRole("list", { name: "Your Safes" });
    expect(grid.className).toMatch(/\bgrid\b/);
    expect(grid.className).toMatch(/sm:grid-cols-2/);
    expect(grid.className).toMatch(/lg:grid-cols-3/);
    const tile = screen.getAllByRole("listitem")[0];
    // The tile carries identity and balance; Open Safe and the details disclosure are
    // independent controls in one bottom row, never nested in each other.
    expect(within(tile).getByText("Base Safe")).toBeTruthy();
    expect(tile.textContent).toContain("$7,500");
    const open = within(tile).getByRole("button", { name: `Open Safe Base Safe ${shortAddress(A)}` });
    const details = within(tile).getByRole("button", { name: "Address and approvals" });
    expect(open.contains(details)).toBe(false);
    expect(details.contains(open)).toBe(false);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(within(tile).getByText("Base")).toBeTruthy();
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
  });
  it("a failed lookup offers Retry and keeps already-saved Safes pickable", () => {
    const retry = vi.fn();
    const pick = vi.fn();
    render(<SafeStep found={[]} lookupFailed known={[{ address: A, name: "Holiday", chainIds: [8453] }]} existing={[A]} onPick={pick} onAdd={() => {}} onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("listitem")).getByRole("button", { name: `Open Safe Holiday ${shortAddress(A)}` }));
    expect(pick).toHaveBeenCalledWith(A);
  });
  it("a saved Safe whose setup never finished offers Finish setting up instead of a plain pick", () => {
    const resume = vi.fn();
    const pick = vi.fn();
    render(<SafeStep found={[]} known={[{ address: A, name: "New Safe", pendingSetup: true, chainIds: [8453] }]} existing={[A]} onPick={pick} onAdd={() => {}} onResume={resume} />);
    expect(screen.getByText(/not finished/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finish setting up" }));
    expect(resume).toHaveBeenCalledWith(A);
    expect(pick).not.toHaveBeenCalled();
  });
  it("a partly set up Safe says which networks are done and which remain", () => {
    render(<SafeStep found={[]} known={[{ address: A, name: "New Safe", pendingSetup: true, chainIds: [8453, 100], pendingChainIds: [100] }]} existing={[A]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByText(/done on Base/)).toBeTruthy();
    expect(screen.getByText(/finish on Gnosis/)).toBeTruthy();
  });
  it("a Safe deployed everywhere it was created but not listed yet says so", () => {
    render(<SafeStep found={[]} known={[{ address: A, name: "New Safe", pendingSetup: true, chainIds: [8453], pendingChainIds: [] }]} existing={[A]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByText(/not listed it yet/)).toBeTruthy();
  });
  it("adding by address hides the Safe cards", () => {
    render(<SafeStep found={[{ address: A, threshold: 2, ownerCount: 3, chainIds: [8453] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByText("Other options"));
    fireEvent.click(screen.getByRole("button", { name: "Add by address" }));
    expect(screen.queryByRole("button", { name: /Open Safe/ })).toBeNull();
  });
  it("marks a testnet Safe", () => {
    render(<SafeStep found={[{ address: A, threshold: 2, ownerCount: 3, chainIds: [84532] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByText("Base Sepolia (test)")).toBeTruthy();
  });
  it("with found Safes, Create is secondary and the heading says Choose a Safe", () => {
    render(<SafeStep found={[{ address: A, threshold: 2, ownerCount: 3, chainIds: [8453] }]} existing={[]} onPick={() => {}} onAdd={() => {}} onCreate={() => {}} />);
    expect(screen.getByRole("heading", { name: "Choose a Safe" })).toBeTruthy();
    fireEvent.click(screen.getByText("Other options"));
    expect(screen.getByRole("button", { name: "Create a new Safe" }).className).not.toContain("bg-primary");
  });
  it("a one-owner Safe reads Only you approve", () => {
    render(<SafeStep found={[{ address: A, threshold: 1, ownerCount: 1, chainIds: [8453] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Address and approvals" }));
    expect(screen.getByText("Only you approve transactions.")).toBeTruthy();
  });
  it("never claims an approval policy when no network is verified", () => {
    render(<SafeStep found={[{ address: A, name: "Unverified Safe", threshold: 1, ownerCount: 1, chainIds: [] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Address" }));
    expect(screen.getByText("Approval details unavailable until a network is verified.")).toBeTruthy();
    expect(screen.queryByText(/Only you approve|owners must approve/)).toBeNull();
  });
  it("expanding details does not pick, and Open Safe picks the address of its own tile", () => {
    const onPick = vi.fn();
    const B = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002";
    render(<SafeStep found={[
      { address: A, name: "First Safe", threshold: 1, ownerCount: 1, chainIds: [8453] },
      { address: B, name: "Second Safe", threshold: 1, ownerCount: 1, chainIds: [8453] },
    ]} existing={[]} onPick={onPick} onAdd={() => {}} />);
    const tiles = screen.getAllByRole("listitem");
    fireEvent.click(within(tiles[1]).getByRole("button", { name: "Address and approvals" }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(within(tiles[1]).getByRole("button", { name: `Open Safe Second Safe ${shortAddress(B)}` }));
    expect(onPick).toHaveBeenCalledWith(B);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
  it("wraps a truly unbroken long Safe name instead of overflowing the tile", () => {
    const name = `Treasury${"vault".repeat(20)}`;
    render(<SafeStep found={[{ address: A, name, threshold: 1, ownerCount: 1, chainIds: [8453] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    const title = screen.getByText(name);
    expect(title.className).toMatch(/overflow-wrap|break/);
    expect(title.closest("li")?.className).toMatch(/min-w-0/);
  });
  it("puts found and saved Safes into one Your Safes list, each Open Safe named for its own tile", () => {
    const saved = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002";
    render(<SafeStep found={[{ address: A, name: "Holiday", threshold: 1, ownerCount: 1, chainIds: [8453] }]}
      known={[{ address: saved, name: "Beach", chainIds: [8453] }]}
      existing={[]} onPick={() => {}} onAdd={() => {}} />);
    const grid = screen.getByRole("list", { name: "Your Safes" });
    expect(within(grid).getAllByRole("listitem")).toHaveLength(2);
    expect(within(grid).getByRole("button", { name: `Open Safe Holiday ${shortAddress(A)}` })).toBeTruthy();
    expect(within(grid).getByRole("button", { name: `Open Safe Beach ${shortAddress(saved)}` })).toBeTruthy();
    expect(within(grid).getByText(/Saved — your wallet is checked again/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Saved Safes" })).toBeNull();
  });
  it("marks only real Open Safe buttons for the guide — a recovery open counts, Finish setting up never does", () => {
    const openable = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002";
    const stuck = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0003";
    const first = render(<SafeStep found={[]} known={[
      { address: openable, name: "Partly open", pendingSetup: true, chainIds: [8453, 42161], openSafeChainIds: [8453] },
      { address: stuck, name: "Stuck", pendingSetup: true, chainIds: [8453] },
    ]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    const marked = [...first.container.querySelectorAll('[data-guide-target="choose-safe"]')];
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(screen.getByRole("button", { name: `Open Safe Partly open ${shortAddress(openable)}` }));
    expect(screen.getAllByRole("button", { name: "Finish setting up" })).toHaveLength(2);
    first.unmount();
    // A pending-only picker with no openable network marks nothing — no impossible guide action.
    const none = render(<SafeStep found={[]} known={[
      { address: stuck, name: "Stuck", pendingSetup: true, chainIds: [8453] },
    ]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(none.container.querySelectorAll('[data-guide-target="choose-safe"]')).toHaveLength(0);
  });
  it("keeps an out-of-filter recovery Open Safe out of the guide targets", () => {
    const onPick = vi.fn();
    const onResume = vi.fn();
    const onAdd = vi.fn();
    const arb = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002";
    const recovery = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0003";
    const { container } = render(<SafeStep found={[
      { address: arb, name: "Arbitrum Safe", threshold: 1, ownerCount: 1, chainIds: [42161] },
    ]} known={[{
      address: recovery, name: "Pending Safe", pendingSetup: true,
      chainIds: [8453, 100], pendingChainIds: [100], availableChainIds: [8453], openSafeChainIds: [8453],
    }]} existing={[]} onPick={onPick} onAdd={onAdd} onResume={onResume} />);
    fireEvent.click(screen.getByRole("button", { name: "Arbitrum" }));
    // The recovery card stays visible and openable, but it only opens on Base —
    // so the first marked Open Safe must be the in-filter Arbitrum tile's.
    const marked = [...container.querySelectorAll('[data-guide-target="choose-safe"]')];
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(screen.getByRole("button", { name: `Open Safe Arbitrum Safe ${shortAddress(arb)}` }));
    const recoveryTile = screen.getByText("Pending Safe").closest("li")!;
    const recoveryOpen = within(recoveryTile).getByRole("button", { name: `Open Safe Pending Safe ${shortAddress(recovery)}` });
    expect(recoveryOpen.getAttribute("data-guide-target")).toBeNull();
    expect(within(recoveryTile).getByRole("button", { name: "Finish setting up" })).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });
  it("labels disclosed token amounts with the networks their balances were read from, never the filter", () => {
    render(<SafeStep found={[{
      address: A, name: "Mixed", threshold: 1, ownerCount: 1, chainIds: [8453, 42161],
      balanceUsd: 4500, balanceChainIds: [8453], assets: [{ symbol: "ETH", amount: 2.1 }],
    }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Arbitrum" }));
    fireEvent.click(screen.getByRole("button", { name: "Address on Arbitrum" }));
    expect(screen.getByText("Tokens on Base: 2.1 ETH")).toBeTruthy();
  });
  it("qualifies disclosed token amounts with an unknown source when no balance network is reported", () => {
    render(<SafeStep found={[{ address: A, name: "Unknown", threshold: 1, ownerCount: 1, chainIds: [], assets: [{ symbol: "ETH", amount: 1 }] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Address" }));
    expect(screen.getByText("Tokens (source networks unreported): 1 ETH")).toBeTruthy();
  });
  it("shows the short address beside a named Safe so same-named accounts stay distinct", () => {
    const B = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0002";
    render(<SafeStep found={[
      { address: A, name: "My Safe", threshold: 1, ownerCount: 1, chainIds: [8453] },
      { address: B, threshold: 1, ownerCount: 1, chainIds: [8453] },
    ]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    const tiles = screen.getAllByRole("listitem");
    expect(within(tiles[0]).getByText("My Safe")).toBeTruthy();
    expect(within(tiles[0]).getByText(shortAddress(A))).toBeTruthy();
    // The unnamed Safe's title already is its short address — no second copy is rendered.
    expect(within(tiles[1]).getAllByText(shortAddress(B))).toHaveLength(1);
  });
  it("labels the disclosure Address and approvals when a found Safe has a policy but no signer list", () => {
    render(<SafeStep found={[{ address: A, threshold: 2, ownerCount: 3, chainIds: [8453] }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.queryByRole("button", { name: /signers/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Address and approvals" }));
    expect(screen.getByText("2 of 3 owners must approve each transaction")).toBeTruthy();
  });
  it("Cancel leaves Add by address", () => {
    render(<SafeStep found={[]} existing={[]} onPick={() => {}} onAdd={() => {}} onCreate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add by address" }));
    expect(screen.queryByRole("button", { name: "Create a new Safe" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Create a new Safe" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add by address" })).toBeTruthy();
  });
  it("a failed lookup does not claim nothing was found", () => {
    render(<SafeStep found={[]} lookupFailed existing={[]} onPick={() => {}} onAdd={() => {}} onCreate={() => {}} />);
    expect(screen.queryByText(/We did not find/)).toBeNull();
    expect(screen.getByRole("button", { name: "Create a new Safe" }).className).toContain("bg-primary");
  });
  it("while loading there is no intro sentence and Create is not the main action", () => {
    render(<SafeStep found={[]} loading existing={[]} onPick={() => {}} onAdd={() => {}} onCreate={() => {}} />);
    expect(screen.getByText("Looking for your Safes…")).toBeTruthy();
    expect(screen.queryByText(/We did not find|We found/)).toBeNull();
    expect(screen.getByRole("button", { name: "Create a new Safe" }).className).not.toContain("bg-primary");
  });
  describe("balance and signers", () => {
    const ME = "0x00000000000000000000000000000000000000a1";
    const owner = (n: number, ens?: string) => ({ address: `0x${String(n).padStart(40, "0")}`, ens });
    const base = { address: A, threshold: 2, ownerCount: 3, chainIds: [8453 as const] };
    const show = (safe: object, wallet: string | undefined = ME) =>
      render(<SafeStep found={[{ ...base, ...safe }]} wallet={wallet} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    it("shows the dollar balance under the name and the main assets behind details", () => {
      show({ name: "Holiday", balanceUsd: 12340.4, assets: [{ symbol: "ETH", amount: 2.1 }, { symbol: "USDC", amount: 500 }] });
      expect(screen.getByText("Holiday")).toBeTruthy();
      expect(screen.getByText("$12,340")).toBeTruthy();
      expect(screen.queryByText(/2\.1 ETH · 500 USDC/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Address and approvals" }));
      expect(screen.getByText("Tokens on Base: 2.1 ETH · 500 USDC")).toBeTruthy();
    });
    it("shows ENS names, short addresses and You behind Account details", () => {
      show({ owners: [{ address: ME }, owner(2, "bob.eth"), owner(3)] });
      fireEvent.click(screen.getByText("Address and signers"));
      expect(screen.getByText("You")).toBeTruthy();
      expect(screen.getByText("bob.eth")).toBeTruthy();
      expect(screen.getByText("0x0000…0003")).toBeTruthy();
      expect(screen.getByText("2 of 3 owners must approve each transaction")).toBeTruthy();
    });
    it("shows the first 3 signers and expands the rest", () => {
      show({ ownerCount: 8, owners: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => owner(n)) });
      fireEvent.click(screen.getByText("Address and signers"));
      expect(screen.queryByText("0x0000…0004")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "and 5 more" }));
      expect(screen.getByText("0x0000…0008")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Copy address" }).length).toBeGreaterThanOrEqual(8);
    });
    it("wraps a long unbroken signer name inside the disclosure instead of overflowing the tile", () => {
      const ens = `signer${"name".repeat(30)}.eth`;
      show({ owners: [{ address: ME }, owner(2, ens)] });
      fireEvent.click(screen.getByRole("button", { name: "Address and signers" }));
      expect(screen.getByText(ens).className).toMatch(/overflow-wrap|break/);
    });
    it("renders fine with no balance and no ENS", () => {
      show({ owners: [owner(1), owner(2)] });
      expect(screen.queryByText(/\$/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Address and signers" }));
      expect(screen.getByText("2 of 3 owners must approve each transaction")).toBeTruthy();
    });
  });
});
