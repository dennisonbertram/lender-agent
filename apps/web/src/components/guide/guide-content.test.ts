import { describe, expect, it, vi } from "vitest";
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

  it.each(["/s/0xabc#details", "/s/0xabc?tab=loans#details", "/s/0xabc#details?tab=loans"])(
    "strips the hash and query suffix of %s in either order",
    (path) => {
      expect(topicForPath(path)?.id).toBe("overview");
    },
  );

  it("keeps the root topic when only a suffix or slashes remain", () => {
    expect(topicForPath("/?safe=0xabc")?.id).toBe("welcome");
    expect(topicForPath("/#top")?.id).toBe("welcome");
    expect(topicForPath("///")?.id).toBe("welcome");
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

describe("borrower safeguards in the walkthroughs", () => {
  it("explains how to handle an unwanted proposal that is still executable", () => {
    const step = guideTopics.find(t => t.id === "proposal")!.steps.at(-1)!.body;
    expect(step).toMatch(/still be executable/i);
    expect(step).toMatch(/reject an unwanted request/i);
  });

  it("shows funding instructions only for a real Safe", async () => {
    try {
      vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
      vi.resetModules();
      const { guideTopics: demo } = await import("./guide-content");
      for (const id of ["wallet", "overview", "quote", "close", "reserve", "networks"]) {
        const steps = demo.find(t => t.id === id)!.steps.map(step => step.body).join(" ");
        expect(steps, id).toContain("Never send real money to a demo Safe");
        expect(steps, id).not.toMatch(/copy your Safe address|top up the Reserve Safe with USDC/i);
      }
      vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "");
      vi.resetModules();
      const { guideTopics: live } = await import("./guide-content");
      const wallet = live.find(t => t.id === "wallet")!;
      expect(wallet.steps.at(-1)!.body).toContain("copy your Safe address");
      expect(wallet.steps.some(step => step.body.includes("demo Safe"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("distinguishes stopping reserve use from removing its spending permission", () => {
    const reserve = guideTopics.find(t => t.id === "reserve")!.steps.map(s => s.body).join(" ");
    expect(reserve).toContain("stops the app from using the reserve immediately");
    expect(reserve).toContain("permission remains until the owners execute the removal");
    expect(reserve).toContain("an owner of both Safes");
  });

  it("does not promise a failed agent add changed nothing, and sends the owner to check its status", () => {
    const agent = guideTopics.find(t => t.id === "agent")!.steps.map(s => s.body).join(" ");
    expect(agent).not.toMatch(/nothing was changed/i);
    expect(agent).toMatch(/check the agent.s status/i);
  });

  it("does not claim Add Base or Add a network deploys the Safe", () => {
    for (const id of ["agent", "networks"]) {
      const text = guideTopics.find(t => t.id === id)!.steps.map(s => s.body).join(" ");
      expect(text, id).toMatch(/does not deploy the Safe/i);
    }
  });

  it("points chat recovery at ownership on every tracked lending network, not the agent", () => {
    const chat = guideTopics.find(t => t.id === "chat")!.steps.map(s => s.body).join(" ");
    expect(chat).toMatch(/owns this Safe on every tracked lending network/i);
    expect(chat).toMatch(/read the thread/i);
  });

  it("does not assume controls are on screen that the app can hide", () => {
    const text = (id: string) => guideTopics.find(t => t.id === id)!.steps.map(s => s.body).join(" ");
    // No amount field on a failed read or underfunded Safe.
    expect(text("quote")).toMatch(/no amount field/i);
    // Repay/close render only for a watched, single-collateral loan with a confirmed debt.
    expect(text("repay")).toMatch(/watched loan with a single collateral asset and a confirmed debt/i);
    expect(text("close")).toMatch(/watched loan with a single collateral asset and a confirmed debt/i);
    // Status-only activity rows have no link, and the Reserve link can move to the sidebar.
    expect(text("activity")).not.toMatch(/each row links|every row links/i);
    expect(text("settings")).toMatch(/Reserve link moves to the sidebar/i);
  });
});
