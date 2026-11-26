import type { UIBlock } from "@/lib/blocks";
import { PlanBlock } from "./PlanBlock";
import { CompareBlock } from "./CompareBlock";
import { WhatIfBlock } from "./WhatIfBlock";
import { ExplainBlock } from "./ExplainBlock";
import { StatusBlock } from "./StatusBlock";
import { HoldingsBlock } from "./HoldingsBlock";
import { SuggestionsBlock } from "./SuggestionsBlock";
import { AddFundsBlock } from "./AddFundsBlock";
import { blockCard } from "./card";

export { blockCard };

/** `msgId` is the chat message the block sits in; the plan block needs it to know whether it is the live one. */
export function Block({ block, msgId }: { block: UIBlock; msgId?: string }) {
  switch (block.kind) {
    case "plan": return <PlanBlock block={block} msgId={msgId} />;
    case "compare": return <CompareBlock block={block} />;
    case "whatif": return <WhatIfBlock block={block} />;
    case "explain": return <ExplainBlock block={block} />;
    case "status": return <StatusBlock />;
    case "holdings": return <HoldingsBlock />;
    case "addfunds": return <AddFundsBlock />;
    case "suggestions": return <SuggestionsBlock block={block} />;
  }
}
