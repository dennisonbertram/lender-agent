// How long a move quote is good for (D-13, M0-7). LI.FI documents no window for EVM calldata and the route is its choice, so
// the default is 15 minutes after the quote. No route is given longer.
export const MOVE_QUOTE_TTL_MS = 15 * 60_000;

/** Every route is capped at the default (D-13, the owner's choice): no route is given longer, though M0-7 measured Across at about 55 minutes. */
const ROUTE_MAX_MS: Record<string, number> = {};

export function moveExpiry(quotedAt: number, tool: string): Date {
  return new Date(quotedAt + Math.min(MOVE_QUOTE_TTL_MS, ROUTE_MAX_MS[tool] ?? MOVE_QUOTE_TTL_MS));
}

export const isMoveStale = (expiresAt: Date, now: Date): boolean => now.getTime() >= expiresAt.getTime();

/** The card's sentence once the quote ran out. */
export const OUT_OF_DATE_LINE = "Out of date: the quote for this move ran out. It is no longer in your Safe queue. Here is a fresh one.";
