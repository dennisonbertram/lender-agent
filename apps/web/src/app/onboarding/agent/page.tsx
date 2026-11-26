import { AgentStepView } from "@/components/onboarding/AgentStepView";
import { OnboardingCard } from "@/components/onboarding/OnboardingCard";
import { Button } from "@/components/ui/button";

export default async function AgentOnboardingPage({ searchParams }: { searchParams: Promise<{ safe?: string; path?: string }> }) {
  const { safe, path } = await searchParams;
  if (!safe) {
    return (
      <OnboardingCard>
        <p className="text-sm">Lender agent is added to a Safe, so choose which Safe it should work for first.</p>
        <Button size="lg" render={<a href="/onboarding" />}>Back to your Safes</Button>
      </OnboardingCard>
    );
  }
  return <AgentStepView safeAddress={safe} createPath={path === "create"} />;
}
