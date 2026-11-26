import { expect, test } from "@playwright/test";
import { COSIGNER, MOCK_SAFE, OWNER, resetWorld, safeWallet, useWallet, sendLoanProposal, setupChat } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

test("E2E-3: co-signer sees the same proposal; owner sees 1 of 2 signed, then Done", async ({ page, browser, request }) => {
  // Two status changes, each seen within one card poll (about 30 s, BP-15 NFR).
  test.setTimeout(180_000);
  await useWallet(page, "owner");
  await setupChat(page);
  const hash = await sendLoanProposal(page);
  const list = await (await page.request.get(`/api/safes/${MOCK_SAFE}/proposals/list?open=1`)).json();
  const first = (list.proposals ?? list)[0] as { id: string };
  const owner = await (await page.request.get(`/api/safes/${MOCK_SAFE}/proposals/${first.id}`)).json();

  // The co-signer opens the link.
  const ctx = await browser.newContext();
  const cosigner = await ctx.newPage();
  await useWallet(cosigner, "cosigner");
  await cosigner.goto("/");
  await cosigner.getByRole("button", { name: "Connect wallet" }).click();
  await expect(cosigner).toHaveURL(/\/onboarding/);
  await cosigner.goto(`/s/${MOCK_SAFE}/proposals/${first.id}`);
  const view = cosigner.getByRole("main");
  const p = owner.proposal as { title: string; steps: string[]; safeTxHash: string };
  await expect(view.getByText(p.title).first()).toBeVisible();
  await view.getByText("Steps in this transaction").click();
  for (const step of p.steps) await expect(view.getByRole("listitem").filter({ hasText: step }).first()).toBeVisible();
  await view.getByText("Technical details").click();
  await expect(view.getByText(p.safeTxHash)).toBeVisible();
  // The co-signer is an owner: the page offers the in-app approval.
  await expect(view.getByRole("button", { name: "Approve in your wallet" })).toBeVisible();

  // A stranger gets no data.
  const sctx = await browser.newContext();
  const stranger = await sctx.newPage();
  await useWallet(stranger, "stranger");
  await stranger.goto("/");
  await stranger.getByRole("button", { name: "Connect wallet" }).click();
  await expect(stranger).toHaveURL(/\/onboarding/);
  const res = await stranger.request.get(`/api/safes/${MOCK_SAFE}/proposals/${first.id}`);
  expect(res.ok()).toBeFalsy();
  await stranger.goto(`/s/${MOCK_SAFE}/proposals/${first.id}`);
  await expect(stranger.getByText(owner.proposal.sentence)).toHaveCount(0);
  await expect(stranger.getByText(hash.slice(0, 10))).toHaveCount(0);
  // The co-signer approves (here through the Safe{Wallet} stand-in); the owner's page moves on its own.
  await safeWallet.confirm(request, hash, COSIGNER);
  await page.goto(`/s/${MOCK_SAFE}/proposals/${first.id}`);
  await expect(page.getByRole("main").getByRole("heading", { name: "Your co-owner approved. Now it's you" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("main").getByText("1 of 2 approved")).toBeVisible();
  // The co-signer's own view: they approved, so the page waits for the other owner.
  await cosigner.reload();
  await expect(cosigner.getByRole("main").getByRole("heading", { name: "Waiting for your co-owner" })).toBeVisible();
  await expect(cosigner.getByRole("main").getByText("1 of 2 approved")).toBeVisible();
  await expect(cosigner.getByRole("main").getByText(/co-signer/i)).toHaveCount(0);
  // Reject asks first, and "Keep it" sends nothing.
  await page.getByRole("main").getByRole("button", { name: /^Reject:/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Reject this plan?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect(dialog).toHaveCount(0);
  await safeWallet.confirm(request, hash, OWNER);
  await safeWallet.execute(request, hash);
  await expect(page.getByRole("main").getByRole("heading", { name: "Your loan is open" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("main").getByText(/You borrowed 1,000 USDC from Morpho and locked [\d.]+ ETH\./)).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: /View loan|Go to overview/ })).toHaveCount(1);

  await ctx.close();
  await sctx.close();
});

test("VC-06: a signed-out deep link signs in and comes back to the same page", async ({ page }) => {
  await useWallet(page, "owner");
  const path = `/s/${MOCK_SAFE}/activity`;
  await page.goto(path);
  await page.getByRole("alert").getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/\?next=/);
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`, "i"));
});
