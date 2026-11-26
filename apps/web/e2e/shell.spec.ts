import { expect, test } from "@playwright/test";
import { MOCK_SAFE, resetWorld, setupChat, useWallet } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

const WATCH = "Ready. No loans to watch yet.";

test("signed out: a Safe page shows the sign-in card that comes back to this page", async ({ page }) => {
  await page.goto(`/s/${MOCK_SAFE}/activity`);
  const card = page.getByRole("alert");
  await expect(card.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  const href = await card.getByRole("link", { name: "Sign in" }).getAttribute("href");
  expect(href).toBe(`/?next=${encodeURIComponent(`/s/${MOCK_SAFE}/activity`)}`);
});

test("1440: status line is the same on chat dock and in Settings, and Sign out leaves the app", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useWallet(page, "owner");
  await setupChat(page);
  await page.goto(`/s/${MOCK_SAFE}`);
  await expect(page.locator("aside").getByText(WATCH)).toBeVisible();
  await page.goto(`/s/${MOCK_SAFE}/settings`);
  await expect(page.getByRole("main").getByText(WATCH)).toBeVisible();
  const out = page.locator("[data-sidebar]").getByRole("button", { name: /Sign out/ });
  await expect(out).toBeVisible();
  await out.click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/s/${MOCK_SAFE}`);
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
});

test("390: Sign out is in the phone Menu, and the chat sheet status line never overflows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useWallet(page, "owner");
  await setupChat(page);
  await page.goto(`/s/${MOCK_SAFE}`);
  await page.getByRole("button", { name: "Lender agent" }).click();
  const line = page.getByRole("dialog").getByText(WATCH);
  await expect(line).toBeVisible();
  const fits = await line.evaluate((el) => el.scrollWidth <= el.clientWidth || getComputedStyle(el).textOverflow === "ellipsis" || el.classList.contains("truncate"));
  expect(fits).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /Sign out/ })).toBeVisible();
});

test("sidebar stays put (the page itself never scrolls), and scrolls itself in short windows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 320 });
  await useWallet(page, "owner");
  await setupChat(page);
  await page.goto(`/s/${MOCK_SAFE}`);
  const side = page.locator("[data-sidebar]");
  await expect(side.getByRole("link", { name: /Overview/ })).toBeVisible();
  // main's layout (#108): the shell fills the window and only the content column scrolls, so the document has nothing to scroll.
  const docScrolls = await page.evaluate(() => { window.scrollTo(0, 800); return document.documentElement.scrollHeight > window.innerHeight || window.scrollY > 0; });
  expect(docScrolls).toBe(false);
  const top = await page.locator("aside").first().evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBe(0);
  await expect(side.getByRole("link", { name: /Overview/ })).toBeInViewport();
  // Short window: the sidebar scrolls inside itself, so Sign out is reachable.
  const out = side.getByRole("button", { name: /Sign out/ });
  await out.scrollIntoViewIfNeeded();
  await expect(out).toBeInViewport();
  const scrolls = await side.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto");
  expect(scrolls).toBe(true);
});
