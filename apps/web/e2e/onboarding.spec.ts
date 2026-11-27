import { expect, test } from "@playwright/test";
import { MOCK_EMPTY_SAFE, MOCK_SAFE, resetWorld, shortAddress, signIn } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

test("the Safe picker uses viewport width for its card grid and top-aligns cards while details are open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const yourSafes = page.getByRole("list", { name: "Your Safes" });
  const grid = yourSafes.locator("xpath=..");
  const layout = await grid.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
      left: rect.left,
      right: window.innerWidth - rect.right,
      alignItems: style.alignItems,
    };
  });
  expect(layout.columns).toBeGreaterThanOrEqual(4);
  expect(layout.left).toBeGreaterThanOrEqual(24);
  expect(layout.left).toBeLessThanOrEqual(40);
  expect(layout.right).toBeGreaterThanOrEqual(24);
  expect(layout.right).toBeLessThanOrEqual(40);
  expect(layout.alignItems).not.toMatch(/^(start|flex-start|flow-start)$/);
  await yourSafes.getByRole("listitem").first().getByRole("button", { name: /^Address/ }).click();
  await expect.poll(() => grid.evaluate((element) => getComputedStyle(element).alignItems)).toMatch(/^(start|flex-start|flow-start)$/);
});

test("E2E-1: connect, pick a Safe, read can / cannot, add the agent, land on the funded greeting", async ({ page }) => {
  await signIn(page);
  const yourSafes = page.getByRole("list", { name: "Your Safes" });
  // The seeded funded Safe is the first row; pick that card by its own identity, not whichever opens.
  await expect(yourSafes.getByRole("listitem").first()).toContainText(shortAddress(MOCK_SAFE));
  const funded = yourSafes.getByRole("listitem").filter({ hasText: shortAddress(MOCK_SAFE) });
  // Its approval policy and token details sit behind the card's account disclosure.
  await funded.getByRole("button", { name: /^(Address|Account)/ }).click();
  await expect(funded).toContainText("$7,500");
  await expect(funded).toContainText("2.5 ETH");
  await expect(funded).toContainText("2 of 2 owners must approve each transaction");
  await funded.getByRole("button", { name: /Open Safe/ }).click();

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
  const yourSafes = page.getByRole("list", { name: "Your Safes" });
  // The seeded empty Safe is the second card; pick that card by its own identity, not position.
  await expect(yourSafes.getByRole("listitem").nth(1)).toContainText(shortAddress(MOCK_EMPTY_SAFE));
  const empty = yourSafes.getByRole("listitem").filter({ hasText: shortAddress(MOCK_EMPTY_SAFE) });
  await empty.getByRole("button", { name: /^(Address|Account)/ }).click();
  await expect(empty).toContainText("No supported funds found.");
  await expect(empty).toContainText("Only you approve transactions");
  await empty.getByRole("button", { name: /Open Safe/ }).click();
  await page.getByRole("button", { name: "Add Lender agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${MOCK_EMPTY_SAFE}/chat`, "i"));
  await expect(page.getByRole("main").getByText(/empty/i)).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "Add funds" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "How does this work?" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: /^Borrow \$/ })).toHaveCount(0);
});
