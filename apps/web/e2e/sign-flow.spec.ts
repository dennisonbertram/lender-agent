// The in-app sign flow, walked with the dev wallet (owner = key 1, co-signer = key 2): the owner approves,
// copies the link, the co-signer opens it, approves and sends in one step, and both see Done.
// SIGN_SHOTS=1 also writes a screenshot of each state to docs/ux-visual/verification/sign-flow/impl.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MOCK_SAFE, resetWorld, sendLoanProposal, setupChat, signIn, useWallet } from "./helpers";

const OUT = join(process.cwd(), "../../docs/ux-visual/verification/sign-flow/impl");
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 375, height: 812 }];

test.beforeEach(async ({ request }) => resetWorld(request));

async function shot(page: Page, name: string) {
  if (!process.env.SIGN_SHOTS) return;
  mkdirSync(OUT, { recursive: true });
  const v = page.viewportSize()!;
  await page.screenshot({ path: join(OUT, `${name}-${v.width}x${v.height}.png`) });
}

/** The action bar's primary is inside the viewport, nothing scrolls sideways, and every control is at least 44 px. */
async function checkBar(page: Page) {
  const v = page.viewportSize()!;
  const bar = page.locator("[data-slot=action-bar]");
  await expect(bar).toBeVisible();
  const primary = bar.locator("[data-slot=button]").first();
  const box = (await primary.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(v.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  for (const el of await bar.locator("a, button").all()) {
    const b = await el.boundingBox();
    if (!b) continue;
    expect(b.height, `target height of "${(await el.textContent())?.trim()}"`).toBeGreaterThanOrEqual(43.5);
  }
}

for (const vp of VIEWPORTS) {
  test(`owner approves, co-signer opens the link and approves and sends, both see Done (${vp.width}x${vp.height})`, async ({ page, browser }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(vp);
    await useWallet(page, "owner");
    await setupChat(page);
    await sendLoanProposal(page);
    const list = await (await page.request.get(`/api/safes/${MOCK_SAFE}/proposals/list?open=1`)).json();
    const id = ((list.proposals ?? list)[0] as { id: string }).id;
    const url = `/s/${MOCK_SAFE}/proposals/${id}`;
    await shot(page, "chat-summary");

    // Owner: needs approval.
    await page.goto(url);
    const bar = page.locator("[data-slot=action-bar]");
    await expect(bar.getByRole("heading", { name: "Your approval is needed" })).toBeVisible();
    await expect(page.getByText("0 of 2 approved")).toBeVisible();
    await checkBar(page);
    await shot(page, "needs-your-approval");
    await page.getByText("Technical details").click();
    await shot(page, "technical-details");
    await page.getByText("Technical details").click();

    // Approve: Saving… shows within 1 s of the wallet resolving, then Approved without a reload.
    await bar.getByRole("button", { name: "Approve in your wallet" }).click();
    await expect(page.getByText("Approved", { exact: true }).or(page.getByText("Saving…", { exact: true }).first())).toBeVisible({ timeout: 1000 });
    await expect(bar.getByRole("heading", { name: "Waiting for your co-owner" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("1 of 2 approved")).toBeVisible();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await checkBar(page);
    await shot(page, "waiting-for-co-owner");

    // Copy link for the co-owner copies this page's URL.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await bar.getByRole("button", { name: "Copy link for your co-owner" }).click();
    await expect(bar.getByRole("button", { name: "Link copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(url, page.url()).toString());

    // Co-signer opens the link in a new context.
    const ctx = await browser.newContext({ viewport: vp });
    const co = await ctx.newPage();
    await useWallet(co, "cosigner");
    await signIn(co);
    await co.goto(url);
    const cbar = co.locator("[data-slot=action-bar]");
    await expect(cbar.getByRole("heading", { name: "Your co-owner approved. Now it's you" })).toBeVisible();
    await checkBar(co);
    await shot(co, "last-approval-approve-and-send");
    await cbar.getByRole("button", { name: "Approve and send" }).click();
    await expect(cbar.getByRole("heading", { name: "Your loan is open" })).toBeVisible({ timeout: 60_000 });
    await expect(cbar.getByRole("link", { name: /View loan|Go to overview/ })).toBeVisible();
    await checkBar(co);
    await shot(co, "done");

    // The owner's page moves to Done by itself (fast polling), and Reject is gone.
    await expect(bar.getByRole("heading", { name: "Your loan is open" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Reject this plan" })).toHaveCount(0);
    await ctx.close();
  });
}

for (const vp of VIEWPORTS) {
  test(`every sub-state fits the viewport with a 44 px primary (${vp.width}x${vp.height})`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(vp);
    await useWallet(page, "owner");
    await setupChat(page);
    await sendLoanProposal(page);
    const list = await (await page.request.get(`/api/safes/${MOCK_SAFE}/proposals/list?open=1`)).json();
    const id = ((list.proposals ?? list)[0] as { id: string }).id;
    const states: [string, string, string][] = [
      ["wallet_open", "Confirm in your wallet", "wallet-open"],
      ["saving", "Got it. Saving your approval…", "saving"],
      ["wallet_closed", "You closed the wallet request", "wallet-closed"],
      ["smart_account", "Your approval is needed", "smart-account"],
    ];
    for (const [demo, headline, name] of states) {
      await page.goto(`/s/${MOCK_SAFE}/proposals/${id}?demo=${demo}`);
      await expect(page.locator("[data-slot=action-bar]").getByRole("heading", { name: headline })).toBeVisible();
      await checkBar(page);
      await shot(page, name);
    }
    // Reject asks first; Keep it has initial focus and Escape returns focus to the trigger.
    await page.goto(`/s/${MOCK_SAFE}/proposals/${id}`);
    // On phones Reject sits under "More options" in the compact action bar (proposals-05).
    const bar = page.locator("[data-slot=action-bar]");
    await expect(bar.getByRole("heading", { name: "Your approval is needed" })).toBeVisible();
    const more = bar.getByRole("button", { name: "More options" });
    if (await more.count()) await more.click();
    const trigger = page.getByRole("button", { name: /^Reject:/ });
    await trigger.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Reject this plan?")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
    await shot(page, "reject-dialog");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole("button", { name: "Reject plan" }).click();
    await expect(page.locator("[data-slot=action-bar]").getByRole("heading", { name: "This plan was rejected" })).toBeVisible({ timeout: 15_000 });
    await checkBar(page);
    await shot(page, "rejected");
  });
}

test("a stranger (key 3) sees no plan data on the proposal page", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await useWallet(page, "owner");
  await setupChat(page);
  await sendLoanProposal(page);
  const list = await (await page.request.get(`/api/safes/${MOCK_SAFE}/proposals/list?open=1`)).json();
  const first = (list.proposals ?? list)[0] as { id: string; safeTxHash: string };
  const detail = await (await page.request.get(`/api/safes/${MOCK_SAFE}/proposals/${first.id}`)).json();

  const ctx = await browser.newContext();
  const stranger = await ctx.newPage();
  await useWallet(stranger, "stranger");
  await signIn(stranger);
  expect((await stranger.request.get(`/api/safes/${MOCK_SAFE}/proposals/${first.id}`)).ok()).toBeFalsy();
  await stranger.goto(`/s/${MOCK_SAFE}/proposals/${first.id}`);
  await expect(stranger.getByRole("main")).toBeVisible();
  await expect(stranger.getByText(detail.proposal.sentence)).toHaveCount(0);
  await expect(stranger.getByText(first.safeTxHash.slice(0, 10))).toHaveCount(0);
  await expect(stranger.locator("[data-slot=action-bar]").getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await ctx.close();
});
