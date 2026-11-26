import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Fact = { label: string; value: ReactNode; hint?: ReactNode };

/** Label / value pairs: two columns from 480 px up, one below. */
export function FactGrid({ facts, className }: { facts: Fact[]; className?: string }) {
  return (
    <dl data-slot="fact-grid" className={cn("grid grid-cols-1 gap-x-6 gap-y-3 min-[480px]:grid-cols-2", className)}>
      {facts.map((f) => (
        <div key={f.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{f.label}</dt>
          <dd className="text-sm font-medium">{f.value}</dd>
          {f.hint && <dd className="text-xs text-muted-foreground">{f.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}
