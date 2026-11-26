const BASE = "http://app.invalid";
/** True for anything that is not a plain same-origin path: protocol-relative, backslash, control chars. */
const unsafe = (p: string) => !p.startsWith("/") || p.startsWith("//") || p.includes("\\") || /[\u0000-\u001f\u007f]/.test(p);

/** A path inside this app, or null. The only value ever used for ?next= after sign-in. */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512 || unsafe(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (u.origin !== BASE) return null;
  const out = u.pathname + u.search + u.hash;
  if (unsafe(out) || out === "/" || u.pathname === "/api" || u.pathname.startsWith("/api/")) return null;
  return out;
}

/** Link to the sign-in page that comes back to `path` (or plain "/" when path is not safe). */
export const signInHref = (path: string) => {
  const p = safeReturnTo(path);
  return p ? `/?next=${encodeURIComponent(p)}` : "/";
};
