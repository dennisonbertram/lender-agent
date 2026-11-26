import { expect, test } from "@playwright/test";
import { COSIGNER, MOCK_SAFE, OWNER, resetWorld, safeWallet, sendLoanProposal, setupChat } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

test("E2E-2: I need $1,000 → plan → Approve in your wallet → signed and executed → loan on overview and dashboard", async ({ page, request }) => {
  await setupChat(page);
  const hash = await sendLoanProposal(page);

  await safeWallet.confirm(request, hash, OWNER);
  await safeWallet.confirm(request, hash, COSIGNER);
  await safeWallet.execute(request, hash);
  await expect(page.getByRole("log").getByText("Done", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("log").getByRole("link", { name: "View loan" })).toBeVisible();

  await page.goto(`/s/${MOCK_SAFE}`);
  // The loan row says what is locked and owed, then how far ETH can fall (overview-07).
  await expect(page.getByRole("main").getByText(/ETH locked · \$1,000 USDC owed/)).toBeVisible();
  await expect(page.getByRole("main").getByText(/ETH can fall \d+(\.\d+)?% before liquidation/)).toBeVisible();
  await page.getByRole("main").getByText(/\$1,000 USDC owed/).first().click();
  await expect(page).toHaveURL(/\/loans\//);
  await page.getByText("Health details", { exact: true }).click();
  for (const label of ["Health factor", "Borrowed", "Collateral", "Interest"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
});

// VC-03: needs the price knob (docs/ux-app/_scripts/r3-server.cjs); skipped on the stock server.
test("VC-03: at risk, the chat offers no Borrow chip and the loan page has one red block with a chosen fix", async ({ page, request }) => {
  const knob = await request.get("/__price?ETH=3000");
  test.skip(!knob.ok(), "needs the r3-server price knob");
  test.setTimeout(240_000);
  await setupChat(page);
  const hash = await sendLoanProposal(page);
  await safeWallet.confirm(request, hash, OWNER);
  await safeWallet.confirm(request, hash, COSIGNER);
  await safeWallet.execute(request, hash);
  await expect(page.getByRole("log").getByText("Done", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("log").getByRole("link", { name: "View loan" })).toBeVisible();
  await request.get("/__price?ETH=1000");
  await expect(page.getByRole("main").getByText(/Liquidation means/).first()).toBeVisible({ timeout: 200_000 });
  await expect(page.getByRole("main").getByRole("button", { name: /borrow/i })).toHaveCount(0);

  await page.goto(`/s/${MOCK_SAFE}`);
  await page.getByText(/Borrowed \$1,000/).first().click();
  const block = page.getByTestId("loan-risk");
  await expect(block).toBeVisible();
  await expect(block.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("main").locator("[class*='bg-destructive/10']")).toHaveCount(1);
  await block.locator("button[aria-pressed=false]").first().click();
  await expect(block.locator("button[aria-pressed=true]")).toHaveCount(1);
  await expect(block.getByRole("button", { name: "Choose another" })).toBeVisible();
  await expect(block.getByRole("button", { name: "Send to Safe" })).toBeVisible();
});

test("VC-04: an unknown loan shows an error card with the sidebar visible", async ({ page }) => {
  await setupChat(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/s/${MOCK_SAFE}/loans/nope`);
  await expect(page.getByRole("main").getByRole("alert").getByRole("heading")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("aside").first()).toBeVisible();
});
