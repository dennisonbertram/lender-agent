"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowDown } from "lucide-react";
import type { UIMessage } from "ai";
import { Greeting } from "@/components/chat/Greeting";
import { AlertCardSlot } from "@/components/chat/AlertCard";
import { ReserveCard, type ReserveCardData } from "@/components/reserve/ReserveCard";
import { LiveBlock } from "@/components/chat/LiveBlock";
import { ProposalCardSlot, type ProposalPlacement } from "@/components/chat/ProposalCardSlot";
import { MoveCardSlot } from "@/components/moves/MoveCardSlot";
import type { UIBlock } from "@/lib/blocks";
import { safeParseBlock } from "@/server/agent/block-schema";

type Props = {
  messages: UIMessage[];
  safeAddress: string;
  onSend: (text: string) => void;
  /** The agent is answering: show the typing dots and lock the blocks' buttons. */
  typing?: boolean;
  disabled?: boolean;
  /** Append a block as a new agent message (compare "Use" posts a plan block). */
  onPostBlock?: (block: UIBlock) => void;
  /** Where the thread renders: the docked panel shows a stub for the proposal the page already shows (VC-07). */
  placement?: ProposalPlacement;
  /** On Get Cash, the docked greeting gives help without introducing a competing loan offer. */
  contextualHelpOnly?: boolean;
  /** Increments for a message or block initiated in this tab. */
  localFollowVersion?: number;
};

const bubble = "max-w-[85%] self-end rounded-2xl bg-chat-user px-3.5 py-2 text-sm text-chat-user-foreground";

/** The thread as a log (r26). Parts: text, tool results (blocks), `data-block`, `data-proposal`, `data-alert`. A tool that errored or has no result yet renders nothing. */
export function MessageList({ messages, safeAddress, onSend, typing, disabled, onPostBlock, placement, contextualHelpOnly, localFollowVersion }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const contentHeight = useRef(0);
  const logHeight = useRef(0);
  const lastId = useRef<string | undefined>(undefined);
  const lastParts = useRef<UIMessage["parts"] | undefined>(undefined);
  const lastLocalFollowVersion = useRef(localFollowVersion);
  const [unseen, setUnseen] = useState(false);
  const toEnd = () => {
    const log = box.current;
    if (log) log.scrollTop = log.scrollHeight;
    atBottom.current = true;
    setUnseen(false);
  };
  // Message changes are incoming transcript content; layout changes are handled separately below.
  useEffect(() => {
    const last = messages[messages.length - 1];
    const changed = last?.id !== lastId.current || last?.parts !== lastParts.current;
    const localFollow = localFollowVersion !== lastLocalFollowVersion.current;
    lastId.current = last?.id;
    lastParts.current = last?.parts;
    lastLocalFollowVersion.current = localFollowVersion;
    if (atBottom.current || localFollow) toEnd();
    else if (changed) setUnseen(true);
  }, [messages, typing, localFollowVersion]);
  useEffect(() => {
    const target = content.current;
    const log = box.current;
    if (!target || !log || typeof ResizeObserver === "undefined") return;
    contentHeight.current = target.scrollHeight;
    logHeight.current = log.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = target.scrollHeight;
      const nextLogHeight = log.clientHeight;
      const grew = nextHeight > contentHeight.current;
      const viewportShrank = nextLogHeight < logHeight.current;
      contentHeight.current = nextHeight;
      logHeight.current = nextLogHeight;
      if ((grew || viewportShrank) && atBottom.current) toEnd();
    });
    observer.observe(target);
    observer.observe(log);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
    if (atBottom.current) setUnseen(false);
  };
  const noteControlInteraction = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target as Element).closest("summary, [aria-expanded]")) return;
    atBottom.current = false;
    requestAnimationFrame(() => {
      const log = box.current;
      if (!log) return;
      atBottom.current = log.scrollHeight - log.scrollTop - log.clientHeight <= 80;
      if (atBottom.current) setUnseen(false);
    });
  };
  const lastAgentId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  // Index of the last message that holds a proposal card: a plan sent before it is shown by that card alone.
  const lastProposalAt = messages.reduce((n, m, i) => (m.parts.some((p) => p.type === "data-proposal") ? i : n), -1);
  const asked = messages.some((m) => m.role === "user");

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={box} onScroll={onScroll} onClickCapture={noteControlInteraction} role="log" aria-label="Conversation with Lender agent" className="rk-scroll @container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div ref={content} className="flex flex-col gap-3">
      {!asked && <div className="flex w-full @xl:max-w-[80%] flex-col gap-2"><Greeting safeAddress={safeAddress} onSend={onSend} disabled={disabled} contextualHelpOnly={contextualHelpOnly} /></div>}
      {messages.map((m, mi) => {
        if (m.role === "user") return <div key={m.id} className={bubble}>{m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</div>;
        // The lead-in of a plan that a proposal card now stands for ("Here is a plan. Change anything below.") has nothing left to introduce.
        const spent = mi < lastProposalAt && m.parts.some((p) => p.type === "data-block" && (p as { data?: { block?: { kind?: string } } }).data?.block?.kind === "plan" || p.type.startsWith("tool-") && (p as { output?: { kind?: string } }).output?.kind === "plan");
        const isChips = (p: (typeof m.parts)[number]) => {
          const out = p.type.startsWith("tool-") && (p as { state?: string }).state === "output-available" ? (p as { output?: unknown }).output : p.type === "data-block" ? (p as { data?: { block?: unknown } }).data?.block : undefined;
          return safeParseBlock(out)?.kind === "suggestions";
        };
        const lastChips = m.parts.map(isChips).lastIndexOf(true); // one set of chips per reply: keep the last
        const nodes = m.parts.flatMap((p, i) => {
          if (i < lastChips && isChips(p)) return [];
          if (p.type === "text") return spent ? [] : p.text ? [<p key={i} className="text-sm">{p.text}</p>] : [];
          if (p.type.startsWith("tool-") && (p as { state?: string }).state === "output-available") {
            const block = safeParseBlock((p as { output?: unknown }).output);
            return block && !(block.kind === "suggestions" && m.id !== lastAgentId) ? [<LiveBlock key={i} block={block} safeAddress={safeAddress} messageId={m.id} onSend={onSend} disabled={disabled} onPostBlock={onPostBlock} proposalFollows={mi < lastProposalAt} />] : [];
          }
          if (p.type === "data-block") {
            const block = safeParseBlock((p as { data?: { block?: unknown } }).data?.block);
            return block && !(block.kind === "suggestions" && m.id !== lastAgentId) ? [<LiveBlock key={i} block={block} safeAddress={safeAddress} messageId={m.id} onSend={onSend} disabled={disabled} onPostBlock={onPostBlock} proposalFollows={mi < lastProposalAt} />] : [];
          }
          if (p.type === "data-proposal") {
            const proposalId = (p as { data?: { proposalId?: string } }).data?.proposalId;
            return proposalId ? [<ProposalCardSlot key={i} safeAddress={safeAddress} proposalId={proposalId} placement={placement} />] : [];
          }
          if (p.type === "data-move") {
            const moveId = (p as { data?: { moveId?: string } }).data?.moveId;
            return moveId ? [<MoveCardSlot key={i} safeAddress={safeAddress} moveId={moveId} />] : [];
          }
          if (p.type === "data-alert") {
            const { text, alertId } = (p as { data?: { text?: string; alertId?: number } }).data ?? {};
            if (typeof alertId === "number") return [<AlertCardSlot key={i} safeAddress={safeAddress} alertId={alertId} text={text} />];
            return text ? [<p key={i} className="text-sm">{text}</p>] : [];
          }
          if (p.type === "data-reserve") {
            const data = (p as { data?: ReserveCardData }).data;
            return data ? [<ReserveCard key={i} data={data} />] : [];
          }
          return [];
        });
        if (nodes.length === 0) return null;
        return <div key={m.id} id={`msg-${m.id}`} className="flex w-full @xl:max-w-[80%] flex-col gap-2 empty:hidden">{nodes}</div>;
      })}
      {typing && (
        <div className="flex gap-1 py-2">
          <span className="sr-only">Lender agent is typing</span>
          {[0, 1, 2].map((i) => <span key={i} aria-hidden className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 150}ms` }} />)}
        </div>
      )}
      </div>
    </div>
    {unseen && (
      <button type="button" onClick={toEnd} className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-md hover:bg-muted">
        New messages <ArrowDown className="size-3" aria-hidden />
      </button>
    )}
    </div>
  );
}
