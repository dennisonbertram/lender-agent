import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/client/safes";

const state = vi.hoisted(() => ({ error: null as unknown, data: undefined as unknown, list: undefined as unknown, shell: null as any, path: "/s/0xabc/loans/7", listWallet: undefined as string | undefined, reserveCalls: [] as unknown[][] }));
vi.mock("@/client/auth/useSession", () => ({ useSession: () => ({ session: { address: "0x5afe00000000000000000000000000000000beef" } }), useSignOut: () => vi.fn() }));
vi.mock("@/client/reserve", () => ({ useReserve: (...args: unknown[]) => { state.reserveCalls.push(args); return { data: undefined }; } }));
vi.mock("@/client/safes", async (orig) => ({
  ...(await orig<typeof import("@/client/safes")>()),
  useSafeSummary: () => ({ data: state.data, error: state.error }),
  useSafes: (wallet?: string) => { state.listWallet = wallet; return { data: state.list }; },
}));
vi.mock("@/components/proposals/WrongWallet", () => ({ WrongWallet: ({ returnTo }: { returnTo?: string }) => <p data-wrong-wallet={returnTo}>This needs a different wallet</p> }));
vi.mock("@/components/chat/ChatPanel", () => ({ ChatPanel: () => null }));
vi.mock("@/components/shell/AppShell", () => ({ AppShell: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));
vi.mock("@/components/shell/ShellContext", () => ({ ShellProvider: (p: unknown) => { state.shell = p; return null; } }));

import { signInHref } from "@/lib/return-to";
import SafeLayout from "./layout";

function render(error: unknown, children: ReactNode = null) {
  if (error) state.data = undefined;
  state.error = error;
  // A pre-resolved thenable lets React's `use` read params synchronously.
  const params = Object.assign(Promise.resolve({ address: "0xabc" }), { status: "fulfilled", value: { address: "0xabc" } });
  return renderToStaticMarkup(<SafeLayout params={params}>{children}</SafeLayout>);
}

describe("Safe layout error states", () => {
  it("reserves the desktop rail while showing a compact authorized-control loading frame", () => {
    state.error = null;
    state.data = undefined;
    const html = render(null, <p>secret page content</p>);
    expect(html).toContain('class="hidden w-[232px]');
    expect(html).toContain("Pick another Safe");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("secret page content");
  });

  it("reserves the agent column beside the rail on non-chat pages, so a loaded shell keeps the same columns", () => {
    state.error = null;
    state.data = undefined;
    state.path = "/s/0xabc";
    try {
      const overview = render(null);
      // The docked chat column the shell paints at >=1100px must exist from first paint.
      expect(overview).toContain("min-[1100px]");
      state.path = "/s/0xabc/chat";
      // The chat page is itself the agent: no second column is reserved or docked there.
      const chat = render(null);
      expect(chat).not.toContain("min-[1100px]");
    } finally {
      state.path = "/s/0xabc/loans/7";
    }
  });

  it("keeps the fallback top bar at the same frame position while loading becomes an error", () => {
    state.error = null;
    state.data = undefined;
    const loading = render(null);
    const failed = render(new Error("boom"));
    const framePosition = '</aside><div class="flex min-w-0 flex-1 flex-col"><header';
    expect(loading).toContain(framePosition);
    expect(failed).toContain(framePosition);
  });

  it("scopes the saved Safe list query to the signed-in wallet", () => {
    state.error = null;
    state.data = undefined;
    state.listWallet = undefined;
    render(null);
    expect(state.listWallet).toBe("0x5afe00000000000000000000000000000000beef");
  });
  it("401: asks to sign in, with a link to /", () => {
    const html = render(new ApiError(401, "unauthorized"));
    expect(html).toContain("Sign in to continue");
    expect(html).toContain(`href="${signInHref("/s/0xabc/loans/7")}"`);
  });
  it("VC-06: the error cards sit inside a main landmark", () => {
    for (const e of [new ApiError(401, "unauthorized"), new ApiError(403, "forbidden"), new Error("boom")]) {
      const html = render(e);
      expect(html.indexOf("<main")).toBeGreaterThan(-1);
      expect(html.indexOf('role="alert"')).toBeGreaterThan(html.indexOf("<main"));
    }
  });
  it("keeps a minimal top bar with the Safe address, Pick another Safe and Sign out around the error card", () => {
    const html = render(new Error("boom"));
    expect(html).toContain("Pick another Safe");
    expect(html).toContain("Sign out");
    expect(html).toContain('aria-label="Copy address"');
  });
  it("403: says this wallet is not an owner, links to /onboarding", () => {
    const html = render(new ApiError(403, "forbidden"));
    expect(html).toContain("This wallet is not an owner of this Safe");
    expect(html).toMatch(/href="\/onboarding"/);
  });
  it("403 on a proposal page: the different-wallet page, no plan data, no old not-an-owner card", () => {
    state.path = "/s/0xabc/proposals/p1";
    const html = render(new ApiError(403, "forbidden"));
    state.path = "/s/0xabc/loans/7";
    expect(html).toContain("This needs a different wallet");
    expect(html).toContain('data-wrong-wallet="/s/0xabc/proposals/p1"');
    expect(html).not.toContain("not an owner");
    expect(html).toMatch(/^<main[ >]/);
  });
  it("other errors: says try again, with a link back", () => {
    const html = render(new ApiError(500, "boom"));
    expect(html).toMatch(/try again/i);
    expect(html).toMatch(/href="\/onboarding"/);
  });
  it("network failure (non-ApiError) is treated as other error", () => {
    expect(render(new TypeError("fetch failed"))).toMatch(/try again/i);
  });
  it("other Safes in the picker carry their real agent flag, and the shell gets lastCheckAt", () => {
    state.error = null;
    const mk = (address: string, agent: boolean, ownedChainIds = [8453], pendingSetup = false) => ({ address, name: "", networks: [8453], ownedChainIds, pendingSetup, agent });
    state.list = [mk("0xaaa", true), mk("0xbbb", false), mk("0xccc", false, [], true), mk("0xddd", false, [8453], true)];
    state.data = { safe: { id: "0xabc", name: "A", address: "0xabc", threshold: "", agent: true, networks: [], balances: {} }, ownersDiffer: false, watching: false, loans: [], monitorFailing: true, monitorStarting: false, monitorLastCheckAt: "2026-01-01T00:00:00.000Z" };
    render(null);
    const safes = state.shell.safes as { address: string; agent: boolean; networks: { agent: boolean }[] }[];
    expect(safes.find((s) => s.address === "0xaaa")?.agent).toBe(true);
    expect(safes.find((s) => s.address === "0xaaa")?.networks[0].agent).toBe(true);
    expect(safes.find((s) => s.address === "0xbbb")?.agent).toBe(false);
    expect(safes.some((s) => s.address === "0xccc")).toBe(false);
    expect(safes.some((s) => s.address === "0xddd")).toBe(true);
    expect(state.shell.lastCheckAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not advertise Base for a Safe the wallet only owns on Arbitrum", () => {
    state.error = null;
    state.list = [{ address: "0xaaa", name: "", networks: [8453, 42161], ownedChainIds: [42161], agent: true }];
    state.data = { safe: { id: "0xabc", name: "A", address: "0xabc", threshold: "", agent: true, networks: [], balances: {} }, ownersDiffer: false, watching: false, loans: [] };
    render(null);
    expect((state.shell.safes as { address: string; networks: { id: string }[] }[]).find((s) => s.address === "0xaaa")?.networks.map((n) => n.id)).toEqual(["arbitrum"]);
  });
  it("keeps the Base-only Reserve query disabled for an Arbitrum-only Safe", () => {
    state.error = null;
    state.data = { safe: { id: "0xabc", name: "A", address: "0xabc", threshold: "", agent: true, networks: [{ id: "arbitrum", deployed: true, agent: true }], balances: {} }, ownersDiffer: false, watching: false, loans: [], chainIds: [42161] };
    state.reserveCalls = [];
    render(null);
    expect(state.reserveCalls).toEqual([["0xabc", false]]);
  });
  it("does not request Base Reserve data when Base is tracked but this wallet only owns Arbitrum", () => {
    state.error = null;
    state.data = { safe: { id: "0xabc", name: "A", address: "0xabc", threshold: "", agent: true, networks: [{ id: "base", deployed: true, agent: true }, { id: "arbitrum", deployed: true, agent: true }], balances: {} }, ownersDiffer: true, watching: false, loans: [], chainIds: [8453, 42161], ownedChainIds: [42161] };
    state.reserveCalls = [];
    render(null);
    expect(state.reserveCalls).toEqual([["0xabc", false]]);
  });
});
