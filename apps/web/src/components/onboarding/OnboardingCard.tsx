import type { ReactNode } from "react";
import { GuideButton } from "@/components/guide/Guide";

/**
 * The shell every onboarding screen sits in. The default is the one narrow card shared by
 * sign-in, Safe creation and the agent step; `wide` is the authenticated Safe picker's
 * full-viewport workspace — a page header (the caller's `header`, typically the progress
 * bar, plus the Guide button) over an edge-to-edge divider, then fluid content on the
 * same responsive gutters with no centered column.
 * `guide` is false while the card is only a transit state (session or Safe still loading,
 * or a redirect already on its way): the guide's open target would be a screen that is
 * about to be replaced, so the button stays hidden until the card's content is settled.
 */
export function OnboardingCard({ children, wide = false, header, guide = true }: { children: ReactNode; wide?: boolean; header?: ReactNode; guide?: boolean }) {
  if (wide) {
    return (
      <div className="flex min-h-full w-full flex-col">
        <header className="border-b border-border">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
            {header}
            {guide && <GuideButton className="ml-auto shrink-0" />}
          </div>
        </header>
        <main className="flex-1 px-4 pb-10 pt-5 sm:px-6 sm:pt-6 lg:px-8">
          <div className="flex w-full flex-col gap-5">{children}</div>
        </main>
      </div>
    );
  }
  return (
    <div className="flex min-h-full items-start justify-center p-4 pt-[8vh]">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">{children}{guide && <GuideButton />}</div>
    </div>
  );
}
