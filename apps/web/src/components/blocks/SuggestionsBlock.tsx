"use client";

import type { UIBlock } from "@/lib/blocks";
import { Button } from "@/components/ui/button";

/** Suggestion chips. `disabled` while the agent cannot act (not yet a proposer). */
export function SuggestionsBlock({ block, disabled, onSend }: { block: Extract<UIBlock, { kind: "suggestions" }>; disabled?: boolean; onSend: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {block.items.map((item) => <Button key={item} variant="outline" size="sm" disabled={disabled} className="h-auto min-h-11 whitespace-normal text-left" onClick={() => onSend(item)}>{item}</Button>)}
    </div>
  );
}
