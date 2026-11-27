import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const MOCK_SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";
export const MOCK_EMPTY_SAFE = "0x5afE5AFe5afE5AfE5afe5Afe5AfE5aFe5afE0002";

/** The picker's title for an unnamed Safe: its short address as rendered (`0x5afE…0001`). */
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Open a Safe from the picker: finds that Safe's own card by its visible identity, then presses its Open Safe. */
export async function openSafe(page: Page, safe: string) {
  const card = page.getByRole("list", { name: /Safes/ }).getByRole("listitem").filter({ hasText: shortAddress(safe) });
  await card.getByRole("button", { name: /Open Safe/ }).click();
}

export const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const COSIGNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const KEY_INDEX = { owner: "1", cosigner: "2", stranger: "3" } as const;
export type Role = keyof typeof KEY_INDEX;

/** The dev wallet signs with anvil key 1, 2 or 3. Call before the first `goto`. */
export async function useWallet(page: Page, role: Role) {
  await page.addInitScript((idx) => window.localStorage.setItem("la:mockWalletKey", idx), KEY_INDEX[role]);
}

/** Connect the dev wallet and sign in (SIWE). Leaves the page on the Safe picker. */
export async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Connect wallet|Sign in with wallet/ }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}

export async function resetWorld(request: APIRequestContext) {
  const res = await request.post("/api/mock/reset");
  expect(res.ok()).toBeTruthy();
}

export const safeWallet = {
  async confirm(request: APIRequestContext, safeTxHash: string, owner: string) {
    const res = await request.post("/api/mock/safe-wallet", { data: { action: "confirm", chainId: 8453, safeTxHash, owner } });
    expect(res.ok()).toBeTruthy();
  },
  async execute(request: APIRequestContext, safeTxHash: string, opts: { revert?: boolean } = {}) {
    const res = await request.post("/api/mock/safe-wallet", { data: { action: "execute", chainId: 8453, safeTxHash, revert: opts.revert } });
    expect(res.ok()).toBeTruthy();
  },
};

/** Sign in as the owner, add the agent on MOCK_SAFE and land on chat. */
export async function setupChat(page: Page) {
  await signIn(page);
  await openSafe(page, MOCK_SAFE);
  await page.getByRole("button", { name: "Add Lender agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${MOCK_SAFE}/chat`, "i"));
  await expect(page.getByRole("main").getByRole("button", { name: "How does this work?" })).toBeVisible();
}

/** Ask for $1,000, read the plan, send it to the Safe. Returns the proposal's Safe transaction hash. */
export async function sendLoanProposal(page: Page): Promise<string> {
  await page.getByRole("main").getByRole("textbox", { name: "Message" }).fill("I need $1,000");
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("main").getByText(/You get \$1,000 as /)).toBeVisible();
  await expect(page.getByRole("main").getByText(/You lock .* ETH/)).toBeVisible();
  await expect(page.getByRole("main").getByText(/Safe unless ETH falls below \$[\d,]+/)).toBeVisible();
  await expect(page.getByRole("main").getByText(/a year at /)).toBeVisible();
  await expect(page.getByRole("main").getByText(/network fee/i).first()).toBeVisible();
  await expect(page.getByRole("main").getByText(/On Base, with (Aave v3|Morpho)/)).toBeVisible();
  await expect(page.getByRole("main").getByText(/Checked: this would work/)).toBeVisible();
  // The plan card's one action sends the plan, then opens the proposal page and starts the free approval. These flows
  // drive the approval themselves, so this tab drops the "approve intent" mark (the page then waits for a click) and comes back to chat.
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) { if (!k.startsWith("la:approveIntent")) set.call(this, k, v); };
  });
  await page.getByRole("main").getByRole("button", { name: "Approve in your wallet" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${MOCK_SAFE}/proposals/`, "i"), { timeout: 15_000 });
  await page.goto(`/s/${MOCK_SAFE}/chat`);
  // Send appended the proposal card to the thread.
  await expect(page.getByRole("main").getByText("0 of 2 approved")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("main").getByRole("link", { name: "Review and approve" })).toBeVisible();
  const res = await page.request.get(`/api/safes/${MOCK_SAFE}/proposals/list?open=1`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const list = (body.proposals ?? body) as { safeTxHash: string }[];
  expect(list.length).toBeGreaterThan(0);
  return list[0].safeTxHash;
}


/** Onboard `safe` as the owner: pick it, add the agent, land on chat. */
export async function addAgent(page: Page, safe: string) {
  await signIn(page);
  await openSafe(page, safe);
  await page.getByRole("button", { name: "Add Lender agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${safe}/chat`, "i"));
}

/** Newest open proposal of a Safe, read through the API with the page's session. */
export async function latestProposal(page: Page, safe: string) {
  const res = await page.request.get(`/api/safes/${safe}/proposals/list?open=1`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}
