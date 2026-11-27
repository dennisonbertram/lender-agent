import { expect, test } from "@playwright/test";
import { MOCK_SAFE, openSafe } from "./helpers";

test("local demo uses its synthetic wallet and keeps wallet transfers off external RPCs", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      externalRequests.push(url.origin);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    const sentinel = {
      calls: [] as string[],
      async request({ method }: { method: string }) {
        this.calls.push(method);
        throw new Error("The browser's extension must not be used by local demo mode.");
      },
    };
    Object.defineProperty(window, "ethereum", { configurable: true, value: sentinel });
    Object.defineProperty(window, "__localDemoExtensionSentinel", { configurable: true, value: sentinel });
  });

  await page.goto("/");
  const signIn = page.getByRole("button", { name: /Connect wallet|Sign in with wallet/ });
  await signIn.click();
  await expect(page).toHaveURL(/\/onboarding/);
  await openSafe(page, MOCK_SAFE);
  await page.getByRole("button", { name: "Add Lender agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${MOCK_SAFE}/chat`, "i"));
  const wallet = page.getByRole("button", { name: /Your wallet/ });
  await expect(wallet).toBeVisible();
  await wallet.click();
  const note = page.getByRole("note").filter({ hasText: "Demo Safe is already funded in the mock world." });
  await expect(note).toContainText("Demo Safe is already funded in the mock world.");
  await expect(note).toContainText("Sending from a wallet is unavailable in this local demo.");
  await expect(page.getByLabel("Amount")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send to Safe/ })).toHaveCount(0);
  const extensionUntouched = await page.evaluate(() => {
    const w = window as typeof window & { ethereum?: unknown; __localDemoExtensionSentinel?: { calls: string[] } };
    return w.ethereum === w.__localDemoExtensionSentinel && w.__localDemoExtensionSentinel?.calls.length === 0;
  });
  expect(extensionUntouched).toBe(true);
  expect(externalRequests).toEqual([]);
});
