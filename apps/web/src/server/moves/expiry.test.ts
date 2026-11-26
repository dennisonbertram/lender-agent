import { describe, expect, it } from "vitest";
import { isMoveStale, MOVE_QUOTE_TTL_MS, moveExpiry, OUT_OF_DATE_LINE } from "./expiry";

const quotedAt = Date.parse("2026-11-14T10:00:00Z");
const MIN = 60_000;

describe("move expiry (D-13)", () => {
  it("is 15 minutes after the quote by default", () => {
    expect(MOVE_QUOTE_TTL_MS).toBe(15 * MIN);
    expect(moveExpiry(quotedAt, "relay").getTime()).toBe(quotedAt + 15 * MIN);
    expect(moveExpiry(quotedAt, "some-new-bridge").getTime()).toBe(quotedAt + 15 * MIN);
  });
  it("never exceeds 15 minutes, whatever the route", () => {
    for (const tool of ["across", "acrossV4", "symbiosis", "relay", "stargate"]) expect(moveExpiry(quotedAt, tool).getTime()).toBeLessThanOrEqual(quotedAt + 15 * MIN);
  });
  it("is stale from the expiry on, not before", () => {
    const expiresAt = moveExpiry(quotedAt, "relay");
    expect(isMoveStale(expiresAt, new Date(quotedAt + 15 * MIN - 1))).toBe(false);
    expect(isMoveStale(expiresAt, new Date(quotedAt + 15 * MIN))).toBe(true);
  });
  it("has the card's words", () => {
    expect(OUT_OF_DATE_LINE).toBe("Out of date: the quote for this move ran out. It is no longer in your Safe queue. Here is a fresh one.");
  });
});
