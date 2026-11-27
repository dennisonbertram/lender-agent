// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./guide-content", () => ({
  guideTopics: [
    {
      id: "welcome",
      title: "Start here",
      summary: "Sign in with your wallet, then pick a Safe.",
      steps: [{ title: "Connect", body: "Approve the sign-in." }],
    },
    {
      id: "repay",
      title: "Repay part of a loan",
      summary: "Pay down some of the debt.",
      steps: [{ title: "Enter an amount", body: "Type what to pay in digital dollars." }],
    },
    {
      id: "alerts",
      title: "Alerts and early warnings",
      summary: "See where loan warnings go.",
      steps: [{ title: "Get alerts", body: "Email alerts take an address." }],
    },
    {
      id: "quote",
      title: "Plan a loan",
      summary: "Estimate what a loan could cost.",
      steps: [{ title: "Enter the amount", body: "How much cash do you need?" }],
    },
  ],
  topicForPath: () => undefined,
}));

import { GuideTopicList } from "./GuideTopicList";

const searchBox = () => screen.getByRole("searchbox", { name: "Search guides" });
const type = (value: string) => fireEvent.change(searchBox(), { target: { value } });
const topicButtons = () => screen.queryAllByRole("button");

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("GuideTopicList", () => {
  it("lists every topic with a labelled search field that stays out of the scroll region and unfocused", () => {
    render(<GuideTopicList onPick={vi.fn()} />);
    const search = searchBox();
    expect(search.tagName).toBe("INPUT");
    expect(search.getAttribute("type")).toBe("search");
    // No autofocus — opening the guide must not pop the mobile keyboard.
    expect(document.activeElement).not.toBe(search);
    // The field sits above the scrolling list, so it stays visible while topics scroll.
    expect(search.closest(".overflow-y-auto")).toBeNull();
    expect(document.querySelector(".overflow-y-auto.min-h-0")).toBeTruthy();
    expect(topicButtons()).toHaveLength(4);
    expect(screen.getByRole("button", { name: /Repay part of a loan/ })).toBeTruthy();
  });

  it("calls onPick with the topic id", () => {
    const onPick = vi.fn();
    render(<GuideTopicList onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /Plan a loan/ }));
    expect(onPick).toHaveBeenCalledWith("quote");
  });

  it("matches words case-insensitively in title, summary, step text and id", () => {
    render(<GuideTopicList onPick={vi.fn()} />);
    type("CASH"); // step body
    expect(topicButtons().map((b) => b.textContent)).toEqual([expect.stringContaining("Plan a loan")]);
    type("warnings"); // title and summary
    expect(topicButtons()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Alerts and early warnings/ })).toBeTruthy();
    type("email"); // step body only
    expect(topicButtons()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Alerts and early warnings/ })).toBeTruthy();
    type("repay"); // id and title
    expect(topicButtons()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Repay part of a loan/ })).toBeTruthy();
  });

  it("requires every word in the query to match", () => {
    render(<GuideTopicList onPick={vi.fn()} />);
    type("repay loan");
    expect(topicButtons()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Repay part of a loan/ })).toBeTruthy();
  });

  it("treats a blank or whitespace query as no filter", () => {
    render(<GuideTopicList onPick={vi.fn()} />);
    type("   ");
    expect(topicButtons()).toHaveLength(4);
    type("");
    expect(topicButtons()).toHaveLength(4);
  });

  it("shows one clear message when nothing matches", () => {
    render(<GuideTopicList onPick={vi.fn()} />);
    type("zeppelin");
    expect(topicButtons()).toHaveLength(0);
    expect(screen.getByText("No guides match your search.")).toBeTruthy();
  });
});
