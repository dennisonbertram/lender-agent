import { useApp } from "@/store";
import type { UIBlock } from "@/lib/blocks";
import { Button } from "@/components/ui/button";

export function SuggestionsBlock({ block }: { block: Extract<UIBlock, { kind: "suggestions" }> }) {
  const { send, proposerActive } = useApp();
  return (
    <div className="flex flex-wrap gap-2">
      {block.items.map((item) => <Button key={item} variant="outline" size="sm" disabled={!proposerActive} className="h-auto min-h-8 whitespace-normal text-left" onClick={() => send(item)}>{item}</Button>)}
    </div>
  );
}
