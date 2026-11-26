import { expect, test } from "@playwright/test";
import { MOCK_SAFE, resetWorld, setupChat } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`one borrow limit: chat greeting, chip, plan and Get cash agree at ${vp.width}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await setupChat(page);
    const main = page.getByRole("main");
    const chip = main.getByRole("button", { name: /^Borrow \$[\d,]+$/ });
    const figure = (await chip.textContent())!.replace("Borrow ", "");
    await expect(main.getByText(`You can borrow up to ${figure}`)).toBeVisible();

    // Why line: collapsed, then the plain sentence.
    const why = main.getByRole("button", { name: `Why ${figure}?` });
    await why.click();
    await expect(why).toHaveAttribute("aria-expanded", "true");
    const sentence = await main.getByText(/^It is the most you can borrow/).textContent();

    // The chip's plan is not capped below the figure.
    await chip.click();
    await expect(main.getByText(new RegExp(`You get \\${figure} as `))).toBeVisible();
    await expect(main.getByText(/Capped at/)).toHaveCount(0);

    // Get cash shows the same number.
    await page.goto(`/s/${MOCK_SAFE}/get-cash`);
    await expect(page.getByRole("main").getByText(new RegExp(`\\${figure}`)).first()).toBeVisible();
    expect(sentence).toContain("Balanced");
  });
}
