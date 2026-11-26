import { expect, test } from "@playwright/test";
import { COSIGNER, MOCK_SAFE, OWNER, latestProposal, resetWorld, safeWallet, sendLoanProposal, setupChat, signIn, useWallet } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

// A healthy $1,000 loan: type $200, the proposal pays exactly $200, the owners sign, it executes, and
// the loan page then reads the remaining debt (~$800, allowing for accrual).
test("repay $200 on a healthy $1,000 loan: borrower and co-owner sign in the UI, then the selected loan and USDC update", async ({ page, request, browser }) => {
  await useWallet(page, "owner");
  await setupChat(page);
  const hash = await sendLoanProposal(page);
  await safeWallet.confirm(request, hash, OWNER);
  await safeWallet.confirm(request, hash, COSIGNER);
  await safeWallet.execute(request, hash);
  await expect(page.getByRole("log").getByText("Done", { exact: true })).toBeVisible({ timeout: 45_000 });

  // Open the loan and repay $200 of it from the Safe's USDC.
  await page.goto(`/s/${MOCK_SAFE}`);
  const before = await (await page.request.get(`/api/safes/${MOCK_SAFE}/loans`)).json();
  const loansBefore = before.loans as { id: string; chainId: number; status: string; debt: { amount: number; asset: string } }[];
  const loan = loansBefore.find((item) => item.debt.asset === "USDC" && Math.abs(item.debt.amount - 1000) < 2);
  expect(loan, "the synthetic loan read contains the funded $1,000 USDC loan").toBeTruthy();
  expect(loan!.status).toBe("healthy");
  const loanId = loan!.id;
  await page.getByRole("main").getByText(/\$1,000 USDC owed/).first().click();
  await expect(page).toHaveURL(/\/loans\//);
  expect(decodeURIComponent(new URL(page.url()).pathname.split("/loans/")[1])).toBe(loanId);
  await page.getByLabel("Amount to repay").fill("200");
  await page.getByRole("button", { name: "Review repayment", exact: true }).click();
  await expect(page.getByText(/Repay 200 USDC/).first()).toBeVisible({ timeout: 15_000 });

  // The borrower approves through the normal proposal review.
  const body = await latestProposal(page, MOCK_SAFE);
  const list = (body.proposals ?? body) as { id: string; specKind: string; safeTxHash: string; loanId?: string }[];
  const repay = list.find((p) => p.specKind === "repay");
  expect(repay?.safeTxHash).toBeTruthy();
  expect(repay?.loanId).toBe(loanId);
  await page.goto(`/s/${MOCK_SAFE}/proposals/${repay!.id}`);
  await page.getByRole("button", { name: "Approve in your wallet" }).click();
  await expect(page.getByText("1 of 2 approved")).toBeVisible({ timeout: 20_000 });

  // The co-owner signs and sends from a separate signed-in browser.
  const coOwnerContext = await browser.newContext();
  const coOwner = await coOwnerContext.newPage();
  await useWallet(coOwner, "cosigner");
  await signIn(coOwner);
  await coOwner.goto(`/s/${MOCK_SAFE}/proposals/${repay!.id}`);
  await coOwner.getByRole("button", { name: "Approve and send" }).click();
  await expect(coOwner.getByRole("main").getByText(/Done/).first()).toBeVisible({ timeout: 60_000 });

  // Compare the exact loan's debt and its network's USDC balance using the synthetic app reader.
  const usdcBefore = before.balancesByNetwork.find((network: { chainId: number }) => network.chainId === loan!.chainId)?.assets.find((asset: { asset: string }) => asset.asset === "USDC")?.amount;
  expect(usdcBefore).toEqual(expect.any(Number));
  const after = await (await page.request.get(`/api/safes/${MOCK_SAFE}/loans`)).json();
  const usdcAfter = after.balancesByNetwork.find((network: { chainId: number }) => network.chainId === loan!.chainId)?.assets.find((asset: { asset: string }) => asset.asset === "USDC")?.amount;
  expect(usdcAfter).toEqual(expect.any(Number));
  expect(Math.abs((usdcBefore as number) - (usdcAfter as number) - 200)).toBeLessThan(0.01);

  await coOwnerContext.close();
  await page.goto(`/s/${MOCK_SAFE}/loans/${encodeURIComponent(loanId)}`);
  await expect(page.getByText("Borrowed", { exact: true })).toBeVisible({ timeout: 45_000 });
  const afterDetail = await (await page.request.get(`/api/safes/${MOCK_SAFE}/loans/${encodeURIComponent(loanId)}`)).json();
  expect(afterDetail.loan.id).toBe(loanId);
  expect(afterDetail.loan.debt.asset).toBe("USDC");
  expect(afterDetail.loan.debt.amount).toBeGreaterThanOrEqual(799);
  expect(afterDetail.loan.debt.amount).toBeLessThanOrEqual(801);
  await expect(page.getByRole("main").getByText(/800 USDC/)).toBeVisible();
});
