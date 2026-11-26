import { Bot } from "lucide-react";
import { AgentStatus, ChatThread } from "@/components/Chat";

/** Ask the agent: the full-screen chat, the landing screen. */
export function ChatView() {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col">
      <div className="flex items-center gap-3 border-b border-border p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background"><Bot className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">Lender agent</h1>
          <AgentStatus />
        </div>
      </div>
      <ChatThread greeting placeholder="Ask anything, or say how much you need" />
    </div>
  );
}
