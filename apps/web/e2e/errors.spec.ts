import { expect, test } from "@playwright/test";
import { MOCK_SAFE, resetWorld, setupChat, signIn, useWallet } from "./helpers";


test.beforeEach(async ({ request }) => resetWorld(request));

test("a Safe the wallet does not own shows the agent-step error fast, with a way out", async ({ page }) => {
  await useWallet(page, "stranger");
  await signIn(page);
  const t0 = Date.now();
  await page.goto(`/onboarding/agent?safe=${MOCK_SAFE}`);
  const alert = page.getByRole("alert");
  await expect(alert.getByRole("heading")).toBeVisible({ timeout: 1500 });
  expect(Date.now() - t0).toBeLessThan(1500);
  await expect(alert.getByRole("link", { name: "Back to your Safes" })).toBeVisible();
});

test("an unknown Safe on the agent step is an alert with a heading and a link", async ({ page }) => {
  await signIn(page);
  await page.goto(`/onboarding/agent?safe=0x000000000000000000000000000000000000dEaD`);
  const alert = page.getByRole("alert");
  await expect(alert.getByRole("heading")).toBeVisible({ timeout: 1500 });
  await expect(alert.getByRole("link")).toBeVisible();
});

for (const [name, path, api] of [["Activity", "activity", "/activity"], ["Reserve", "reserve", "/reserve"]] as const) {
  test(`${name} shows a titled error with Try again when the server fails, and recovers`, async ({ page }) => {
    await setupChat(page);
    let fail = true;
    await page.route(new RegExp(`/api/safes/[^/]+${api}$`), (route) =>
      fail ? route.fulfill({ status: 500, json: { error: "boom" } }) : route.continue());
    await page.goto(`/s/${MOCK_SAFE}/${path}`);
    const alert = page.getByRole("alert").filter({ hasText: "Something went wrong on our side" });
    await expect(alert.getByRole("heading")).toBeVisible({ timeout: 1500 });
    await expect(alert).toContainText("Nothing on your Safe has changed.");
    await expect(page.locator("aside").first()).toBeVisible();
    fail = false;
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(alert).toBeHidden();
  });
}
