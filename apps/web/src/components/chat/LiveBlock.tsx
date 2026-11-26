"use client";
// Renders one agent block with live figures fetched from the server (blocks carry parameters, not
// figures: architecture section 6). STUB from the coordinator: the BP-09/BP-11 worker replaces the
// body; keep the exported name and props. The plan kind is delegated to `LivePlanBlock` (BP-12).
import type { UIBlock } from "@/lib/blocks";
import { SuggestionsBlock } from "@/components/blocks/SuggestionsBlock";
import { LiveFixCard } from "@/components/fixes/LiveFix";
import { LiveAddFunds, LiveExplain, LiveHoldings, LiveStatus } from "./live/LiveFigures";
import { LiveCompare, LiveWhatIf } from "./live/LiveCompareWhatIf";
import { LivePlanBlock } from "./LivePlanBlock";

export type LiveBlockProps = {
  block: UIBlock;
  safeAddress: string;
  /** Message id of the chat message that holds this block (OC-04: older plan cards read "Earlier plan"). */
  messageId?: string;
  /** Send a chat message (chips, "Show me with numbers", …). */
  onSend: (text: string) => void;
  disabled?: boolean;
  /** A proposal card follows in the thread: a sent plan then shows only that card. */
  proposalFollows?: boolean;
  /** Post a block into the chat as a new agent message ("Use" on a compare row posts a plan block). */
  onPostBlock?: (block: UIBlock) => void;
};

export function LiveBlock(props: LiveBlockProps) {
  if (props.block.kind === "plan") return <LivePlanBlock {...props} block={props.block} />;
  const { block, safeAddress, onSend, disabled, onPostBlock } = props;
  switch (block.kind) {
    case "explain": return <LiveExplain block={block} safeAddress={safeAddress} onSend={onSend} />;
    case "status": return <LiveStatus safeAddress={safeAddress} onSend={onSend} />;
    case "fix": return <LiveFixCard address={safeAddress} loanId={block.loanId} />;
    case "holdings": return <LiveHoldings safeAddress={safeAddress} onSend={onSend} onPostBlock={onPostBlock} />;
    case "addfunds": return <LiveAddFunds safeAddress={safeAddress} />;
    case "suggestions": return <SuggestionsBlock block={block} disabled={disabled} onSend={onSend} />;
    case "compare": return <LiveCompare block={block} safeAddress={safeAddress} onPostBlock={onPostBlock} disabled={disabled} />;
    case "whatif": return <LiveWhatIf block={block} safeAddress={safeAddress} />;
  }
}
