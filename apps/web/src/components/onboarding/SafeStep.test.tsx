// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { shortAddress } from "@/lib/address";
import { SafeStep } from "./SafeStep";

afterEach(cleanup);
const A = "0x5AfE5afe5AFe5afE5afE5aFe5afe5aFE5AFE0001";

describe("SafeStep", () => {
  it("lists found Safes with the approvals line and picks one", () => {
    const onPick = vi.fn();
    render(<SafeStep found={[{ address: A, threshold: 2, ownerCount: 3, chainIds: [8453] }]} existing={[]} onPick={onPick} onAdd={() => {}} />);
    expect(screen.getByText("2 of 3 owners must approve each transaction")).toBeTruthy();
    fireEvent.click(screen.getByText("Address and signers"));
    expect(screen.getByText(/^0x5a.{2}…0001$/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /2 of 3 owners/ }));
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
    expect(screen.getByText("Approvals on Base: Only you approve transactions.")).toBeTruthy();
    expect(screen.getByText("Total across Base and Arbitrum")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Arbitrum" }));
    expect(screen.getByText("Approvals on Arbitrum: 2 of 2 owners must approve each transaction")).toBeTruthy();
    fireEvent.click(screen.getByText("Address and signers on Arbitrum"));
    expect(screen.getByRole("link", { name: "View on Arbiscan" })).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.queryByText("Only you approve transactions.")).toBeNull();
  });
  it("does not call a partially measured zero balance empty", () => {
    render(<SafeStep found={[{
      address: A, threshold: 1, ownerCount: 1, chainIds: [8453, 42161], balanceUsd: 0, balanceChainIds: [8453],
    }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByText("$0 found on Base. Other balances are unavailable.")).toBeTruthy();
    expect(screen.queryByText("Empty. Add funds before borrowing.")).toBeNull();
  });
  it("replaces a discovered partial setup with its single recovery action and suppresses the saved duplicate", () => {
    render(<SafeStep found={[{ address: A, name: "Holiday", threshold: 2, ownerCount: 3, chainIds: [8453, 42161] }]} known={[
      { address: A.toLowerCase(), name: "Holiday saved", chainIds: [8453, 42161] },
      { address: A.toLowerCase(), name: "Holiday setup", pendingSetup: true, chainIds: [8453], pendingChainIds: [42161] },
    ]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.queryByRole("button", { name: /Holiday$/ })).toBeNull();
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
  it("shows name or Safe, Empty for $0, and keeps the address with copy behind Account details", () => {
    render(<SafeStep found={[{ address: A, threshold: 1, ownerCount: 1, chainIds: [8453], balanceUsd: 0 }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByText("Safe")).toBeTruthy();
    expect(screen.getByText("Empty. Add funds before borrowing.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
    fireEvent.click(screen.getByText("Address and signers"));
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View on Basescan" })).toBeTruthy();
  });
  it("leads with the balance when a Safe has no name, so identical accounts stay recognisable", () => {
    render(<SafeStep found={[{ address: A, threshold: 1, ownerCount: 1, chainIds: [8453], balanceUsd: 7500 }]} existing={[]} onPick={() => {}} onAdd={() => {}} />);
    expect(screen.getByText("$7,500 Safe")).toBeTruthy();
    expect(screen.getAllByText(/\$7,500/)).toHaveLength(1);
  });
  it("a failed lookup offers Retry and keeps already-saved Safes pickable", () => {
    const retry = vi.fn();
    const pick = vi.fn();
    render(<SafeStep found={[]} lookupFailed known={[{ address: A, name: "Holiday", chainIds: [8453] }]} existing={[A]} onPick={pick} onAdd={() => {}} onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Holiday/ }));
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
    expect(screen.queryByRole("button", { name: /2 of 3 owners/ })).toBeNull();
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
    expect(screen.getByText("Only you approve transactions.")).toBeTruthy();
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
    it("shows the dollar balance and the main assets under the name", () => {
      show({ name: "Holiday", balanceUsd: 12340.4, assets: [{ symbol: "ETH", amount: 2.1 }, { symbol: "USDC", amount: 500 }] });
      expect(screen.getByText("Holiday")).toBeTruthy();
      expect(screen.getByText("$12,340")).toBeTruthy();
      expect(screen.getByText("2.1 ETH · 500 USDC")).toBeTruthy();
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
    it("renders fine with no balance and no ENS", () => {
      show({ owners: [owner(1), owner(2)] });
      expect(screen.queryByText(/\$/)).toBeNull();
      expect(screen.getByText("2 of 3 owners must approve each transaction")).toBeTruthy();
    });
  });
});
