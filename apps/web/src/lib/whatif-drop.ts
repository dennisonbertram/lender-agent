/** What-if slider steps, percent. Shared by the server (one answer per step) and the router (snap a typed fall to a step). */
export const WHATIF_DROPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] as const;

/** The slider's default when no fall was asked. */
export const DEFAULT_DROP = 20;

export const MAX_DROP = 60;

/** A typed fall snapped to the 5-point grid inside 5-60 (3 -> 5, 33 -> 35, 80 -> 60). */
export const nearestDropStep = (n: number): number => Math.min(MAX_DROP, Math.max(5, Math.round(n / 5) * 5));
