import { expect, test, type Page } from "@playwright/test";
import { MOCK_SAFE, resetWorld, setupChat } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

const PROPOSAL_URL = new RegExp(`/s/${MOCK_SAFE}/proposals/`, "i");

/** Ask for $1,000 and wait for the plan card, like `sendLoanProposal`, but stop before the approve click. */
async function askForPlan(page: Page) {
  const main = page.getByRole("main");
  await main.getByRole("textbox", { name: "Message" }).fill("I need $1,000");
  await main.getByRole("button", { name: "Send", exact: true }).click();
  await expect(main.getByText(/You get \$1,000 as /)).toBeVisible();
  await expect(main.getByText(/Checked: this would work/)).toBeVisible();
}

/** The owner's free approval was recorded by the mock wallet: the page counts it and lists the owner as approved. */
async function expectOwnerApproved(page: Page) {
  await expect(page.getByRole("main").getByText("1 of 2 approved")).toBeVisible({ timeout: 20_000 });
}

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test("chat: Approve in your wallet opens the proposal and records the owner's approval once", async ({ page }) => {
      await setupChat(page);
      await askForPlan(page);
      await page.getByRole("main").getByRole("button", { name: "Approve in your wallet" }).click();
      await expect(page).toHaveURL(PROPOSAL_URL, { timeout: 15_000 });
      await expectOwnerApproved(page);

      // The intent was consumed: a reload shows the same count and asks the wallet for nothing more.
      const url = page.url();
      await page.reload();
      await expect(page).toHaveURL(url);
      await expectOwnerApproved(page);
      await expect(page.getByRole("main").getByText("2 of 2 approved")).toHaveCount(0);
      await expect(page.getByRole("main").getByRole("button", { name: /Approve in your wallet/ })).toHaveCount(0);
    });

    test("get cash: one screen, Approve in your wallet lands on the proposal with the owner approved", async ({ page }) => {
      await setupChat(page);
      await page.goto(`/s/${MOCK_SAFE}/get-cash`);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: "How much cash do you need?" })).toBeVisible();
      // no step bar
      await main.getByRole("textbox", { name: "Cash you need" }).fill("1000");
      const approve = main.getByRole("button", { name: "Approve in your wallet" });
      await expect(approve).toBeEnabled({ timeout: 20_000 });
      await approve.click();
      await expect(page).toHaveURL(PROPOSAL_URL, { timeout: 15_000 });
      await expectOwnerApproved(page);
    });

    test("get cash with a plan already waiting: Finish your open request first, a different plan on request", async ({ page }) => {
      await setupChat(page);
      await askForPlan(page);
      await page.getByRole("main").getByRole("button", { name: "Approve in your wallet" }).click();
      await expect(page).toHaveURL(PROPOSAL_URL, { timeout: 15_000 });
      await expectOwnerApproved(page);

      await page.goto(`/s/${MOCK_SAFE}/get-cash`);
      const main = page.getByRole("main");
      await expect(main.getByRole("link", { name: "Finish your open request" })).toBeVisible();
      await expect(main.getByRole("button", { name: "Approve in your wallet" })).toHaveCount(0);
      await main.getByRole("button", { name: "Start a different plan anyway" }).click();
      await main.getByRole("textbox", { name: "Cash you need" }).fill("500");
      const approve = main.getByRole("button", { name: "Approve in your wallet" });
      await expect(approve).toBeEnabled({ timeout: 20_000 });
      await approve.click();
      await expect(page).toHaveURL(PROPOSAL_URL, { timeout: 15_000 });
      await expectOwnerApproved(page);
    });
  });
}
