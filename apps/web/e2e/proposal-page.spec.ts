import { expect, test } from "@playwright/test";
import { MOCK_SAFE, resetWorld, sendLoanProposal, setupChat, useWallet } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

async function openProposal(page: import("@playwright/test").Page) {
  await useWallet(page, "owner");
  await setupChat(page);
  await sendLoanProposal(page);
  const list = await (await page.request.get(`/api/safes/${MOCK_SAFE}/proposals/list?open=1`)).json();
  return ((list.proposals ?? list)[0] as { id: string }).id;
}

test("proposal page: one column, one primary, Back first (1440x900)", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await openProposal(page);
  await page.goto(`/s/${MOCK_SAFE}/proposals/${id}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(/Open a \$1,000/);
  await expect(main.getByRole("button", { name: "Approve in your wallet" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open Safe to sign/ })).toHaveCount(0);
  await expect(page.getByText(/Shown on this page/)).toBeVisible();
  const col = await main.locator("[data-state]").first().boundingBox();
  expect(col!.width).toBeLessThanOrEqual(640);
  // The first stop in the page is the way back.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const back = main.getByRole("link", { name: "Back to Activity" });
  await expect(back).toBeVisible();
  expect(await back.getAttribute("href")).toBe(`/s/${MOCK_SAFE}/activity`);
  const firstFocusable = await main.evaluate((m) => (m.querySelector("a[href], button, input") as HTMLElement | null)?.textContent ?? "");
  expect(firstFocusable).toMatch(/Back to Activity/);
});

test("the chat thread shows the short summary card, not the full sign UI (390x844)", async ({ page }) => {
  test.setTimeout(120_000);
  const id = await openProposal(page);
  await page.goto(`/s/${MOCK_SAFE}/chat`);
  await expect(page.getByRole("link", { name: "Review and approve" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Approve in your wallet" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${MOCK_SAFE}/proposals/${id}`);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /Lender agent|Ask the agent/i }).first().click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Review and approve" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
