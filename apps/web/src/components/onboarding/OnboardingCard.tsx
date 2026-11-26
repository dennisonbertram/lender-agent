import type { ReactNode } from "react";

/** The one card every onboarding screen sits in: sign-in, the Safe picker and the agent step. */
export function OnboardingCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-start justify-center p-4 pt-[8vh]">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">{children}</div>
    </div>
  );
}
