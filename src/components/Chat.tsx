import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, PanelRightClose, X } from "lucide-react";
import { useApp, useStatus } from "@/store";
import { loanInContext } from "@/lib/threads";
import { greetingText, starterChips } from "@/lib/blocks";
import { maxCashSafe } from "@/lib/cash-plan";
import { PRICES } from "@/data";
import { DEFAULT_LEVELS } from "@/lib/loan-math";
import { AlertCard, ProposalCard, ReserveActionCard } from "@/components/ChatCards";
import { Block } from "@/components/blocks/Block";
import { Button } from "@/components/ui/button";
import { AddAgentButton, ReserveStatusChip } from "@/components/common";
import { agentStatusLine, requiredSignatures } from "@/lib/loan-copy";
import { reserveStatus } from "@/lib/reserve";
import { networksLabel } from "@/lib/networks";

/** The live status line under the agent's name. */
export function AgentStatus() {
  const { loans, proposerActive, safe } = useApp();
  const agentNets = safe.networks.filter((n) => n.agent).map((n) => n.id);
  const status = useStatus();
  return (
    <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
      <span className={`size-1.5 shrink-0 rounded-full ${proposerActive ? "bg-success" : "bg-muted-foreground"}`} />
      {agentStatusLine(proposerActive, loans.map(status))}{agentNets.length > 0 && ` · on ${networksLabel(agentNets)}`}
    </div>
  );
}

/** The per-Safe message list and composer, shared by the side panel and the Ask the agent view. Render inside a flex column. */
export function ChatThread({ chips = [], placeholder, greeting }: { chips?: string[]; placeholder: string; greeting?: boolean }) {
  const { messages, typing, send, loans, proposerActive, ctxLoanId, safe, focus } = useApp();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const ctx = loanInContext(loans, safe.id, ctxLoanId);
  const [flash, setFlash] = useState<string | null>(null);
  const max = maxCashSafe(safe, PRICES, DEFAULT_LEVELS.warn);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, typing]);

  // Scroll to the card the "Fix with agent" or "Review fix" button asked for (ignore a stale request on mount).
  useEffect(() => {
    if (!focus || Date.now() - focus.at >= 3000) return;
    const el = document.getElementById("msg-" + focus.id);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    setFlash(focus.id);
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [focus]);
  const ring = (id: string) => (flash === id ? "rounded-xl ring-2 ring-foreground/40 transition-shadow" : "");

  const submit = (v: string) => {
    send(v);
    setText("");
  };

  return (
    <>
      <div key={safe.id} role="log" aria-label="Conversation with Lender agent" className="rk-scroll @container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {ctx && <span className="self-center rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">About {ctx.venue} loan</span>}
        {greeting && !messages.some((m) => m.role === "user") && proposerActive && (
          <div className="flex w-full @xl:max-w-[80%] flex-col gap-2">
            <p className="text-sm">{greetingText(safe.name, requiredSignatures(safe.threshold), max)}</p>
            <Block block={{ kind: "suggestions", items: starterChips(max) }} />
          </div>
        )}
        {messages.map((m) => {
          if (m.role === "user") return <div key={m.id} className="max-w-[85%] self-end rounded-2xl bg-chat-user px-3.5 py-2 text-sm text-chat-user-foreground">{m.text}</div>;
          if (m.role === "agent") return <p key={m.id} className="w-full @xl:max-w-[80%] text-sm">{m.text}</p>;
          if (m.role === "alert") return <div key={m.id} id={"msg-" + m.id} className={cn("w-full @xl:max-w-[80%]", ring(m.id))}><AlertCard m={m} /></div>;
          if (m.role === "reserve") return <div key={m.id} className="w-full @xl:max-w-[80%]"><ReserveActionCard m={m} /></div>;
          if (m.role === "proposal") return <div key={m.id} id={"msg-" + m.id} className={cn("w-full @xl:max-w-[80%]", ring(m.id))}><ProposalCard id={m.proposalId} /></div>;
          if (m.role === "ui") return (
            <div key={m.id} className="flex w-full @xl:max-w-[80%] flex-col gap-2">
              {m.text && <p className="text-sm">{m.text}</p>}
              <Block block={m.block} msgId={m.id} />
            </div>
          );
          return null;
        })}
        {typing && (
          <div className="flex gap-1 py-2">
            <span className="sr-only">Lender agent is typing</span>
            {[0, 1, 2].map((i) => <span key={i} aria-hidden className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 150}ms` }} />)}
          </div>
        )}
        <div ref={end} />
      </div>

      {!proposerActive ? (
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
          <p className="text-sm text-muted-foreground">The Lender agent is not on this Safe.</p>
          <AddAgentButton size="sm" />
        </div>
      ) : (
      <div className="flex flex-col gap-2 p-3">
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button key={c} onClick={() => submit(c)} className="rounded-full bg-muted px-2.5 py-1 pointer-coarse:min-h-11 pointer-coarse:px-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{c}</button>
            ))}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); submit(text); }} className="flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pr-1.5 pl-4 focus-within:ring-2 focus-within:ring-ring">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 self-stretch bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          />
          <Button type="submit" size="icon" className="rounded-full" aria-label="Send" disabled={!text.trim()}><ArrowUp /></Button>
        </form>
      </div>
      )}
    </>
  );
}

export function Chat({ onClose }: { onClose: () => void }) {
  const { loans, ctxLoanId, safe, reserveLinked, policy } = useApp();
  const st = reserveStatus(policy, Date.now());
  const ctx = loanInContext(loans, safe.id, ctxLoanId);
  const max = maxCashSafe(safe, PRICES, DEFAULT_LEVELS.warn);
  const chips = ctx ? ["Refinance this loan", "Close this loan"] : starterChips(max).filter((c) => c !== "Compare lenders");

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background"><Bot className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium">Lender agent</span>
            {reserveLinked && <span className="max-sm:hidden"><ReserveStatusChip s={st} text={st.kind === "armed" ? "Can use reserve" : `Reserve ${st.label.toLowerCase()}`} /></span>}
          </div>
          <AgentStatus />
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close chat">
          <PanelRightClose className="max-lg:hidden" />
          <X className="lg:hidden" />
        </Button>
      </div>
      <ChatThread chips={chips} placeholder="Message Lender agent" />
    </div>
  );
}
