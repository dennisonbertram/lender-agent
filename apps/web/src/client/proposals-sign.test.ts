// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { hashTypedData } from "viem";
import { createElement, type ReactNode } from "react";
import { ApiError } from "@/client/http";
import { ProposalActionError, toActionError, useSignProposal } from "./proposals-sign";

const wagmi = vi.hoisted(() => ({ signTypedDataAsync: vi.fn(() => Promise.resolve("0xsig")) }));
vi.mock("wagmi", () => ({
  useAccount: () => ({ chainId: 8453 }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useSignTypedData: () => ({ signTypedDataAsync: wagmi.signTypedDataAsync }),
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
}));

describe("toActionError", () => {
  it("maps wallet rejection, unsupported methods, chain errors and API statuses", () => {
    expect(toActionError({ name: "UserRejectedRequestError", code: 4001, message: "User rejected the request." }).kind).toBe("wallet_rejected");
    expect(toActionError({ code: 4200, message: "x" }).kind).toBe("wallet_unsupported");
    expect(toActionError({ name: "SwitchChainError", message: "Unrecognized chain" }).kind).toBe("wrong_chain");
    expect(toActionError(new ApiError(403, "no")).kind).toBe("not_owner");
    expect(toActionError(new ApiError(409, "no")).kind).toBe("not_ready");
    expect(toActionError(new ApiError(502, "no")).kind).toBe("server");
    expect(toActionError(new Error("boom"))).toMatchObject({ kind: "unknown", message: "boom" });
    const e = new ProposalActionError("simulation_failed", "x");
    expect(toActionError(e)).toBe(e);
  });
});

describe("useSignProposal beforeWallet", () => {
  it("stops before the wallet request opens when the guard says no", async () => {
    const message = { to: "0x0000000000000000000000000000000000000001", value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: "1" };
    const domain = { chainId: 8453, verifyingContract: "0x0000000000000000000000000000000000000002" };
    const types = { SafeTx: ["to:address", "value:uint256", "data:bytes", "operation:uint8", "safeTxGas:uint256", "baseGas:uint256", "gasPrice:uint256", "gasToken:address", "refundReceiver:address", "nonce:uint256"].map((x) => ({ name: x.split(":")[0], type: x.split(":")[1] })) };
    const safeTxHash = hashTypedData({ domain, types, primaryType: "SafeTx", message: { ...message, value: 0n, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: 1n } } as never);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ canSign: true, reasons: [], safeTxHash, typedData: { domain, types, message }, fields: { chainId: 8453 } }), { status: 200 }))));
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: new QueryClient() }, children);
    const { result } = renderHook(() => useSignProposal("0xabc", "p1", { beforeWallet: () => false }), { wrapper });
    await expect(result.current.mutateAsync()).rejects.toMatchObject({ kind: "cancelled" });
    expect(wagmi.signTypedDataAsync).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
