// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";

const state = vi.hoisted(() => ({ pathname: "", docked: true }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/components/chat/ChatView", () => ({
  AgentStatus: () => null,
  ChatBody: ({ contextualHelpOnly, placement }: { contextualHelpOnly?: boolean; placement: string }) => (
    <div data-testid="chat-body" data-contextual-help={String(!!contextualHelpOnly)} data-placement={placement} />
  ),
}));
vi.mock("@/components/chat/SafeLine", () => ({ SafeLine: () => null }));
vi.mock("@/components/shell/AppShell", () => ({ useMedia: () => state.docked }));

beforeEach(() => { state.pathname = "/s/0xabc/get-cash"; state.docked = true; });
afterEach(() => cleanup());

describe("ChatPanel initial context", () => {
  it("offers contextual help on Get Cash when the chat is docked", () => {
    render(<ChatPanel address="0xabc" onClose={() => {}} />);
    expect(screen.getByTestId("chat-body").getAttribute("data-contextual-help")).toBe("true");
    expect(screen.getByTestId("chat-body").getAttribute("data-placement")).toBe("dock");
  });

  it("keeps the normal greeting on other pages and in the chat sheet", () => {
    state.pathname = "/s/0xabc";
    const { rerender } = render(<ChatPanel address="0xabc" onClose={() => {}} />);
    expect(screen.getByTestId("chat-body").getAttribute("data-contextual-help")).toBe("false");

    state.pathname = "/s/0xabc/get-cash";
    state.docked = false;
    rerender(<ChatPanel address="0xabc" onClose={() => {}} />);
    expect(screen.getByTestId("chat-body").getAttribute("data-contextual-help")).toBe("false");
    expect(screen.getByTestId("chat-body").getAttribute("data-placement")).toBe("sheet");
  });
});
