import { expect, test } from "@playwright/test";
import { resetWorld, setupChat } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

const ask = async (page: import("@playwright/test").Page, text: string) => {
  await page.getByRole("main").getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click();
};

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test("what if ETH falls 30% opens at 30% with the price it means", async ({ page }) => {
      await setupChat(page);
      await ask(page, "what if ETH falls 30%");
      const main = page.getByRole("main");
      await expect(main.getByText("If ETH falls 30%")).toBeVisible();
      await expect(main.getByText(/After this fall: about \$[\d,]+\./)).toBeVisible();
      await expect(main.getByText(/A \$[\d,]+ loan would be:/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test("compare lenders states shared facts once, marks the best row, one primary Plan this", async ({ page }) => {
      await setupChat(page);
      await ask(page, "compare lenders for $3,000");
      const main = page.getByRole("main");
      await expect(main.getByText(/Same with (all three|both):/)).toBeVisible();
      await expect(main.getByText(/Price can fall/)).toHaveCount(0);
      await expect(main.getByText("Lowest rate")).toHaveCount(1);
      await expect(main.getByRole("button", { name: /^Use / })).toHaveCount(0);
      const plan = main.getByRole("button", { name: /^Plan this with / });
      expect(await plan.count()).toBeGreaterThanOrEqual(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}
