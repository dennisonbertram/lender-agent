// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import HomePage from "./page";

const replace = vi.fn();
let session: { address: string } | null = { address: "0x1" };
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/client/auth/useSession", () => ({ useSession: () => ({ session }) }));
vi.mock("@/components/auth/SignInCard", () => ({ SignInCard: ({ returning }: { returning?: boolean }) => <div>card {String(!!returning)}</div> }));
vi.mock("@/components/home/BorrowerHome", () => ({ BorrowerHome: () => <main>borrower homepage</main> }));

beforeEach(() => {
  replace.mockReset();
  session = { address: "0x1" };
});
afterEach(cleanup);

async function renderHome(searchParams: { next?: string | string[] } = {}) {
  return render(await HomePage({ searchParams: Promise.resolve(searchParams) }));
}

describe("home page routing", () => {
  it("returns an authenticated visitor to a valid next path", async () => {
    const path = "/s/0x1/proposals/7";
    await renderHome({ next: path });
    expect(replace).toHaveBeenCalledWith(path);
  });
  it.each(["/..//evil.com", "//evil.com", "https://evil.com", "/api/auth/logout"])("ignores hostile next %s", async (next) => {
    await renderHome({ next });
    expect(replace).toHaveBeenCalledWith("/onboarding");
  });
  it("goes to onboarding for authenticated visitors without next", async () => {
    await renderHome();
    expect(replace).toHaveBeenCalledWith("/onboarding");
  });
  it("shows compact sign-in to a signed-out visitor with a valid next", async () => {
    session = null;
    const { container } = await renderHome({ next: "/s/0x1/proposals/7" });
    expect(container.textContent).toBe("card true");
    expect(replace).not.toHaveBeenCalled();
  });
  it("renders the borrower homepage for a signed-out visitor without next", async () => {
    session = null;
    const { container } = await renderHome();
    expect(container.textContent).toBe("borrower homepage");
    expect(replace).not.toHaveBeenCalled();
  });
});
