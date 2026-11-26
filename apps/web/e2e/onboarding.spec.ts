import { expect, test } from "@playwright/test";
import { MOCK_EMPTY_SAFE, MOCK_SAFE, resetWorld, signIn } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

test("E2E-1: connect, pick a Safe, read can / cannot, add the agent, land on the funded greeting", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: /2 of 2 owners must approve each transaction/ })).toBeVisible();
  await page.getByRole("button", { name: /2 of 2 owners/ }).click();

  await expect(page.getByText("Safe calls this role a proposer.")).toBeVisible();
  await expect(page.getByText("See your balances")).toBeVisible();
  await expect(page.getByText("Suggest transactions for you to sign")).toBeVisible();
  await expect(page.getByText("Sign or approve anything")).toBeVisible();
  await expect(page.getByText("Move money on its own")).toBeVisible();
  await expect(page.locator("input[type=password], input[name*=key i], input[name*=seed i], textarea")).toHaveCount(0);

  await page.getByRole("button", { name: "Add Lender agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${MOCK_SAFE}/chat`, "i"));
  await expect(page.getByRole("main").getByText(/You can borrow up to \$[\d,]+ against the crypto in .*I only suggest; you and your co-signers approve every transaction here in the app\./)).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: /^Borrow \$/ })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "How does this work?" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "Compare lenders" })).toBeVisible();
});

test("E2E-1: an empty Safe greets with Add funds", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /Only you approve transactions/ }).click();
  await page.getByRole("button", { name: "Add Lender agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${MOCK_EMPTY_SAFE}/chat`, "i"));
  await expect(page.getByRole("main").getByText(/empty/i)).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "Add funds" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "How does this work?" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: /^Borrow \$/ })).toHaveCount(0);
});
