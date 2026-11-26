// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReserveNowOption } from "@/server/reserve/executor/use-now";
import { UseReserveNow } from "./UseReserveNow";

const binding = {
  loanId: "8453:0xabc:aave-v3",
  reserveSafe: "0xdef",
  linkFingerprint: "2|0xdef|0xroles|0xexecutor",
  triggerHf: 1.15,
  policyMaxRefillRaw: "1000000000",
  policyRefillRaw: "1000000000",
  policyPeriodRaw: "86400",
  allowanceBalanceRaw: "1000000000",
  allowanceTimestampRaw: "1760000000",
  reserveBalanceRaw: "5000000000",
  maxAmountRaw: "123456789",
};

const option = (amountRaw = binding.maxAmountRaw): ReserveNowOption => ({
  enabled: true,
  block: null,
  label: "Runs now, without a signature",
  message: null,
  amount: 123.456789,
  confirm: "Use up to $123.456789 from reserve?",
  binding: { ...binding, maxAmountRaw: amountRaw },
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Use reserve now confirmation", () => {
  it("shows the full reason when a mixed-debt Aave loan cannot use the reserve", async () => {
    const message = "The reserve can only repay a Base Aave loan with one USDC debt. This loan needs another fix.";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      enabled: false, block: null, label: "This loan cannot be repaid from the reserve", message,
      amount: null, confirm: null, binding: null,
    }), { status: 200 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><UseReserveNow safeAddress="0xabc" loanId={binding.loanId} /></QueryClientProvider>);
    expect(await screen.findByText(message)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Use reserve now/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts the exact displayed binding, even if the option refreshes while the dialog is open", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ status: "done", runId: 1, txHash: "0xhash", hfBefore: 1.05, hfAfter: 1.1, message: "Done." }), { status: 200 });
      }
      return new Response(JSON.stringify(option()), { status: 200 });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><UseReserveNow safeAddress="0xabc" loanId={binding.loanId} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Use reserve now/ }));
    expect((await screen.findByRole("heading", { name: "Use up to $123.456789 from reserve?" })).textContent).toBe("Use up to $123.456789 from reserve?");
    qc.setQueryData(["reserve-now", "0xabc", binding.loanId], option("200000000"));
    fireEvent.click(screen.getByRole("button", { name: "Use reserve" }));
    await screen.findByText("Done.");
    expect(posts).toEqual([{ loanId: binding.loanId, confirm: true, binding }]);
  });
});
