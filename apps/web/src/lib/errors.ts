import { ApiError } from "@/client/http";
import { signInHref } from "@/lib/return-to";

export type ErrorPlace = "loan" | "loans" | "proposal" | "reserve" | "activity" | "safe" | "cash";
export type ErrorKind = "signed-out" | "no-access" | "not-found" | "offline" | "server";
export type ErrorAction = { label: string; href: string } | { label: string; onClick: () => void };
export type ErrorDescription = { kind: ErrorKind; title: string; reason: string; primary: ErrorAction; secondary?: ErrorAction };

const SAFE_OK = "Nothing on your Safe has changed.";
const NOUN: Record<ErrorPlace, string> = { loan: "this loan", loans: "your loans", proposal: "this proposal", reserve: "the Reserve", activity: "the activity", safe: "this Safe", cash: "your Safe" };

/** Plain words for a failed read. `retry` powers "Try again"; `from` is the path to come back to after signing in. */
export function describeError(error: unknown, place: ErrorPlace, opts: { retry?: () => void; from?: string; backHref?: string } = {}): ErrorDescription {
  const back: ErrorAction = place === "safe"
    ? { label: "Back to your Safes", href: "/onboarding" }
    : { label: "Back to Overview", href: opts.backHref ?? "/onboarding" };
  const retry: ErrorAction = { label: "Try again", onClick: opts.retry ?? (() => window.location.reload()) };
  const status = error instanceof ApiError ? error.status : null;
  if (status === 401) {
    const from = opts.from ?? (typeof window === "undefined" ? "/" : window.location.pathname + window.location.search);
    return { kind: "signed-out", title: "Sign in to continue", reason: "You are not signed in, or your session ended. After you sign in you will come back to this page.", primary: { label: "Sign in", href: signInHref(from) } };
  }
  if (status === 403) {
    return { kind: "no-access", title: place === "safe" ? "You are not an owner of this Safe" : "This wallet is not an owner of this Safe", reason: "Sign in with a wallet that owns this Safe, or pick another one.", primary: { label: "Back to your Safes", href: "/onboarding" } };
  }
  if (status === 404 && place === "loan") {
    const activity: ErrorAction = { label: "Activity", href: opts.backHref ? `${opts.backHref}/activity` : "/onboarding" };
    return { kind: "not-found", title: "We could not find this loan", reason: "We could not find this loan. It may have been closed or repaid.", primary: activity, secondary: back };
  }
  if (status === 404) {
    const title = place === "safe" ? "We could not load this Safe" : `We could not find ${NOUN[place]}`;
    return { kind: "not-found", title, reason: place === "safe" ? "Check the address, or pick another Safe." : `The link may be old, or it was closed. ${SAFE_OK}`, primary: back };
  }
  if (status === null) {
    return { kind: "offline", title: "We could not reach the server", reason: `Check your connection. ${SAFE_OK}`, primary: retry, secondary: back };
  }
  return { kind: "server", title: place === "safe" ? "We could not load this Safe" : "Something went wrong on our side", reason: `Please try again in a moment. ${SAFE_OK}`, primary: retry, secondary: back };
}
