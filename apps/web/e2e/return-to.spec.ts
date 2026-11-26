import { expect, test } from "@playwright/test";
import { MOCK_SAFE, resetWorld, useWallet } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

async function connectAndSignIn(page: import("@playwright/test").Page, name = "Sign in with wallet") {
  await page.getByRole("button", { name }).click();
}

test("sign-in with a valid next returns to that page", async ({ page }) => {
  await useWallet(page, "cosigner");
  const target = `/s/${MOCK_SAFE}/activity`;
  await page.goto(`/?next=${encodeURIComponent(target)}`);
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByText("You will go back to the page you opened.")).toBeVisible();
  await connectAndSignIn(page);
  await expect(page).toHaveURL(new RegExp(`${target}$`));
});

test("a hostile next goes to onboarding, never off-site", async ({ page }) => {
  await useWallet(page, "cosigner");
  await page.goto(`/?next=${encodeURIComponent("/..//evil.com")}`);
  await expect(page.getByRole("heading", { name: "Borrow against your crypto." })).toBeVisible();
  await connectAndSignIn(page, "Connect wallet");
  await expect(page).toHaveURL(/\/onboarding$/);
});

test("sign-in without next goes to onboarding", async ({ page }) => {
  await useWallet(page, "owner");
  await page.goto("/");
  await connectAndSignIn(page, "Connect wallet");
  await expect(page).toHaveURL(/\/onboarding$/);
});
