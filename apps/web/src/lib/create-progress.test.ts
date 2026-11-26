// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearCreateProgress, clearPaymentAttempt, createProgressKey, loadCreateProgress, markPaymentUnknown, recordPaidHash, saveCreateProgress } from "./create-progress";

const W = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const A = "0x60157EE8eA450d606F969acb7043DC2Fd6Aa50aA";

beforeEach(() => localStorage.clear());

describe("create progress", () => {
  it("saves one in-progress setup per wallet and Safe, and clears it", () => {
    expect(loadCreateProgress(W, A)).toBeNull();
    saveCreateProgress(W, { address: A, name: "Holiday", chainIds: [8453], hashes: {}, paymentIntents: {} });
    expect(loadCreateProgress(W, A)).toEqual({ address: A, name: "Holiday", chainIds: [8453], hashes: {}, paymentIntents: {} });
    clearCreateProgress(W, A);
    expect(loadCreateProgress(W, A)).toBeNull();
  });
  it("records a payment hash against the saved setup without touching the rest", () => {
    saveCreateProgress(W, { address: A, name: "Holiday", chainIds: [8453, 42161], hashes: {}, paymentIntents: {} });
    recordPaidHash(W, A, 8453, "0xhash");
    expect(loadCreateProgress(W, A)).toEqual({ address: A, name: "Holiday", chainIds: [8453, 42161], hashes: { 8453: "0xhash" }, paymentIntents: { 8453: "unknown" } });
  });
  it("keeps a wallet request unknown across reload and clears it only after explicit resolution", () => {
    saveCreateProgress(W, { address: A, name: "Holiday", chainIds: [8453], hashes: {}, paymentIntents: {} });
    markPaymentUnknown(W, A, 8453);
    expect(loadCreateProgress(W, A)?.paymentIntents).toEqual({ 8453: "unknown" });
    clearPaymentAttempt(W, A, 8453);
    expect(loadCreateProgress(W, A)?.paymentIntents).toEqual({});
  });
  it("another Safe's record and a malformed entry are left alone", () => {
    saveCreateProgress(W, { address: A, name: "Holiday", chainIds: [8453], hashes: {}, paymentIntents: {} });
    const other = "0x0000000000000000000000000000000000000009";
    expect(loadCreateProgress(W, other)).toBeNull();
    localStorage.setItem(createProgressKey(W, other), "{not json");
    expect(loadCreateProgress(W, other)).toBeNull();
    expect(loadCreateProgress(W, A)?.name).toBe("Holiday");
  });
});
