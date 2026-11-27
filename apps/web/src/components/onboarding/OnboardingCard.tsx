import type { ReactNode } from "react";
import { GuideButton } from "@/components/guide/Guide";

/**
 * The shell every onboarding screen sits in. The default is the one narrow card shared by
 * sign-in, Safe creation and the agent step; `wide` is the authenticated Safe picker's
 * roomier workspace — full width up to a modest desktop maximum, with the page composing
 * its own header (the caller places GuideButton there).
 */
export function OnboardingCard({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  if (wide) {
    return (
      <div className="min-h-full w-full px-4 pb-10 pt-5 sm:px-6 sm:pt-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex min-h-full items-start justify-center p-4 pt-[8vh]">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">{children}<GuideButton /></div>
    </div>
  );
}
