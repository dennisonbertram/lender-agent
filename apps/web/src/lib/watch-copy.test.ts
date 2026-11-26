import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstCheckLine, loanMonitorLine, pendingLoanCount, pickerLine, watchView, watchLine, watchState } from "./watch-copy";
import { timeAgo } from "./time-ago";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base = { agentOn: true, watching: false, failing: false, starting: false, loans: 1 };

describe("watchState", () => {
  it("maps the shell flags to one of five states", () => {
    expect(watchState({ ...base, agentOn: false })).toBe("off");
    expect(watchState({ ...base, watching: true })).toBe("watching");
    expect(watchState({ ...base, loans: 0 })).toBe("none");
    expect(watchState({ ...base, loans: 0, failing: true })).toBe("none");
    expect(watchState({ ...base, failing: true })).toBe("lagging");
    expect(watchState({ ...base, starting: true })).toBe("starting");
    expect(watchState({ ...base, loans: 0, starting: true })).toBe("starting");
    expect(watchState(base)).toBe("starting");
  });
});

describe("watchLine", () => {
  const i = (statuses: ("healthy" | "watch" | "risk" | "liquidatable")[] = [], lastCheckAt: string | null = null) => ({ statuses, lastCheckAt, now: NOW });
  it("lagging with a loan states the age, never 'Not watching'", () => {
    expect(watchLine("lagging", { ...i(["healthy"], null), firstCheckDue: true })).toBe("Checking your loans… first check within a minute");
    expect(watchLine("lagging", i(["healthy"], ago(4 * 60_000)))).toBe("Delayed: last check 4 min ago");
    expect(watchLine("lagging", i(["healthy"], null))).toBe("Not checked yet");
    expect(watchLine("lagging", i(["healthy"], null))).not.toMatch(/delayed/i);
    expect(watchLine("watching", i(["healthy"], ago(2 * 60_000)))).toBe("Watching 1 loan · last checked 2 min ago");
  });
  it("has one line per state", () => {
    expect(watchLine("watching", i(["healthy"]))).toBe("Watching 1 loan");
    expect(watchLine("watching", i(["healthy", "risk"]))).toBe("Watching 2 loans · 1 needs action");
    expect(watchLine("watching", i(["risk", "liquidatable"]))).toBe("Watching 2 loans · 2 need action");
    expect(watchLine("starting", i())).toBe("Getting ready. First check in about a minute.");
    expect(watchLine("off", i())).toBe("Not watching this Safe");
    expect(watchLine("none", i())).toBe("Ready. No loans to watch yet.");
    expect(watchLine("none", { ...i(), pending: 1 })).toBe("The loan hasn't opened yet. The agent starts watching once it does.");
  });
  it("lagging and starting never say Watching", () => {
    expect(watchLine("lagging", i(["healthy"], ago(1000)))).not.toMatch(/Watching/);
    expect(watchLine("starting", i())).not.toMatch(/Watching/);
  });
});

describe("pendingLoanCount", () => {
  it("only counts open-loan proposals when there are no loans to watch", () => {
    expect(pendingLoanCount([
      { final: false, specKind: "reserve-setup" },
      { final: false, specKind: "close" },
      { final: false, specKind: "open" },
      { final: true, specKind: "open" },
    ])).toBe(1);
  });
});

describe("pickerLine", () => {
  it("never says 'Agent not added' for a Safe whose agent is on", () => {
    expect(pickerLine([], true)).toBe("Agent on · no loans yet");
    expect(pickerLine(["healthy"], true)).toBe("Agent on");
    expect(pickerLine(["healthy"], false)).toBe("Agent not added");
    expect(pickerLine(["risk"], true)).toBe("1 needs action");
  });
});

describe("timeAgo", () => {
  it("steps from just now to hours", () => {
    expect(timeAgo(NOW - 30_000, NOW)).toBe("just now");
    expect(timeAgo(NOW - 60_000, NOW)).toBe("1 min ago");
    expect(timeAgo(NOW - 59 * 60_000, NOW)).toBe("59 min ago");
    expect(timeAgo(NOW - 3 * 3600_000, NOW)).toBe("3 h ago");
  });
});

describe("strings live only here", () => {
  const root = join(__dirname, "..");
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : []; });
  it("Delayed: / Can't check your loans / Agent not added appear in watch-copy only", () => {
    const hits = files(root).filter((p) => /Delayed: last check|Can't check your loans|Agent not added/.test(readFileSync(p, "utf8")));
    // loan-copy.ts (picker line) is retired by this package; SafeOverview and LoanDashboard belong to WP-4 (remove from this list there).
    expect(hits.map((p) => p.replace(root, "")).filter((p) => !["/lib/watch-copy.ts", "/lib/loan-copy.ts", "/components/overview/SafeOverview.tsx"].includes(p))).toEqual([]);
  });
});

describe("firstCheckLine", () => {
  it("is 'Not checked yet' when checks are failing and 'Getting ready' otherwise, the same for every screen", () => {
    expect(firstCheckLine(true)).toBe("Not checked yet");
    expect(firstCheckLine(false)).toBe("Getting ready. First check in about a minute.");
    expect(firstCheckLine(true)).toBe(watchView({ agentOn: true, watching: false, failing: true, statuses: ["healthy"], now: NOW }).line);
    expect(firstCheckLine(false)).toBe(watchView({ agentOn: true, watching: false, starting: true, statuses: ["healthy"], now: NOW }).line);
  });
});

describe("loanMonitorLine", () => {
  const clock = () => "14:02";
  it("says the same things as the panel", () => {
    expect(loanMonitorLine({ state: "starting", lastCheckAt: null }, NOW, clock)).toBe("Getting ready. First check in about a minute.");
    expect(loanMonitorLine({ state: "watching", lastCheckAt: ago(1000), source: "chain" }, NOW, clock)).toBe("Last checked 14:02 · chain.");
    expect(loanMonitorLine({ state: "failing", lastCheckAt: ago(5 * 60_000) }, NOW, clock)).toBe("Delayed: last check 5 min ago");
    expect(loanMonitorLine({ state: "failing", lastCheckAt: null }, NOW, clock)).not.toMatch(/delayed/i);
  });
});
