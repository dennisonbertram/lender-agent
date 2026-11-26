import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeContext, reserveNowOption, useReserveNow } = vi.hoisted(() => ({
  safeContext: vi.fn(),
  reserveNowOption: vi.fn(),
  useReserveNow: vi.fn(),
}));

vi.mock("@/server/request", () => ({ safeContext }));
vi.mock("@/server/reserve/executor", () => ({ reserveNowOption, useReserveNow }));

import { GET, POST } from "./route";

const params = { params: Promise.resolve({ address: "0xmain" }) };
const binding = {
  loanId: "8453:0xmain:aave-v3", reserveSafe: "0xreserve", linkFingerprint: "fingerprint", triggerHf: 1.2,
  policyMaxRefillRaw: "1000000000", policyRefillRaw: "1000000000", policyPeriodRaw: "86400",
  allowanceBalanceRaw: "1000000000", allowanceTimestampRaw: "1", reserveBalanceRaw: "2000000000", maxAmountRaw: "500000000",
};

beforeEach(() => {
  safeContext.mockResolvedValue({ safe: { id: 1 } });
  reserveNowOption.mockReset();
  useReserveNow.mockReset().mockResolvedValue({ status: "done" });
});

describe("reserve use-now API", () => {
  it("returns the enabled option for the requested loan", async () => {
    reserveNowOption.mockResolvedValue({ enabled: true, binding });
    const res = await GET(new Request(`http://localhost/api/safes/0xmain/reserve/use-now?loanId=${encodeURIComponent(binding.loanId)}`), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, binding });
    expect(reserveNowOption).toHaveBeenCalledWith({ safe: { id: 1 } }, binding.loanId);
  });

  it.each([
    [{ loanId: binding.loanId, confirm: true }, "Refresh the reserve quote before using it."],
    [{ loanId: binding.loanId, confirm: false, binding }, "Confirm to use the reserve."],
    [{ loanId: binding.loanId, confirm: true, binding: { ...binding, triggerHf: "1.2" } }, "Refresh the reserve quote before using it."],
  ])("rejects a malformed or unconfirmed quote before the executor runs", async (body, message) => {
    const res = await POST(new Request("http://localhost/api/safes/0xmain/reserve/use-now", { method: "POST", body: JSON.stringify(body) }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: message });
    expect(useReserveNow).not.toHaveBeenCalled();
  });

  it("forwards the exact binding only after explicit confirmation", async () => {
    const res = await POST(new Request("http://localhost/api/safes/0xmain/reserve/use-now", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loanId: binding.loanId, confirm: true, binding }),
    }), params);
    expect(res.status).toBe(200);
    expect(useReserveNow).toHaveBeenCalledWith({ safe: { id: 1 } }, binding.loanId, { confirm: true, binding });
  });
});
