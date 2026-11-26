import { expect, test } from "@playwright/test";
import { COSIGNER, MOCK_SAFE, OWNER, resetWorld, safeWallet, sendLoanProposal, setupChat } from "./helpers";

test.beforeEach(async ({ request }) => resetWorld(request));

test("E2E-7: remove the agent in Settings, chat is disabled, overview says Not watched; add it back", async ({ page, request }) => {
  await setupChat(page);
  // A loan makes the overview say "Not watched" once the agent is gone (with no loan it says "Agent not added").
  const hash = await sendLoanProposal(page);
  await safeWallet.confirm(request, hash, OWNER);
  await safeWallet.confirm(request, hash, COSIGNER);
  await safeWallet.execute(request, hash);

  await page.goto(`/s/${MOCK_SAFE}/settings`);
  await page.getByRole("button", { name: "Remove agent" }).click();
  await expect(page.getByRole("alertdialog").getByText("Remove the Lender agent from this Safe?")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("main").getByText("Not added to this Safe.")).toBeVisible();

  await page.goto(`/s/${MOCK_SAFE}/chat`);
  // Round 2 (flow-02): the notice adds the agent in place instead of linking away.
  await expect(page.getByRole("main").getByText(/Add the Lender agent to suggest plans/)).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "Add the agent (one free signature)" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("textbox", { name: "Message" })).toHaveCount(0);

  await page.goto(`/s/${MOCK_SAFE}`);
  await expect(page.getByRole("main").getByText("Not watched")).toBeVisible();

  await page.goto(`/s/${MOCK_SAFE}/chat`);
  await page.getByRole("main").getByRole("button", { name: "Add the agent (one free signature)" }).click();
  await expect(page.getByRole("main").getByRole("textbox", { name: "Message" })).toBeVisible();
});
