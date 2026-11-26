"use client";
import { Bot, PanelRightClose, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { AgentStatus, ChatBody } from "@/components/chat/ChatView";
import { SafeLine } from "@/components/chat/SafeLine";
import { useMedia } from "@/components/shell/AppShell";
import { safePaths } from "@/components/shell/Sidebar";
import { Button } from "@/components/ui/button";

/** The docked chat (side panel at 1100px and wider, a sheet below). */
export function ChatPanel({ address, onClose }: { address: string; onClose: () => void }) {
  // Docked beside the page at 1100px and wider (AppShell's own breakpoint); a sheet below.
  const docked = useMedia("(min-width: 1100px)");
  const pathname = usePathname() ?? "";
  const contextualHelpOnly = docked && pathname.toLowerCase() === safePaths(address).getCash.toLowerCase();
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background"><Bot className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium">Lender agent</span>
          <AgentStatus />
          <SafeLine />
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close chat">
          <PanelRightClose className="max-lg:hidden" />
          <X className="lg:hidden" />
        </Button>
      </div>
      <ChatBody address={address} placeholder="Message Lender agent" placement={docked ? "dock" : "sheet"} contextualHelpOnly={contextualHelpOnly} />
    </div>
  );
}
