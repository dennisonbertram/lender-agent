/** "just now", "4 min ago", "3 h ago" for a past time (ms since epoch) relative to `now`. */
export function timeAgo(at: number, now: number): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}
