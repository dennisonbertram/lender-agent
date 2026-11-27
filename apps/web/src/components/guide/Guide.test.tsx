// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let pathname = "/s/0xabc";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

vi.mock("./guide-content", () => {
  const topics = [
    {
      id: "welcome",
      title: "Welcome",
      summary: "Sign in to reach your Safes.",
      steps: [{ title: "Sign in", body: "Connect your wallet and sign the message.", target: "sign-in" }],
    },
    {
      id: "choose-safe",
      title: "Choose a Safe",
      summary: "Pick the Safe to borrow with.",
      steps: [
        { title: "Pick a Safe", body: "Choose one of your Safes.", target: "choose-safe" },
        { title: "Or create one", body: "You can also create a new Safe." },
      ],
    },
    {
      id: "create-safe",
      title: "Create a Safe",
      summary: "Set up a new Safe.",
      steps: [{ title: "Name it", body: "Pick a name and networks.", target: "create-safe" }],
    },
    {
      id: "overview",
      title: "Overview",
      summary: "Your Safe at a glance.",
      steps: [
        { title: "Balances", body: "See what the Safe holds.", target: "overview-balances" },
        { title: "Choose an action", body: "Pick what to do next." },
        { title: "Missing target", body: "This control is sometimes unavailable.", target: "not-on-page" },
      ],
    },
    { id: "chat", title: "Chat", summary: "Ask the agent.", steps: [{ title: "Ask", body: "Type a question.", target: "chat-compose" }] },
  ] as const;
  const byId = (id: string) => topics.find((t) => t.id === id);
  return {
    guideTopics: topics,
    topicForPath: (p: string) => {
      const path = p.toLowerCase();
      if (path === "/") return byId("welcome");
      if (path === "/onboarding") return byId("choose-safe");
      if (/^\/s\/[^/]+\/chat$/.test(path)) return byId("chat");
      if (/^\/s\/[^/]+$/.test(path)) return byId("overview");
      return undefined;
    },
  };
});

import { GuideButton, GuideIntro, GuideProvider } from "./Guide";

const page = (children: React.ReactNode = null) => <GuideProvider>{children}</GuideProvider>;
const realFocus = HTMLElement.prototype.focus;

beforeEach(() => {
  pathname = "/s/0xabc";
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  // floating-ui probes focus() for preventScroll support; plain jsdom ignores the options
  // object so the probe would disable all return-focus. Read the option to pass the probe.
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    void options?.preventScroll;
    realFocus.call(this);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Guide", () => {
  it("renders GuideButton and GuideIntro safely outside the provider", () => {
    const { container } = render(<div><GuideButton /><GuideIntro /><GuideIntro topicId="create-safe" /></div>);
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows the feature's explanation automatically on first entry, without stealing focus", () => {
    render(page(<><button>Keep me focused</button><GuideIntro /></>));
    const keep = screen.getByRole("button", { name: "Keep me focused" });
    keep.focus();
    expect(screen.getByText("Your Safe at a glance.")).toBeTruthy();
    expect(document.activeElement).toBe(keep);
  });

  it("treats 'Dismiss guide' on an intro as hiding every intro on this device, manual Guide still works", () => {
    const { rerender } = render(page(<><GuideIntro /><GuideButton /></>));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss guide" }));
    expect(screen.queryByRole("note")).toBeNull();
    // Other topics and other Safes stay hidden too.
    pathname = "/s/0xdef/chat";
    rerender(page(<><GuideIntro /><GuideButton /></>));
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Ask the agent.")).toBeTruthy();
  });

  it("persists the global dismiss across remounts", () => {
    const first = render(page(<GuideIntro />));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss guide" }));
    first.unmount();
    render(page(<GuideIntro />));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("marks only the opened topic as seen — other features still show their intro", () => {
    const { rerender } = render(page(<><GuideIntro /><GuideButton /></>));
    fireEvent.click(screen.getByRole("button", { name: "Walk through the steps" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // The overview intro is gone (its guide ran) but the chat feature still gets its own.
    pathname = "/s/0xabc/chat";
    rerender(page(<GuideIntro />));
    expect(screen.getByText("Ask the agent.")).toBeTruthy();
    pathname = "/s/0xabc";
    rerender(page(<GuideIntro />));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("treats corrupt stored prefs as a first visit", () => {
    localStorage.setItem("la:guide:v1", "{not json");
    render(page(<GuideIntro />));
    expect(screen.getByText("Your Safe at a glance.")).toBeTruthy();
  });

  it("mutes intros for the session and still opens manually when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { rerender } = render(page(<><GuideIntro /><GuideButton /></>));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss guide" }));
    pathname = "/s/0xabc/chat";
    rerender(page(<><GuideIntro /><GuideButton /></>));
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens directly into the current feature's explanation and step 1, walks Back/Next and finishes with Done", () => {
    render(page(<GuideButton />));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(screen.getByText("Your Safe at a glance.")).toBeTruthy();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(screen.getByText("Balances")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(screen.getByText("Choose an action")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces step changes inside a polite live region", () => {
    render(page(<GuideButton />));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    const live = document.querySelector("[aria-live=polite]");
    expect(live?.textContent).toContain("Step 1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(live?.textContent).toContain("Step 2 of 3");
  });

  it("opens into the 'All topics' index and starts any feature's guide from it", () => {
    render(page(<GuideButton />));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    fireEvent.click(screen.getByRole("button", { name: "All topics" }));
    expect(screen.getByRole("button", { name: /Chat/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Chat/ }));
    expect(screen.getByText("Ask the agent.")).toBeTruthy();
    expect(screen.getByText("Step 1 of 1")).toBeTruthy();
  });

  it("opens the index directly on a route with no feature topic", () => {
    pathname = "/somewhere/unmapped";
    render(page(<GuideButton />));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(screen.getByRole("button", { name: /Overview/ })).toBeTruthy();
  });

  it("restores focus to the Guide button that opened it on Done and on Close", async () => {
    render(page(<GuideButton />));
    const btn = screen.getByRole("button", { name: "Guide" });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.activeElement).toBe(btn));
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(btn));
  });

  it("restores focus to the persistent Guide button when the intro opener went away", async () => {
    render(page(<><GuideIntro /><GuideButton /></>));
    // Opening from the inline card marks the topic seen — the card (and its button) unmount.
    fireEvent.click(screen.getByRole("button", { name: "Walk through the steps" }));
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Guide" })));
  });

  it("returns to the same trigger after browsing All topics", async () => {
    render(page(<GuideButton />));
    const btn = screen.getByRole("button", { name: "Guide" });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "All topics" }));
    fireEvent.click(screen.getByRole("button", { name: /Chat/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.activeElement).toBe(btn));
  });

  it("does not reuse a route-local trigger after the Safe changes", async () => {
    const content = () => page(<><GuideButton /><GuideButton /></>);
    const { rerender } = render(content());
    const [first, second] = screen.getAllByRole("button", { name: "Guide" });
    fireEvent.click(second);
    pathname = "/s/0xdef";
    rerender(content());
    // The opener was route-local; the fallback is the first visible Guide button.
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("'Show on page' scrolls to, focuses and highlights the control, and returning keeps the step", async () => {
    render(page(<><button data-guide-target="overview-balances">Balances card</button><GuideButton /></>));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Show on page" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const target = screen.getByRole("button", { name: "Balances card" });
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(target.className).toMatch(/spotlight/);
    fireEvent.click(screen.getByRole("button", { name: "Back to guide" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(target.className).not.toMatch(/spotlight/);
  });

  it("hides 'Show on page' when the step's control is missing from the DOM", () => {
    render(page(<GuideButton />));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Missing target")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show on page" })).toBeNull();
  });

  it("offers 'Show on page' as soon as a late-mounting control appears", async () => {
    render(page(<GuideButton />));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(screen.queryByRole("button", { name: "Show on page" })).toBeNull();
    const el = document.createElement("button");
    el.setAttribute("data-guide-target", "overview-balances");
    await act(async () => {
      document.body.appendChild(el);
    });
    expect(screen.getByRole("button", { name: "Show on page" })).toBeTruthy();
    el.remove();
  });

  it("skips a hidden duplicate and points at the shown control", async () => {
    render(page(<>
      <ul hidden data-guide-target="overview-balances" />
      <button data-guide-target="overview-balances">Visible balances</button>
      <GuideButton />
    </>));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Show on page" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Visible balances" })),
    );
  });

  it("highlights a disabled control without focusing it", async () => {
    render(page(<><button disabled data-guide-target="overview-balances">Paused balances</button><GuideButton /></>));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Show on page" }));
    const target = screen.getByRole("button", { name: "Paused balances" });
    expect(target.className).toMatch(/spotlight/);
    expect(screen.getByRole("button", { name: "Back to guide" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Guide" })));
    expect(document.activeElement).not.toBe(target);
  });

  it("never clicks the target or asks the wallet for anything", async () => {
    const onActivate = vi.fn();
    render(page(<><button data-guide-target="overview-balances" onClick={onActivate}>Balances card</button><GuideButton /></>));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Show on page" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Balances card" })));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("uses the GuideIntro topic override for the manual guide on the same route", () => {
    pathname = "/onboarding";
    render(page(<><GuideIntro topicId="create-safe" /><GuideButton /></>));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(screen.getByText("Set up a new Safe.")).toBeTruthy();
    expect(screen.getByText("Name it")).toBeTruthy();
  });

  it("resets the walkthrough when the route or Safe identity changes", () => {
    const { rerender } = render(page(<GuideButton />));
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    pathname = "/s/0xdef";
    rerender(page(<GuideButton />));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses the intro with Escape when it has focus", () => {
    render(page(<GuideIntro />));
    fireEvent.keyDown(screen.getByRole("note"), { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();
  });
});
