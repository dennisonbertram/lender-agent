// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Safe } from "@/lib/types";
import { AppShell } from "./AppShell";
import { ShellProvider } from "./ShellContext";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001";
vi.mock("next/navigation", () => ({ usePathname: () => `/s/${SAFE.toLowerCase()}/chat`, useRouter: () => ({ push: vi.fn() }) }));

const safe: Safe = { id: SAFE, name: "Main Safe", address: SAFE, threshold: "2 of 2", agent: true, networks: [{ id: "base", deployed: true, agent: true }], balances: {} };

describe("AppShell on the chat page", () => {
  it("does not dock a second chat when the URL address is lowercased", () => {
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, onchange: null, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    render(
      <ShellProvider safe={safe} safes={[safe]} loans={[]} agentOn watching>
        <AppShell chat={() => <div>docked chat</div>}><div>chat page</div></AppShell>
      </ShellProvider>,
    );
    expect(screen.getByText("chat page")).toBeTruthy();
    expect(screen.queryByText("docked chat")).toBeNull();
  });
});
