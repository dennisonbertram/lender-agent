import { describe, expect, it } from "vitest";
import { nearestDropStep, WHATIF_DROPS } from "./whatif-drop";

describe("nearestDropStep", () => {
  it.each([[3, 5], [30, 30], [33, 35], [32, 30], [80, 60], [0, 5], [62, 60]])("%i -> %i", (n, step) => expect(nearestDropStep(n)).toBe(step));
  it("always lands on the grid", () => {
    for (let n = 0; n <= 100; n++) expect(WHATIF_DROPS).toContain(nearestDropStep(n));
  });
});
