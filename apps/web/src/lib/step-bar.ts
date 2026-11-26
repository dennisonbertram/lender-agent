export type SegmentState = "done" | "current" | "todo";

export const segmentState = (i: number, step: number, complete: boolean): SegmentState =>
  complete || i < step ? "done" : i === step ? "current" : "todo";

const CREATE = ["Name", "Approvals", "Review", "Agent"];
const FOUND = ["Safe", "Agent"];

/** The one onboarding step bar. `null` on the Connect screen. */
export function onboardingBar({ screen, path, createStep }: { screen: "connect" | "safe" | "agent" | "done"; path: "create" | "found"; createStep: number }) {
  if (screen === "connect") return null;
  const labels = path === "create" ? CREATE : FOUND;
  const step = screen === "safe" ? (path === "create" ? createStep : 0) : labels.length - 1;
  return { labels, step, complete: screen === "done" };
}
