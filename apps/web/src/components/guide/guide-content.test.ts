import { describe, expect, it } from "vitest";
import { guideTopics, topicForPath } from "./guide-content";

// The `data-guide-target` names the UI can mark: a step's `target` may only be one of these.
const KNOWN_TARGETS = new Set([
  "sign-in",
  "choose-safe",
  "create-safe",
  "agent-permissions",
  "overview-balances",
  "quote-amount",
  "quote-review",
  "proposal-review",
  "loan-summary",
  "loan-repay",
  "loan-close",
  "activity-list",
  "reserve-protection",
  "settings-email",
  "settings-networks",
  "settings-nickname",
  "chat-compose",
  "wallet-menu",
]);

// Topic ids other parts of the feature rely on.
const REQUIRED_IDS = [
  "welcome",
  "choose-safe",
  "create-safe",
  "agent",
  "overview",
  "quote",
  "proposal",
  "loan",
  "repay",
  "close",
  "activity",
  "reserve",
  "alerts",
  "settings",
  "chat",
  "wallet",
  "networks",
  "nickname",
] as const;

describe("topicForPath", () => {
  it.each([
    ["/", "welcome"],
    ["/onboarding", "choose-safe"],
    ["/onboarding/agent", "agent"],
    ["/s/0x0000000000000000000000000000000000000001", "overview"],
    ["/s/0x0000000000000000000000000000000000000001/get-cash", "quote"],
    ["/s/0x0000000000000000000000000000000000000001/chat", "chat"],
    ["/s/0x0000000000000000000000000000000000000001/activity", "activity"],
    ["/s/0x0000000000000000000000000000000000000001/reserve", "reserve"],
    ["/s/0x0000000000000000000000000000000000000001/settings", "settings"],
    ["/s/0x0000000000000000000000000000000000000001/loans/some-loan", "loan"],
    ["/s/0x0000000000000000000000000000000000000001/proposals/prop-1", "proposal"],
  ])("maps %s to the %s topic", (path, id) => {
    const topic = topicForPath(path);
    expect(topic?.id).toBe(id);
    expect(guideTopics).toContain(topic);
  });

  it("matches encoded dynamic segments", () => {
    expect(topicForPath("/s/0xabc/loans/8453%3A0xabc%3Aaave-v3")?.id).toBe("loan");
  });

  it("ignores query strings and trailing slashes", () => {
    expect(topicForPath("/onboarding/agent?safe=0xabc&path=create")?.id).toBe("agent");
    expect(topicForPath("/s/0xabc/")?.id).toBe("overview");
    expect(topicForPath("/")?.id).toBe("welcome");
  });

  it.each(["/terms", "/privacy", "/s", "/s/0xabc/unknown", "/s/0xabc/loans", "/s/0xabc/proposals", "/onboarding/other", "/onboarding/agent/extra"])(
    "returns undefined for %s",
    (path) => {
      expect(topicForPath(path)).toBeUndefined();
    },
  );
});

describe("guideTopics catalog", () => {
  it("covers every required topic id exactly once", () => {
    const ids = guideTopics.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of REQUIRED_IDS) expect(ids).toContain(id);
  });

  it("gives every topic a title, summary and 2–4 short steps", () => {
    for (const topic of guideTopics) {
      expect(topic.title.trim(), topic.id).not.toBe("");
      expect(topic.summary.trim(), topic.id).not.toBe("");
      expect(topic.steps.length, topic.id).toBeGreaterThanOrEqual(2);
      expect(topic.steps.length, topic.id).toBeLessThanOrEqual(4);
      for (const step of topic.steps) {
        expect(step.title.trim(), `${topic.id} step`).not.toBe("");
        expect(step.body.trim(), `${topic.id} step`).not.toBe("");
      }
    }
  });

  it("uses only known data-guide-target names", () => {
    for (const topic of guideTopics) {
      for (const step of topic.steps) {
        if (step.target !== undefined) expect(KNOWN_TARGETS.has(step.target), `${topic.id} -> ${step.target}`).toBe(true);
      }
    }
  });

  it("reaches every data-guide-target the UI marks", () => {
    const used = new Set(guideTopics.flatMap((t) => t.steps.map((s) => s.target).filter((x): x is string => x !== undefined)));
    for (const target of KNOWN_TARGETS) expect(used.has(target), `no step targets ${target}`).toBe(true);
  });
});
