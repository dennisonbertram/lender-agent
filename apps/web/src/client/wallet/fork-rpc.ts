// The fork-mode RPC the browser may use: the local anvil only, never in production, never a remote node.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
let warned = false;

/** `NEXT_PUBLIC_FORK_RPC_URL` when it is a localhost URL outside production, else null (and one console.error if it was set but rejected). */
export function forkRpcUrl(raw: string | undefined = process.env.NEXT_PUBLIC_FORK_RPC_URL, nodeEnv: string | undefined = process.env.NODE_ENV): string | null {
  if (!raw) return null;
  let ok = false;
  try { ok = nodeEnv !== "production" && LOCAL_HOSTS.has(new URL(raw).hostname); } catch { /* not a URL */ }
  if (ok) return raw;
  if (!warned) { warned = true; console.error("NEXT_PUBLIC_FORK_RPC_URL ignored: fork mode needs a localhost URL and is never used in production."); }
  return null;
}

/** Test hook: allow the one-time warning again. */
export const resetForkRpcWarning = () => { warned = false; };
